// The worker entrypoint — the deployable composition root (deploy spec §2.3).
//
// Boot sequence:
//   1. validate env (DATABASE_URL required; the rest have safe defaults)
//   2. open the pg pool and apply ALL coordination DDL idempotently, in
//      dependency order: @tasca/db task slice → @tasca/identity → @tasca/coordination
//   3. wire the proven packages via createCoordination, plus the real Shortcut
//      adapter as the webhook verifier (HMAC-SHA-256). Write-back (postStatus) is
//      GATED on the Shortcut token-issuance answer, so a logging no-op is injected
//      — it must NOT throw, or every task would fail at status-back.
//   4. listen on :PORT and serve POST /webhooks/shortcut + GET /healthz
//   5. shut down gracefully on SIGTERM/SIGINT
//
// Run via tsx (the repo executes TypeScript source directly — there is no JS emit
// pipeline; CI and tests run the same way). Entry: `tsx packages/coordination/src/main.ts`.
//
// This is the ONE place the coordination package composes @tasca/adapters; the
// library surface (index.ts) stays adapter-free so inner consumers don't pull it.

import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { TASK_TABLE_DDL } from '@tasca/db';
import { IDENTITY_SCHEMA_DDL } from '@tasca/identity';
import {
  AUTH_SCHEMA_DDL,
  PgAuthRepository,
  createAuthHandler,
  parseAuthEnv,
  parseCookies,
  SESSION_COOKIE,
} from '@tasca/auth';
import { createExecution } from '@tasca/execution';
import { ShortcutAdapter, GitHubAdapter, GitHubAppClient } from '@tasca/adapters';
import { PgIdentityRepository } from '@tasca/identity';
import { parseInstallationEvent, type AdapterEvent, type VerifiedEvent } from '@tasca/contracts';
import type { TaskInput } from '@tasca/routing';
import { createCoordination } from './factory';
import { PgCoordinationStore } from './store';
import { GitHubStatusReporter, routingStatusReporter } from './github-status-reporter';
import { COORDINATION_SCHEMA_DDL } from './schema';
import type {
  StatusReporter,
  WebhookVerifier,
  RawWebhook,
  VerifiedWebhook,
  Logger,
} from './ports';
import type { RepoProvisioner, TaskContentSource } from './orchestrate';
import { GitAppRepoProvisioner } from './repo-provisioner';

/** Minimal console logger with structured context (JSON line per event). */
const logger: Logger = {
  error(message, context) {
    console.error(JSON.stringify({ level: 'error', message, ...(context ?? {}) }));
  },
  info(message, context) {
    console.log(JSON.stringify({ level: 'info', message, ...(context ?? {}) }));
  },
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    logger.error(`missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * Parse an optional numeric env var. Unset/empty → undefined (caller applies its
 * default); set-but-not-a-finite-number → fail fast, rather than letting a NaN
 * flow into the breaker/gate where `count >= NaN` is silently always false (the
 * breaker would never trip) or the listen port would throw deep in node:net.
 */
function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logger.error(`env ${name} must be a number`, { value: raw });
    process.exit(1);
  }
  return n;
}

/** Apply every coordination DDL statement once, in FK-dependency order. */
async function applySchema(pool: Pool): Promise<void> {
  const statements: readonly string[] = [
    TASK_TABLE_DDL, // the @tasca/db base task table (the CAS target) — must be first
    ...IDENTITY_SCHEMA_DDL, // agent/service_user/rbac/profile/binding/delegation/audit
    ...AUTH_SCHEMA_DDL, // human login: app_user/auth_identity/oauth_state/session (no hard FK to the above)
    ...COORDINATION_SCHEMA_DDL, // task coordination columns + routing_decision/pull_request/ledger
  ];
  for (const ddl of statements) {
    await pool.query(ddl);
  }
}

/**
 * The webhook verifier wired from the real Shortcut adapter. HMAC-SHA-256 verify
 * over the raw body; the envelope `id` is the idempotency key; parse maps
 * owner_ids.adds ∩ registered Shortcut agent-user ids → AdapterEvents, then drops
 * our own round-tripped writes (parseAndDedupe: an owner-add whose actor
 * `member_id` is the added agent itself is the agent acting, not an assignment).
 *
 * `registeredShortcutIds` is a boot-time snapshot of the active shortcut
 * identity bindings. A roster change requires a worker restart to take effect —
 * dynamic reload is a Stage-1 follow-up, deliberately out of scope here.
 */
function shortcutVerifier(secret: string, registeredShortcutIds: ReadonlySet<string>): WebhookVerifier {
  const adapter = new ShortcutAdapter({ webhookSecret: secret });
  return {
    verify(raw: RawWebhook): VerifiedWebhook | null {
      const v = adapter.verifyWebhook(raw.rawBody, raw.headers);
      if (!v.ok) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.rawBody);
      } catch {
        return null;
      }
      const id = (payload as { id?: unknown }).id;
      if (id === undefined || id === null) return null;
      // Carry the VerifiedEvent through so parse re-uses the verified raw body.
      return { platform: 'shortcut', externalEventId: String(id), payload: v };
    },
    parse(verified: VerifiedWebhook): AdapterEvent[] {
      return adapter.parseAndDedupe(verified.payload as VerifiedEvent, registeredShortcutIds);
    },
  };
}

/**
 * The webhook verifier wired from the real GitHub adapter. HMAC-SHA-256 verify
 * over the raw body (X-Hub-Signature-256, sha256= prefix); the idempotency key is
 * the `X-GitHub-Delivery` HEADER (GitHub puts no dedupe id in the body); parse
 * maps issues.assigned + issue_comment mentions ∩ registered github agent ids →
 * AdapterEvents. `registeredGitHubIds` is a boot-time snapshot of the active
 * github bindings (numeric ids for assignment + lowercased logins for mentions);
 * a roster change requires a worker restart, like the Shortcut verifier.
 */
function githubVerifier(secret: string, registeredGitHubIds: ReadonlySet<string>): WebhookVerifier {
  const adapter = new GitHubAdapter({ webhookSecret: secret });
  return {
    verify(raw: RawWebhook): VerifiedWebhook | null {
      const v = adapter.verifyWebhook(raw.rawBody, raw.headers);
      if (!v.ok) return null;
      // GitHub's per-delivery id is a header, not a body field.
      const delivery = raw.headers['x-github-delivery'] ?? raw.headers['X-GitHub-Delivery'];
      if (!delivery) return null;
      return { platform: 'github', externalEventId: String(delivery), payload: v };
    },
    parse(verified: VerifiedWebhook): AdapterEvent[] {
      return adapter.parseEvent(verified.payload as VerifiedEvent, registeredGitHubIds);
    },
  };
}

/** A verifier that rejects everything — used until a platform's secret is set. */
function rejectAllVerifier(): WebhookVerifier {
  return {
    verify() {
      return null;
    },
    parse() {
      return [];
    },
  };
}

/**
 * GATED status-back. Real write-back under each agent's native Shortcut identity
 * depends on the token-issuance model (Tasca-Shortcut-Kickoff-Brief item 2). Until
 * then this logs the intended update and returns — it must never throw, or the
 * orchestration loop would treat every task as failed at the status-back step.
 */
const gatedStatusReporter: StatusReporter = {
  async postStatus(update) {
    logger.info?.('status-back suppressed (write-back gated on Shortcut item 2)', {
      agentId: update.agentId,
      externalStoryId: update.externalStoryId,
      state: update.state,
      prUrl: update.prUrl,
    });
  },
};

/**
 * Minimal task content for tier estimation. A real story fetch needs a Shortcut
 * read client + token (tracked separately); until then derive a real (not seeded)
 * TaskInput from the event itself — the story id is the genuine identifier.
 */
const eventContentSource: TaskContentSource = {
  async fetch(event): Promise<TaskInput> {
    return { title: event.externalStoryId, body: '' };
  },
};

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const port = numericEnv('PORT') ?? 8080;
  const webhookSecret = process.env.SHORTCUT_WEBHOOK_SECRET ?? '';
  const githubSecret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  const githubAppId = process.env.GITHUB_APP_ID ?? '';
  const githubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
  const dbFile = process.env.EMDASH_DB_FILE;
  const breakerThreshold = numericEnv('TASCA_BREAKER_THRESHOLD');
  const perProjectLimit = numericEnv('TASCA_PER_PROJECT_LIMIT');

  const pool = new Pool({ connectionString: databaseUrl });

  // Fail fast if the DB is unreachable or the schema can't be applied — a half-up
  // worker that can't persist is worse than one that exits and lets Coolify retry.
  await applySchema(pool);
  logger.info?.('coordination schema applied');

  // Boot-time roster snapshots (see shortcutVerifier doc for the reload caveat).
  const agentRows = await pool.query<{ id: string }>(
    `SELECT id FROM agent WHERE status = 'active'`
  );
  const agentIds = agentRows.rows.map((r) => r.id);
  const bindingRows = await pool.query<{ external_id: string }>(
    `SELECT external_id FROM identity_binding WHERE platform = 'shortcut' AND state = 'active'`
  );
  const registeredShortcutIds = new Set(bindingRows.rows.map((r) => r.external_id));

  // GitHub bindings: external_id (numeric user id, for assignment) + external_handle
  // (login, lowercased, for @-mentions) both go in the registered set parseEvent matches.
  const githubBindingRows = await pool.query<{ external_id: string; external_handle: string | null }>(
    `SELECT external_id, external_handle FROM identity_binding WHERE platform = 'github' AND state = 'active'`
  );
  const registeredGitHubIds = new Set<string>();
  for (const r of githubBindingRows.rows) {
    registeredGitHubIds.add(r.external_id);
    if (r.external_handle) registeredGitHubIds.add(r.external_handle.toLowerCase());
  }

  const verifier = webhookSecret
    ? shortcutVerifier(webhookSecret, registeredShortcutIds)
    : rejectAllVerifier();
  if (!webhookSecret) {
    logger.error('SHORTCUT_WEBHOOK_SECRET unset — /webhooks/shortcut will 401 until it is configured');
  }

  // GitHub verifier is optional: absent secret → the /webhooks/github route 404s
  // (flags OFF until configured), it does not reject-all on the shortcut path.
  const ghVerifier = githubSecret ? githubVerifier(githubSecret, registeredGitHubIds) : undefined;
  if (!githubSecret) {
    logger.info?.('GITHUB_WEBHOOK_SECRET unset — /webhooks/github disabled');
  }

  // GitHub write-back. Feature flag OFF by default: only when the App id AND the
  // App private key AND the webhook secret are ALL set do we construct the App
  // client + an App-configured GitHubAdapter + the GitHub status reporter + the
  // install handler, and route github status-back to it. Otherwise the existing
  // gated no-op stays injected (no-op write-back) — github intake still works.
  const githubWritebackEnabled = Boolean(githubAppId && githubAppPrivateKey && githubSecret);
  let statusReporter: StatusReporter = gatedStatusReporter;
  let githubInstallationHandler: ((rawBody: string) => Promise<void>) | undefined;
  let provisioner: RepoProvisioner | undefined;
  if (githubWritebackEnabled) {
    const store = new PgCoordinationStore(pool);
    const identity = new PgIdentityRepository(pool);
    const appClient = new GitHubAppClient({
      appId: githubAppId,
      privateKey: githubAppPrivateKey,
    });
    const writebackAdapter = new GitHubAdapter({ webhookSecret: githubSecret, appClient });
    const githubReporter = new GitHubStatusReporter({
      store,
      identity: {
        getBinding: (agentId) => identity.getBinding(agentId, 'github'),
        getDelegation: (agentId) => identity.getDelegation(agentId),
      },
      github: writebackAdapter,
      logger,
    });
    statusReporter = routingStatusReporter({ github: githubReporter, fallback: gatedStatusReporter });
    // The install webhook records the account→installation mapping write-back resolves.
    githubInstallationHandler = async (rawBody: string) => {
      const mapping = parseInstallationEvent(rawBody);
      if (!mapping) return;
      await store.upsertGitHubInstallation({
        workspaceId: mapping.accountLogin,
        installationId: mapping.installationId,
      });
      logger.info?.('github installation recorded', {
        account: mapping.accountLogin,
        installationId: mapping.installationId,
      });
    };
    logger.info?.('github write-back enabled (App env present)');

    // Clone-on-dispatch: a github event's repoHint is an `owner/repo` slug, not a
    // local path. The provisioner mints an installation token (via appClient + the
    // install→owner mapping in store) and clones/fetches into reposDir so
    // reserveWorktree has a real local repo. Only wired with App env present.
    // The clone's origin holds a (short-lived) installation token in .git/config —
    // the provisioner creates reposDir mode 0700, but in production set
    // TASCA_REPOS_DIR to a dedicated private volume, not the shared tmp root.
    const reposDir = process.env.TASCA_REPOS_DIR ?? path.join(os.tmpdir(), 'tasca-repos');
    provisioner = new GitAppRepoProvisioner({ appClient, store, reposDir });
    logger.info?.('repo provisioning enabled', { reposDir });
  } else {
    logger.info?.('github write-back disabled (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET unset)');
  }

  // Human OAuth login (GitHub + Google). Feature flag OFF by default: only when
  // ALL 5 OAuth env vars are present do we construct the repo + handler and start
  // the expiry sweep. Absent → the /api/auth/* routes 404 (handler stays undefined).
  const authEnv = parseAuthEnv();
  let authHandler: ReturnType<typeof createAuthHandler> | undefined;
  let authSweep: ReturnType<typeof setInterval> | undefined;
  // Session verifier for the read API: resolves the session cookie to a userId so
  // /api/* read endpoints enforce a real login. Only wired when auth is enabled;
  // when unset, read-api fails closed in production (503) and is open in dev.
  let verifySession: ((req: IncomingMessage) => Promise<{ userId: string } | null>) | undefined;
  if (authEnv) {
    const authRepo = new PgAuthRepository(pool);
    verifySession = async (req) => {
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!sid) return null;
      const session = await authRepo.getSession(sid);
      return session ? { userId: session.user.id } : null;
    };
    authHandler = createAuthHandler({
      repo: authRepo,
      redirectBase: authEnv.OAUTH_REDIRECT_BASE,
      clientIds: { github: authEnv.GITHUB_OAUTH_CLIENT_ID, google: authEnv.GOOGLE_OAUTH_CLIENT_ID },
      clientSecrets: { github: authEnv.GITHUB_OAUTH_CLIENT_SECRET, google: authEnv.GOOGLE_OAUTH_CLIENT_SECRET },
    });
    // Hourly sweep of expired sessions + oauth-state rows. unref() so it never
    // holds the process open during shutdown.
    authSweep = setInterval(() => {
      void authRepo.deleteExpired().catch((err) =>
        logger.error('auth expiry sweep failed', { err: err instanceof Error ? err.message : String(err) })
      );
    }, 3_600_000);
    authSweep.unref();
    logger.info?.('auth enabled (OAuth env present)');
  } else {
    logger.info?.('auth disabled (OAuth env unset)');
  }

  const execution = createExecution(dbFile ? { dbFile } : {});
  // Ready the execution-local store (migrates the SQLite). Guarded, not fatal:
  // intake + routing don't touch execution, and nothing dispatches until an agent
  // is registered — so a vendor/native load problem should degrade execution and
  // be loudly logged, not take /healthz down and block the rollout. A real
  // dispatch would then surface the failure through the breaker.
  try {
    await execution.initDb();
    logger.info?.('execution store ready');
  } catch (err) {
    logger.error('execution store init failed — dispatch will fail until resolved', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const coordination = createCoordination({
    pool,
    execution,
    status: statusReporter,
    verifier,
    content: eventContentSource,
    agentIds,
    logger,
    ...(ghVerifier ? { githubVerifier: ghVerifier } : {}),
    ...(githubInstallationHandler ? { githubInstallationHandler } : {}),
    ...(provisioner ? { provisioner } : {}),
    ...(authHandler ? { authHandler } : {}),
    ...(verifySession ? { verifySession } : {}),
    ...(breakerThreshold !== undefined ? { breakerThreshold } : {}),
    ...(perProjectLimit !== undefined ? { perProjectLimit } : {}),
  });

  const server = coordination.createServer();
  server.listen(port, () => {
    logger.info?.('coordination worker listening', {
      port,
      agents: agentIds.length,
      shortcutBindings: registeredShortcutIds.size,
      githubBindings: githubBindingRows.rows.length,
      github: ghVerifier ? 'verifying' : 'disabled (no secret)',
      githubWriteback: githubWritebackEnabled ? 'enabled' : 'disabled',
      webhooks: webhookSecret ? 'verifying' : 'rejecting (no secret)',
      auth: authHandler ? 'enabled' : 'disabled',
    });
  });

  // Last-resort host guards (the server + post-ack work handle their own errors;
  // these catch anything that still escapes, log it, and let the platform decide).
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info?.('shutting down', { signal });
    if (authSweep) clearInterval(authSweep);
    server.close(() => {
      void Promise.allSettled([pool.end(), execution.close()]).then(() => process.exit(0));
    });
    // Hard cap so a hung connection can't block the rollout forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('worker failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
