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
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
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
import { GitHubAdapter, GitHubAppClient } from '@tasca/adapters';
import { serveBroker, type BrokerServerHandle } from '@tasca/broker';
import { makeRepoTokenMinter } from './broker-minter';
import { PgIdentityRepository } from '@tasca/identity';
import { parseInstallationEvent } from '@tasca/contracts';
import type { TaskInput } from '@tasca/routing';
import { createCoordination } from './factory';
import { PgCoordinationStore } from './store';
import { GitHubStatusReporter, routingStatusReporter } from './github-status-reporter';
import { COORDINATION_SCHEMA_DDL } from './schema';
import type { StatusReporter, WebhookVerifier, Logger } from './ports';
import type { RepoProvisioner, TaskContentSource } from './orchestrate';
import { GitAppRepoProvisioner } from './repo-provisioner';
import { makeGitHubContentSource } from './github-content-source';
import { shortcutVerifier } from './shortcut-verifier';
import { githubVerifier } from './github-verifier';

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
    DISPATCH_JOB_DDL, // the coordination→execution dispatch queue (split dispatch)
    ...IDENTITY_SCHEMA_DDL, // agent/service_user/rbac/profile/binding/delegation/audit
    ...AUTH_SCHEMA_DDL, // human login: app_user/auth_identity/oauth_state/session (no hard FK to the above)
    ...COORDINATION_SCHEMA_DDL, // task coordination columns + routing_decision/pull_request/ledger
  ];
  for (const ddl of statements) {
    await pool.query(ddl);
  }
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
  const agentTimeoutMs = numericEnv('TASCA_AGENT_TIMEOUT_MS');

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
  const ghVerifier = githubSecret ? githubVerifier(githubSecret, registeredGitHubIds, logger) : undefined;
  if (!githubSecret) {
    logger.info?.('GITHUB_WEBHOOK_SECRET unset — /webhooks/github disabled');
  }

  // GitHub write-back. Feature flag OFF by default: only when the App id AND the
  // App private key AND the webhook secret are ALL set do we construct the App
  // client + an App-configured GitHubAdapter + the GitHub status reporter + the
  // install handler, and route github status-back to it. Otherwise the existing
  // gated no-op stays injected (no-op write-back) — github intake still works.
  let githubWritebackEnabled = Boolean(githubAppId && githubAppPrivateKey && githubSecret);
  // Presence != usable: decode-check the App key up front (offline) so a mangled PEM
  // disables write-back + clone-on-dispatch LOUDLY at boot, instead of failing as a
  // cryptic OpenSSL `DECODER routines::unsupported` at the first dispatch.
  if (githubWritebackEnabled) {
    try {
      new GitHubAppClient({ appId: githubAppId, privateKey: githubAppPrivateKey }).validateSigningKey();
    } catch (err) {
      logger.error(
        'github write-back + clone-on-dispatch DISABLED — App private key failed to decode ' +
          '(fix GITHUB_APP_PRIVATE_KEY: use real newlines, or base64-encode the whole PEM)',
        { err: err instanceof Error ? err.message : String(err) }
      );
      githubWritebackEnabled = false;
    }
  }
  let statusReporter: StatusReporter = gatedStatusReporter;
  let githubInstallationHandler: ((rawBody: string) => Promise<void>) | undefined;
  let provisioner: RepoProvisioner | undefined;
  // The credential broker server (worker side) — serves per-task scoped tokens to the
  // agent-runner over a unix socket, keeping the App master key in this process.
  let brokerHandle: BrokerServerHandle | undefined;
  // Default content source derives a TaskInput from the event id; with the App
  // env present we fetch the REAL issue title/body for github events (so the
  // agent prompt is the actual story), delegating non-github to the default.
  let content: TaskContentSource = eventContentSource;
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
    // install→owner mapping in store) and clones/fetches into reposDir so it has a
    // real local repo to take the task worktree from. Only wired with App env
    // present. The token is supplied per-invocation via env-auth — it is NOT
    // persisted into .git/config, so the agent's worktree carries no readable
    // credential. The provisioner creates reposDir mode 0700; in production set
    // TASCA_REPOS_DIR to a dedicated private volume, not the shared tmp root.
    const reposDir = process.env.TASCA_REPOS_DIR ?? path.join(os.tmpdir(), 'tasca-repos');
    provisioner = new GitAppRepoProvisioner({ appClient, store, reposDir });
    logger.info?.('repo provisioning enabled', { reposDir });

    // Real issue content for the agent prompt (github events): fetch title/body
    // via the installation token; non-github events fall back to the id-derived source.
    content = makeGitHubContentSource({
      appClient,
      getInstallationIdForOwner: (owner) => store.getInstallationIdForOwner(owner),
      fallback: eventContentSource,
    });

    // Serve the credential broker for the agent-runner — gated on TASCA_BROKER_SOCKET
    // (the deploy mounts a shared volume + restricts the socket's perms). The injected
    // minter resolves a task's owner→installation and mints a token scoped to JUST
    // that one repo; the App master key never leaves this process. Absent socket →
    // not served (Stage-1 single-container in-process dispatch needs no broker).
    const brokerSocket = process.env.TASCA_BROKER_SOCKET;
    if (brokerSocket) {
      const mint = makeRepoTokenMinter({
        resolveInstallation: (owner) => store.getInstallationIdForOwner(owner),
        mintScoped: (installationId, scope) => appClient.mintScopedToken(installationId, scope),
      });
      try {
        // 0o660: the non-root runner connects via a shared group (the deploy runs the
        // worker with the runner's gid); never world-accessible. TASCA_BROKER_SOCKET_MODE
        // overrides (octal) for envs that wire perms differently.
        const socketMode = process.env.TASCA_BROKER_SOCKET_MODE
          ? parseInt(process.env.TASCA_BROKER_SOCKET_MODE, 8)
          : 0o660;
        brokerHandle = await serveBroker({ socketPath: brokerSocket, mint, logger, socketMode });
        logger.info?.('credential broker serving', { socketPath: brokerSocket });
      } catch (err) {
        // A broker that can't bind is loud but non-fatal: in-process dispatch (the
        // fallback) still works; the runner path just can't get tokens until fixed.
        logger.error('credential broker failed to start — agent-runner token minting unavailable', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
    content,
    agentIds,
    logger,
    ...(ghVerifier ? { githubVerifier: ghVerifier } : {}),
    ...(githubInstallationHandler ? { githubInstallationHandler } : {}),
    ...(provisioner ? { provisioner } : {}),
    // Split dispatch: enqueue jobs for an agent-runner, with in-process fallback.
    // OFF by default; set TASCA_DISPATCH_MODE=queue once a runner is deployed.
    ...(process.env.TASCA_DISPATCH_MODE === 'queue' ? { dispatchQueueEnabled: true } : {}),
    ...(authHandler ? { authHandler } : {}),
    ...(verifySession ? { verifySession } : {}),
    ...(breakerThreshold !== undefined ? { breakerThreshold } : {}),
    ...(perProjectLimit !== undefined ? { perProjectLimit } : {}),
    ...(agentTimeoutMs !== undefined ? { agentTimeoutMs } : {}),
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
      dispatch: coordination.reaper ? 'queue (reaper on)' : 'in-process',
    });
  });

  // The reaper finalizes runner-completed jobs + sweeps dead claims — present only when
  // split dispatch is on (TASCA_DISPATCH_MODE=queue). It writes coordination tables
  // (the runner cannot), so it lives in the worker, not the runner.
  coordination.reaper?.start();

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
      void (async () => {
        // Stop the reaper FIRST and await its in-flight tick — it owns DB work, so its
        // finalize must not race a closing pool (use-after-close). Only then tear down
        // the pool + the rest.
        await (coordination.reaper?.stop() ?? Promise.resolve());
        await Promise.allSettled([pool.end(), execution.close(), brokerHandle?.close() ?? Promise.resolve()]);
        process.exit(0);
      })();
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
