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
import { GitHubAdapter, GitHubAppClient, ShortcutAdapter } from '@tasca/adapters';
import { serveBroker, type BrokerServerHandle } from '@tasca/broker';
import { makeRepoTokenMinter } from './broker-minter';
import { PgIdentityRepository } from '@tasca/identity';
import { parseInstallationEvent } from '@tasca/contracts';
import type { TaskInput } from '@tasca/routing';
import { createCoordination } from './factory';
import { PgCoordinationStore } from './store';
import { loadMasterKey, liveVendorValidator, AgentCredentialResolver, ConnectionCredentialResolver } from './vendor-credential';
import { ShortcutStatusReporter } from './shortcut-status-reporter';
import { ORG_MEMBERSHIP_DDL, PgOrgMembershipRepo } from './membership';
import { singleTenantEnabled, resolveInstanceOrgId } from './instance';
import { GITHUB_INSTALL_STATE_TABLE_DDL, GITHUB_CONNECTION_UNIQUE_DDL, PgGitHubInstallStateRepo } from './github-connect';
import { ORG_AGENT_TABLE_DDL } from './roster';
import { GitHubStatusReporter, routingStatusReporter } from './github-status-reporter';
import { COORDINATION_SCHEMA_DDL, AGENT_CREDENTIAL_TABLE_DDL } from './schema';
import type { StatusReporter, WebhookVerifier, Logger } from './ports';
import type { RepoProvisioner, TaskContentSource } from './orchestrate';
import { GitAppRepoProvisioner } from './repo-provisioner';
import { makeGitHubContentSource } from './github-content-source';
import { makeShortcutContentSource } from './shortcut-content-source';
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
    ...ORG_MEMBERSHIP_DDL, // user↔org membership + one-time backfill (FKs app_user + organization → last)
    GITHUB_INSTALL_STATE_TABLE_DDL, // slice 5c connect nonce (FKs app_user + organization)
    GITHUB_CONNECTION_UNIQUE_DDL, // slice 5c: one github account → one connection (DB-enforced re-bind guard)
    ORG_AGENT_TABLE_DDL, // slice 5d: org↔agent roster join (FKs organization + agent)
    AGENT_CREDENTIAL_TABLE_DDL, // slice SC-3: per-agent platform tokens (FKs organization + agent → after both)
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
 * No-op status-back fallback. The router (routingStatusReporter) sends a platform here
 * only when no real write-back reporter is wired for it — e.g. GitHub before its App is
 * configured, or Shortcut before the vault master key (TASCA_SECRET_STORE_KEY) enables
 * the per-agent identity write-back. It logs the intended update and returns — it must
 * never throw, or the orchestration loop would treat every task as failed at status-back.
 */
const gatedStatusReporter: StatusReporter = {
  async postStatus(update) {
    logger.info?.('status-back suppressed (no write-back reporter wired for this platform)', {
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
  const runnerWaitMs = numericEnv('TASCA_RUNNER_WAIT_MS');

  const pool = new Pool({ connectionString: databaseUrl });

  // Fail fast if the DB is unreachable or the schema can't be applied — a half-up
  // worker that can't persist is worse than one that exits and lets Coolify retry.
  await applySchema(pool);
  logger.info?.('coordination schema applied');

  // Tenancy mode (slice 3.5-B.1). Single-tenant (OSS): resolve the ONE instance org ONCE at boot —
  // explicit (TASCA_INSTANCE_ORG_ID), else adopt the oldest existing org, else provision greenfield. The
  // id is held for the onLogin enrollment hook + the org-api multiplicity gate. Multi-tenant (default):
  // skip it entirely — every user gets a personal org on login (unchanged).
  const singleTenant = singleTenantEnabled();
  const instanceOrgId = singleTenant ? await resolveInstanceOrgId(pool, logger) : undefined;
  logger.info?.(
    singleTenant ? 'tenancy: single-tenant' : 'tenancy: multi-tenant',
    singleTenant ? { instanceOrgId } : undefined
  );

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
  // Shortcut write-back (slice SC-3): an agent posts a story comment AS ITSELF, under its own Shortcut
  // Agent-User token resolved from the per-agent vault. Enabled when the vault master key is present
  // (slice SC-2: decoupled from SHORTCUT_WEBHOOK_SECRET — each connection now brings its own secret, so
  // an operator no longer sets a dummy env var to turn write-back on). The resolver is SHARED with the
  // agent-identity set-API (passed into the factory) so a set busts its cache here.
  const agentMasterKey = loadMasterKey();
  let agentCredentialResolver: AgentCredentialResolver | undefined;
  let shortcutStatusReporter: ShortcutStatusReporter | undefined;
  if (agentMasterKey) {
    const store = new PgCoordinationStore(pool);
    agentCredentialResolver = new AgentCredentialResolver(store, agentMasterKey);
    // The write-back adapter only drives postStoryComment (per-agent token in the header); its
    // webhookSecret is unused for that path but required to construct — placeholder when the legacy
    // env secret is unset (write-back no longer gates on it).
    const writebackAdapter = new ShortcutAdapter({ webhookSecret: webhookSecret || 'write-back-adapter' });
    shortcutStatusReporter = new ShortcutStatusReporter({
      credentials: agentCredentialResolver,
      adapter: writebackAdapter,
      logger,
    });
    logger.info?.('shortcut write-back enabled (per-agent identity vault)');
  } else {
    logger.info?.('shortcut write-back disabled (needs TASCA_SECRET_STORE_KEY)');
  }

  // Connection-scoped Shortcut intake (slice SC-1): a Shortcut workspace binds to a project (→ repo) and
  // carries its OWN sealed webhook secret. Enabled whenever the vault master key is present — independent
  // of SHORTCUT_WEBHOOK_SECRET (the legacy single-secret route), since each connection brings its own
  // secret. Wires the admin set-API + the per-connection webhook route POST /webhooks/shortcut/:id.
  let connectionCredentialResolver: ConnectionCredentialResolver | undefined;
  if (agentMasterKey) {
    connectionCredentialResolver = new ConnectionCredentialResolver(new PgCoordinationStore(pool), agentMasterKey);
    logger.info?.('shortcut connections enabled (per-connection secret vault)');
  } else {
    logger.info?.('shortcut connections disabled (needs TASCA_SECRET_STORE_KEY)');
  }

  // Shortcut write-back routes via routingStatusReporter even when github is off — start from a
  // shortcut-or-fallback router; the github block below re-routes with github added when it is enabled.
  let statusReporter: StatusReporter = shortcutStatusReporter
    ? routingStatusReporter({ github: gatedStatusReporter, shortcut: shortcutStatusReporter, fallback: gatedStatusReporter })
    : gatedStatusReporter;
  let githubInstallationHandler: ((rawBody: string) => Promise<void>) | undefined;
  let provisioner: RepoProvisioner | undefined;
  // Slice 5c connect bits (App client + slug) — set when the GitHub App env is present; passed to
  // the factory to wire the connect routes. The slug is the App's install-URL handle.
  let githubConnectInput: { appClient: { getInstallationAccount(id: string): Promise<string> }; appSlug: string } | undefined;
  const githubAppSlug = process.env.GITHUB_APP_SLUG ?? '';
  // The credential broker server (worker side) — serves per-task scoped tokens to the
  // agent-runner over a unix socket, keeping the App master key in this process.
  let brokerHandle: BrokerServerHandle | undefined;
  // Default content source derives a TaskInput from the event id; with the App
  // env present we fetch the REAL issue title/body for github events (so the
  // agent prompt is the actual story), delegating non-github to the default. The
  // shortcut block below wraps this so shortcut events fetch their real story too.
  let content: TaskContentSource = eventContentSource;
  if (githubWritebackEnabled) {
    const store = new PgCoordinationStore(pool);
    const identity = new PgIdentityRepository(pool);
    const appClient = new GitHubAppClient({
      appId: githubAppId,
      privateKey: githubAppPrivateKey,
    });
    // Wire the connect flow only when the App slug is configured (the install URL needs it).
    if (githubAppSlug) {
      githubConnectInput = { appClient, appSlug: githubAppSlug };
    } else {
      logger.info?.('github connect DISABLED — set GITHUB_APP_SLUG to enable the in-product install flow');
    }
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
    statusReporter = routingStatusReporter({
      github: githubReporter,
      ...(shortcutStatusReporter ? { shortcut: shortcutStatusReporter } : {}),
      fallback: gatedStatusReporter,
    });
    // The install webhook is CONFIRMATION only (slice 5c): the org binding is owned by the connect
    // CALLBACK (which has the session + nonce). The webhook cannot securely attribute an org, so it
    // never sets org_id — on `created` it refreshes the installation_id/health of the connection the
    // callback created (a no-op if the callback hasn't completed yet); on `deleted` it revokes.
    githubInstallationHandler = async (rawBody: string) => {
      const mapping = parseInstallationEvent(rawBody);
      if (!mapping) return;
      if (mapping.action === 'deleted') {
        const revoked = await store.revokeInstallationByAccount(mapping.accountLogin);
        logger.info?.('github installation revoked', { account: mapping.accountLogin, revoked });
        return;
      }
      const updated = await store.updateInstallationByAccount(mapping.accountLogin, mapping.installationId);
      logger.info?.('github installation confirmed', {
        account: mapping.accountLogin,
        installationId: mapping.installationId,
        // false when the connect callback hasn't yet created the connection — expected, not an error.
        connectionExists: updated,
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

  // Real story content for the agent prompt (shortcut events): fetch title/body via the connection's
  // workspace READ token (slice SC-2). Wrap the existing `content` (github-or-stub) so a shortcut event
  // routes to the shortcut source while github/other events fall through unchanged — each content source
  // self-routes by platform. Enabled whenever the connection vault is up (the SAME resolver SC-1 built —
  // not a second instance, so a read-token write busts one cache); off → shortcut content stays the stub.
  if (connectionCredentialResolver) {
    // The read-only adapter drives ONLY fetchStory (the read token rides in the header); its webhookSecret
    // is never used for that path but the constructor requires a non-empty value. This source enables off
    // the connection vault — independent of the legacy SHORTCUT_WEBHOOK_SECRET — so it can't reuse that
    // (possibly-unset) secret; a fixed placeholder keeps the constructor happy without gating on it.
    const readAdapter = new ShortcutAdapter({ webhookSecret: webhookSecret || 'read-only-adapter' });
    content = makeShortcutContentSource({
      store: new PgCoordinationStore(pool),
      resolver: connectionCredentialResolver,
      adapter: readAdapter,
      fallback: content,
      logger,
    });
    logger.info?.('shortcut content fetch enabled (per-connection read token)');
  }

  // Agent-call metering is now PER-TASK in orchestrate (BYOK, slice 3.5-A.2b): the in-process spawn
  // resolves the org's vault key and starts an ephemeral per-task proxy for the run — there is no
  // server-key boot proxy (the queue/runner topology that one served is not the prod path).

  // Coordination LLM — BYOK (slice 3.5-A.2a). The routing tier CLASSIFIER now runs on EACH ORG'S OWN
  // vault key (the instance's, single-tenant), resolved per task by the factory from the credential
  // vault — there is NO server key. OFF BY DEFAULT: set TASCA_LLM=on to enable (also needs the vault
  // master key TASCA_SECRET_STORE_KEY); the per-org classifier is then wired in the factory. Absent /
  // disabled / no org key → heuristic routing (fail-soft). (The PM-assistant LLM proposers degrade to
  // heuristic until wired to the per-org key — follow-up. The agent-execution key + tee is 3.5-A.2b.)
  const coordinationLlmEnabled = process.env.TASCA_LLM === 'on';
  if (coordinationLlmEnabled) {
    logger.info?.('coordination LLM enabled (BYOK — per-org vault key)', {
      model: process.env.TASCA_LLM_MODEL ?? 'claude-haiku-4-5-20251001',
    });
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
  // Org invites (slice 3.5-B.3.1): the accept link is built against the app origin = the OAuth redirect
  // base. Resolved here (at the composition root) and injected; absent auth → no invite API (it needs a
  // session to attribute the accepting identity anyway).
  let inviteAcceptBaseUrl: string | undefined;
  if (authEnv) {
    inviteAcceptBaseUrl = authEnv.OAUTH_REDIRECT_BASE;
    const authRepo = new PgAuthRepository(pool);
    // Slice 5a: every login provisions the user's org (auto personal org on first login) BEFORE the
    // session is minted, so a logged-in user always has an org by their first request — no no-org
    // window that would silently default. Idempotent + race-safe (ensurePersonalOrg).
    const onboardingRepo = new PgOrgMembershipRepo(pool);
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
      onLogin: async (userId) => {
        // Single-tenant (slice 3.5-B.1): enroll into the ONE instance org (resolved at boot) instead of
        // a per-user personal org. Multi-tenant: the original personal-org provisioning, unchanged.
        if (singleTenant) {
          await onboardingRepo.ensureInstanceMembership(userId, instanceOrgId!);
        } else {
          await onboardingRepo.ensurePersonalOrg(userId);
        }
      },
      logger, // server-side OAuth callback diagnostics (the per-branch failure reason)
    });
    // Hourly sweep of expired sessions + oauth-state rows. unref() so it never
    // holds the process open during shutdown.
    const installStateRepo = new PgGitHubInstallStateRepo(pool);
    authSweep = setInterval(() => {
      void authRepo.deleteExpired().catch((err) =>
        logger.error('auth expiry sweep failed', { err: err instanceof Error ? err.message : String(err) })
      );
      // Also sweep expired github connect nonces (slice 5c) — same hourly tick (consume already
      // refuses an expired nonce; this just stops the rows accumulating).
      void installStateRepo.deleteExpired().catch((err) =>
        logger.error('github install-state sweep failed', { err: err instanceof Error ? err.message : String(err) })
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
    // Split dispatch: enqueue jobs for an agent-runner (NO in-process fallback — if no
    // runner claims within the wait bound, the task is retired to needs_attention). OFF by
    // default; set TASCA_DISPATCH_MODE=queue once a runner is deployed.
    ...(process.env.TASCA_DISPATCH_MODE === 'queue' ? { dispatchQueueEnabled: true } : {}),
    ...(runnerWaitMs !== undefined ? { runnerWaitMs } : {}),
    ...(authHandler ? { authHandler } : {}),
    ...(verifySession ? { verifySession } : {}),
    ...(inviteAcceptBaseUrl ? { inviteAcceptBaseUrl } : {}),
    ...(githubConnectInput ? { githubConnect: githubConnectInput } : {}),
    ...(breakerThreshold !== undefined ? { breakerThreshold } : {}),
    ...(perProjectLimit !== undefined ? { perProjectLimit } : {}),
    ...(agentTimeoutMs !== undefined ? { agentTimeoutMs } : {}),
    // PM-assistant (slice W3-S1): advisory proposals. OFF by default (off-state first, per the
    // design); set TASCA_PM_ASSISTANT=on to enable proposal generation.
    ...(process.env.TASCA_PM_ASSISTANT === 'on' ? { pmAssistantEnabled: true } : {}),
    // Single-tenant edition (slice 3.5-B.1): gate the org-multiplicity routes. Default off (multi-tenant).
    ...(singleTenant ? { singleTenant: true } : {}),
    // Coordination LLM is BYOK (slice 3.5-A.2a): when enabled + the vault master key is present, the
    // factory builds a PER-ORG tier classifier that resolves each org's OWN vault key per task (no
    // server key). Disabled / no key → heuristic routing. (PM-assistant LLM proposers degrade to
    // heuristic until wired to the per-org key — follow-up.)
    coordinationLlm: { enabled: coordinationLlmEnabled, model: process.env.TASCA_LLM_MODEL ?? 'claude-haiku-4-5-20251001' },
    // BYOK vendor credentials (slice 3.5-A): the master key lives in the server env (NOT the DB);
    // absent → the write surface 503s. Live validate-on-input probes the vendor before storing.
    vendorCredential: { masterKey: loadMasterKey(), validator: liveVendorValidator() },
    // Per-agent identity (slice SC-3): wire the agent-identity set-API only when the shortcut write-back
    // resolver was built (master key + shortcut secret present), sharing that resolver for cache-bust.
    ...(agentCredentialResolver
      ? { agentCredential: { masterKey: agentMasterKey, resolver: agentCredentialResolver } }
      : {}),
    // Per-connection secrets (slice SC-1): wire the connection set-API + the connection-scoped webhook
    // route when the vault master key is present, sharing the resolver (so a set busts its cache) and
    // the boot-time Shortcut binding snapshot (the per-request verifier's assignee/self set).
    ...(connectionCredentialResolver
      ? {
          connectionCredential: {
            masterKey: agentMasterKey,
            resolver: connectionCredentialResolver,
            registeredShortcutIds,
          },
        }
      : {}),
  });

  const server = coordination.createServer();
  server.listen(port, () => {
    logger.info?.('coordination worker listening', {
      port,
      agents: agentIds.length,
      shortcutBindings: registeredShortcutIds.size,
      githubBindings: githubBindingRows.rows.length,
      // Per-route webhook status — named by ROUTE so neither can be misread as "all webhooks".
      // Each reflects that route's REAL gate: the github route 404s without GITHUB_WEBHOOK_SECRET
      // (ghVerifier undefined → server maps the path to 404); the shortcut route 401-rejects
      // without SHORTCUT_WEBHOOK_SECRET (rejectAllVerifier). They are INDEPENDENT — one verifying
      // while the other is unconfigured is normal, not a fault.
      githubWebhook: ghVerifier ? 'verifying' : 'disabled (no GITHUB_WEBHOOK_SECRET)',
      shortcutWebhook: webhookSecret ? 'verifying' : 'rejecting (no SHORTCUT_WEBHOOK_SECRET)',
      githubWriteback: githubWritebackEnabled ? 'enabled' : 'disabled',
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
