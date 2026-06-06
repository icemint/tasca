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

import { Pool } from 'pg';
import { TASK_TABLE_DDL } from '@tasca/db';
import { IDENTITY_SCHEMA_DDL } from '@tasca/identity';
import { createExecution } from '@tasca/execution';
import { ShortcutAdapter } from '@tasca/adapters';
import type { AdapterEvent, VerifiedEvent } from '@tasca/contracts';
import type { TaskInput } from '@tasca/routing';
import { createCoordination } from './factory';
import { COORDINATION_SCHEMA_DDL } from './schema';
import type {
  StatusReporter,
  WebhookVerifier,
  RawWebhook,
  VerifiedWebhook,
  Logger,
} from './ports';
import type { TaskContentSource } from './orchestrate';

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
    ...COORDINATION_SCHEMA_DDL, // task coordination columns + routing_decision/pull_request/ledger
  ];
  for (const ddl of statements) {
    await pool.query(ddl);
  }
}

/**
 * The webhook verifier wired from the real Shortcut adapter. HMAC-SHA-256 verify
 * over the raw body; the envelope `id` is the idempotency key; parse maps
 * owner_ids.adds ∩ registered Shortcut agent-user ids → AdapterEvents.
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
      return adapter.parseEvent(verified.payload as VerifiedEvent, registeredShortcutIds);
    },
  };
}

/** A verifier that rejects everything — used until SHORTCUT_WEBHOOK_SECRET is set. */
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

  const verifier = webhookSecret
    ? shortcutVerifier(webhookSecret, registeredShortcutIds)
    : rejectAllVerifier();
  if (!webhookSecret) {
    logger.error('SHORTCUT_WEBHOOK_SECRET unset — webhooks will 401 until it is configured');
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
    status: gatedStatusReporter,
    verifier,
    content: eventContentSource,
    agentIds,
    logger,
    ...(breakerThreshold !== undefined ? { breakerThreshold } : {}),
    ...(perProjectLimit !== undefined ? { perProjectLimit } : {}),
  });

  const server = coordination.createServer();
  server.listen(port, () => {
    logger.info?.('coordination worker listening', {
      port,
      agents: agentIds.length,
      shortcutBindings: registeredShortcutIds.size,
      webhooks: webhookSecret ? 'verifying' : 'rejecting (no secret)',
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
