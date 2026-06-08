// The thin HTTP entry (scaffold §6.3 + build step 7). node:http only — no
// Fastify/Express (decoupling constraint: no new runtime deps).
//
//   POST /webhooks/shortcut  → read RAW body → injected WebhookVerifier.verify
//   POST /webhooks/github    + parse → idempotent enqueue (webhook_event) →
//                              run the orchestration off the ack.
//   GET  /healthz            → 200 'ok'.
//
// Each webhook path has its own injected WebhookVerifier; the verify→ledger→
// fast-ack→orchestrate flow is identical, so it is shared across platforms. A
// path with no configured verifier 404s (e.g. github before its secret is set).
//
// Fast-ack discipline (scaffold §4.2): verify + dedupe-record synchronously,
// then 202 immediately; the heavy orchestration runs after the response so the
// platform's webhook delivery isn't held open on a full route+execute cycle.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { AdapterEventSchema, type AdapterEvent } from '@tasca/contracts';
import type { CoordinationStore } from './store';
import type { WebhookVerifier, Logger } from './ports';
import { orchestrateTaskAssigned, type OrchestrationDeps } from './orchestrate';
import { readApiHandler, type ReadApiDeps } from './read-api';
import { writeApiHandler, type WriteApiDeps } from './write-api';

export interface CoordinationServerDeps extends OrchestrationDeps {
  /**
   * The read-only API the app consumes (GET /api/agents, /api/tasks, …). Wired at
   * the composition root; absent → those paths fall through to 404 (the read API
   * is additive and does not affect the webhook/healthz paths).
   */
  readApi?: ReadApiDeps;
  /**
   * The human write-API (POST /api/tasks/:id/{escalate,retier,reassign}, GET
   * /api/csrf). Session + CSRF gated. Absent → those paths fall through to 404
   * (additive; webhook/healthz/read paths unaffected).
   */
  writeApi?: WriteApiDeps;
  /** The Shortcut webhook verifier (POST /webhooks/shortcut). */
  verifier: WebhookVerifier;
  /** The GitHub webhook verifier (POST /webhooks/github). Absent → that path 404s. */
  githubVerifier?: WebhookVerifier;
  /**
   * Handles a GitHub `installation` / `installation_repositories` event off the
   * verified raw body (records the account→installation mapping for write-back).
   * Called on the github path only, AFTER a successful verify, BEFORE parse — it
   * is best-effort and pure-additive: parse stays unaffected (an install event
   * yields no AdapterEvents). Absent (App write-back unconfigured) → not called.
   */
  githubInstallationHandler?: (rawBody: string) => Promise<void>;
  /**
   * The auth handler (GET/POST /api/auth/*). Consulted before the 404; returns
   * `true` when it owned the request. Absent (OAuth env unset) → /api/auth/*
   * falls through to a 404, keeping the feature flag OFF by default.
   */
  authHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /**
   * Schedules the post-ack orchestration. Defaults to `queueMicrotask` with a
   * last-resort `.catch` so a rejected run is logged, never an unhandledRejection
   * that could crash the process; tests pass a collector to await it.
   */
  runAsync?: (work: () => Promise<void>) => void;
  /** Structured logger for post-ack failures. Defaults to `console`. */
  logger?: Logger;
}

const MAX_BODY_BYTES = 1_000_000; // reject oversized webhook bodies

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

/**
 * Build the request handler. Exposed separately from `createServer` so it can be
 * unit-tested without binding a socket.
 */
export function createRequestHandler(deps: CoordinationServerDeps) {
  const logger = deps.logger ?? console;
  // Log without ever throwing: a misbehaving injected logger must not turn an
  // error path back into an unhandled rejection.
  const safeLog = (message: string, context: Record<string, unknown>) => {
    try {
      logger.error(message, context);
    } catch {
      /* a logger that throws is not allowed to escalate */
    }
  };
  // Info-level sibling of safeLog. Pre-ack logging must never throw: a misbehaving
  // injected logger would otherwise reject handleWebhook before the 202, the outer
  // handler would 500, and GitHub would redeliver — a redelivery storm from a log.
  const safeInfo = (message: string, context: Record<string, unknown>) => {
    try {
      logger.info?.(message, context);
    } catch {
      /* a logger that throws is not allowed to escalate */
    }
  };
  // Default scheduler: run after the ack, but attach a last-resort `.catch` so a
  // rejection is logged rather than escaping as an unhandledRejection. The work
  // closure below already handles its own errors; this is defense in depth.
  const runAsync =
    deps.runAsync ??
    ((work) =>
      queueMicrotask(() => {
        void work().catch((err) =>
          safeLog('coordination: post-ack work rejected', { err: String(err) })
        );
      }));

  // Path → verifier. A path whose verifier is undefined (e.g. github before its
  // secret is configured) is treated as not-routed (404), never a 500.
  const webhookRoutes: Record<string, WebhookVerifier | undefined> = {
    '/webhooks/shortcut': deps.verifier,
    '/webhooks/github': deps.githubVerifier,
  };

  async function handleWebhook(
    verifier: WebhookVerifier,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    let rawBody: string;
    try {
      rawBody = await readRawBody(req);
    } catch {
      res.writeHead(413).end('payload too large');
      return;
    }

    // Verify the signature over the RAW body BEFORE parsing JSON.
    const verified = verifier.verify({ rawBody, headers: headerMap(req) });
    if (!verified) {
      res.writeHead(401).end('invalid signature');
      return;
    }

    // GitHub install events carry the account→installation mapping write-back
    // needs. Handle it on the verified body BEFORE the idempotency ledger/parse:
    // it is best-effort (its own failure must not fail the webhook) and an install
    // event produces no AdapterEvents, so the ledger/parse path is unaffected.
    if (verified.platform === 'github' && deps.githubInstallationHandler) {
      const handler = deps.githubInstallationHandler;
      try {
        await handler(rawBody);
      } catch (err) {
        safeLog('coordination: github install handler failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Idempotency ledger: record this event as `received`. Only an event that
    // already reached `processed` is a true duplicate to drop — a row still
    // `received` (a prior attempt recorded it then crashed before finishing) is
    // re-driven, so a post-record crash can't silently consume the event.
    const { alreadyProcessed } = await deps.store.recordWebhookEvent({
      platform: verified.platform,
      externalEventId: verified.externalEventId,
      payload: verified.payload,
    });
    if (alreadyProcessed) {
      res.writeHead(200).end('duplicate');
      return;
    }

    // Validate parsed events through the shared trust-boundary schema before they
    // drive orchestration. The fields derive from untrusted webhook input, so a
    // malformed event (e.g. empty externalStoryId/agentExternalId) is dropped +
    // logged here rather than reaching the loop. This is the adapter→coordination
    // contract enforcement for AdapterEventSchema.
    const events: AdapterEvent[] = [];
    for (const candidate of verifier.parse(verified)) {
      const parsed = AdapterEventSchema.safeParse(candidate);
      if (parsed.success) events.push(parsed.data);
      else safeLog('coordination: dropped malformed adapter event', { platform: verified.platform });
    }
    const ledgerKey = {
      platform: verified.platform,
      externalEventId: verified.externalEventId,
    };

    // Intake receipt: makes a verified-but-zero-event delivery visible in worker
    // logs (otherwise only outcomes-per-event are logged, so a 0-event delivery is
    // silent and indistinguishable from a dropped one).
    safeInfo('coordination: webhook received', {
      platform: verified.platform,
      externalEventId: verified.externalEventId,
      events: events.length,
    });

    // Fast-ack: 202 now, orchestrate after the response. The work is detached
    // from the response, so it owns its errors: on success the ledger row is
    // flipped to `processed`; on failure it is logged WITH context and left
    // `received` so a redelivery re-drives it (get-or-create + the CAS make the
    // re-drive idempotent — no duplicate task, no double-dispatch).
    res.writeHead(202).end('accepted');
    runAsync(async () => {
      try {
        for (const event of events) {
          const outcome = await orchestrateTaskAssigned(event, deps);
          // Surface every NON-throwing terminal (no_candidate / lost_claim /
          // not_routable / failed / needs_attention / dispatched) at the boundary;
          // without this only the throw path below is observable.
          logger.info?.('coordination: orchestration outcome', {
            platform: event.platform,
            externalEventId: verified.externalEventId,
            kind: outcome.kind,
            taskId: outcome.taskId,
          });
        }
        await deps.store.markWebhookProcessed(ledgerKey);
      } catch (err) {
        safeLog('coordination: orchestration failed after ack', {
          ...ledgerKey,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && req.url !== undefined && req.url in webhookRoutes) {
      const verifier = webhookRoutes[req.url];
      if (!verifier) {
        res.writeHead(404).end('not found');
        return;
      }
      await handleWebhook(verifier, req, res);
      return;
    }

    // Auth routes (only when wired). The handler returns true if it owned the
    // request; a false return falls through to the read API / 404 below.
    if (deps.authHandler && (await deps.authHandler(req, res))) {
      return;
    }

    // Read API (only when wired). Handles GET /api/* read endpoints.
    if (deps.readApi && (await readApiHandler(req, res, deps.readApi))) return;

    // Write API (only when wired). Handles GET /api/csrf + the mutating POSTs.
    if (deps.writeApi && (await writeApiHandler(req, res, deps.writeApi))) return;

    res.writeHead(404).end('not found');
  };
}

/** Create (but do not start) the node:http coordination server. */
export function createCoordinationServer(deps: CoordinationServerDeps): Server {
  const handle = createRequestHandler(deps);
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
  });
}
