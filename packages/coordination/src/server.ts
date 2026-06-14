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
import { orchestrateTaskAssigned, workspaceForEvent, resolveWebhookOrg, type OrchestrationDeps } from './orchestrate';
import { readApiHandler, type ReadApiDeps } from './read-api';
import { writeApiHandler, type WriteApiDeps } from './write-api';
import { orgApiHandler, type OrgApiDeps } from './org-api';
import { agentApiHandler, type AgentApiDeps } from './agent-api';
import { projectApiHandler, type ProjectApiDeps } from './project-api';
import { vendorCredentialApiHandler, type VendorCredentialApiDeps } from './vendor-credential-api';
import { agentIdentityApiHandler, type AgentIdentityApiDeps } from './agent-identity-api';
import { proposalApiHandler, type ProposalApiDeps } from './proposal-api';
import { inviteApiHandler, type InviteApiDeps } from './invite-api';
import { githubConnectHandler, type GitHubConnectDeps } from './github-connect';
import { connectionApiHandler, type ConnectionApiDeps } from './connection-api';
import { shortcutVerifier } from './shortcut-verifier';
import type { ConnectionCredentialResolver } from './vendor-credential';

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
  /**
   * The org-management API (slice 5a: GET/POST /api/orgs, POST /api/active-org). Session-gated;
   * POSTs CSRF-gated. Absent → those paths fall through to 404 (additive).
   */
  orgApi?: OrgApiDeps;
  /**
   * The create-agent API (slice Wizard-A: POST /api/agents). Session-gated; CSRF + member-gated; mints
   * a named agent, derives its capability tier, and auto-hires it into the caller's active org —
   * atomically. Absent → that path falls through to 404 (additive).
   */
  agentApi?: AgentApiDeps;
  /**
   * The project API (slice Project-A: GET /api/projects, POST /api/active-project). Session-gated;
   * the POST CSRF-gated + store-validated in-org. NOT single-tenant-gated (projects exist in every
   * edition). Absent → those paths fall through to 404 (additive).
   */
  projectApi?: ProjectApiDeps;
  /**
   * The BYOK vendor-credential API (slice 3.5-A: GET/POST /api/orgs/credentials, DELETE
   * .../credentials/:provider). Session-gated; mutations CSRF + admin-gated; write-only (never
   * returns a key). Absent → those paths fall through to 404 (additive).
   */
  vendorCredentialApi?: VendorCredentialApiDeps;
  /**
   * The per-agent identity API (slice SC-3: POST /api/orgs/:orgId/agents/:agentId/identity/shortcut).
   * Session-gated; CSRF + admin-gated; write-only (seals the agent's Shortcut token, never returns it).
   * Absent → that path falls through to 404 (additive).
   */
  agentIdentityApi?: AgentIdentityApiDeps;
  /**
   * The PM-assistant API (slice W3-S1: GET /api/proposals, POST /api/proposals/generate +
   * .../:id/{accept,dismiss}). Session + CSRF + member-gated; advisory (accept routes through an
   * existing binding method). Absent → those paths fall through to 404 (additive).
   */
  proposalApi?: ProposalApiDeps;
  /**
   * The org-invite API (slice 3.5-B.3.1: POST/GET /api/invites, DELETE /api/invites/:id, POST
   * /api/invites/accept). Session-gated; mutations CSRF; create/list/revoke admin-gated, accept any
   * session. Absent → those paths fall through to 404 (additive).
   */
  inviteApi?: InviteApiDeps;
  /**
   * The GitHub connect API (slice 5c: GET /api/connect/github + .../callback). Session-gated;
   * binds a customer's GitHub install to their org. Absent → those paths fall through to 404.
   */
  connectApi?: GitHubConnectDeps;
  /**
   * The connection set API (slice SC-1: POST /api/orgs/:orgId/connections/shortcut). Session-gated;
   * CSRF + admin-gated; binds a Shortcut workspace to a project + seals the connection's secrets.
   * Absent → that path falls through to 404 (additive).
   */
  connectionApi?: ConnectionApiDeps;
  /** The Shortcut webhook verifier (POST /webhooks/shortcut — the legacy env-secret route). */
  verifier: WebhookVerifier;
  /**
   * Connection-scoped Shortcut intake (slice SC-1: POST /webhooks/shortcut/:connectionId). Resolves the
   * connection's sealed `webhook_secret` to build a PER-REQUEST verifier, so a multi-workspace org routes
   * each delivery to the right connection → project → repo. Absent (no master key / vault) → that path
   * 404s; the legacy `/webhooks/shortcut` env-secret route is unaffected.
   */
  connectionCredentialResolver?: ConnectionCredentialResolver;
  /**
   * Boot-time snapshot of the active Shortcut identity bindings, used to build the per-request
   * connection-scoped verifier (the registered assignee/self set). Same snapshot the legacy verifier
   * uses; a roster change needs a worker restart (the documented Stage-1 reload caveat).
   */
  registeredShortcutIds?: ReadonlySet<string>;
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

  // A resolved connection-scoped delivery (slice SC-1): the connection already determines the org and
  // the repo, so handleWebhook uses these directly instead of resolving the org from the event's
  // workspace, and stamps `repoHint` onto every event so the task lands on the connection's repo.
  interface ConnectionContext {
    connectionId: string;
    orgId: string;
    repoRef: string | null;
  }

  async function handleWebhook(
    verifier: WebhookVerifier,
    req: IncomingMessage,
    res: ServerResponse,
    connectionContext?: ConnectionContext
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

    // Validate parsed events through the shared trust-boundary schema before they
    // drive orchestration. The fields derive from untrusted webhook input, so a
    // malformed event (e.g. empty externalStoryId/agentExternalId) is dropped +
    // logged here rather than reaching the loop. This is the adapter→coordination
    // contract enforcement for AdapterEventSchema. Parsed BEFORE the ledger so the
    // delivery's org (derived from its workspace) scopes the ledger row consistently
    // with the tasks orchestration creates from the same events.
    const events: AdapterEvent[] = [];
    for (const candidate of verifier.parse(verified)) {
      const parsed = AdapterEventSchema.safeParse(candidate);
      if (parsed.success) {
        // Connection-scoped delivery (slice SC-1/SC-2): stamp the connection's project repo (so the task
        // gets the right repo — Shortcut events carry no repoHint of their own) AND the connection id (so
        // the content source can resolve THIS connection's read token to fetch the story title/body).
        events.push(
          connectionContext
            ? {
                ...parsed.data,
                repoHint: connectionContext.repoRef ?? undefined,
                shortcutConnectionId: connectionContext.connectionId,
              }
            : parsed.data
        );
      } else safeLog('coordination: dropped malformed adapter event', { platform: verified.platform });
    }

    // Resolve the delivery's org. For a CONNECTION-SCOPED delivery (slice SC-1) the connection already
    // determines the org — a Shortcut delivery's org is its connection's org, NOT the workspace/default
    // fallback. For the legacy env-secret route, resolve at the webhook EDGE from the first event's
    // workspace (its connection's org, or the default org for an unconnected workspace). A zero-event
    // delivery (a non-task webhook) has no workspace → default org, sufficient to dedup its redeliveries.
    const ledgerWorkspace = events[0] ? workspaceForEvent(events[0]) : null;
    const orgId = connectionContext
      ? connectionContext.orgId
      : await resolveWebhookOrg(deps.store, verified.platform, ledgerWorkspace);
    if (orgId === null) {
      // GitHub delivery for an UNCONNECTED workspace (slice 5c) → fail closed: ack so GitHub doesn't
      // retry-storm, but record NO ledger and orchestrate NOTHING. An installed-but-unbound account's
      // work is dropped, never run in the default tenant. The customer completes Connect to bind it.
      safeInfo('coordination: github webhook for an unconnected workspace — dropped (fail closed)', {
        platform: verified.platform,
        externalEventId: verified.externalEventId,
      });
      res.writeHead(202).end('accepted');
      return;
    }

    // Idempotency ledger: record this event as `received` under the delivery's org. Only an
    // event that already reached `processed` is a true duplicate to drop — a row still
    // `received` (a prior attempt recorded it then crashed before finishing) is re-driven,
    // so a post-record crash can't silently consume the event.
    const { alreadyProcessed } = await deps.store.recordWebhookEvent(orgId, {
      platform: verified.platform,
      externalEventId: verified.externalEventId,
      payload: verified.payload,
    });
    if (alreadyProcessed) {
      res.writeHead(200).end('duplicate');
      return;
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
          // Thread the EDGE-resolved org (the connection's org for connection-scoped intake) so the
          // task is created in the SAME tenant as the ledger row above — not re-resolved from the
          // event, which for Shortcut has no workspace and would fall to the grandfather default org.
          const outcome = await orchestrateTaskAssigned(event, deps, orgId);
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
        await deps.store.markWebhookProcessed(orgId, ledgerKey);
      } catch (err) {
        safeLog('coordination: orchestration failed after ack', {
          ...ledgerKey,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Connection-scoped Shortcut intake (slice SC-1). Resolves the connection by id, builds a per-request
   * verifier from its sealed webhook secret, and delegates to handleWebhook with the connection's
   * {org, repo} context. Fail-closed: the connection surface unconfigured (no resolver / no snapshot)
   * or an unknown connection → 404; a connection without a sealed secret → 401.
   */
  async function handleConnectionWebhook(
    connectionId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // The connection surface is unconfigured (no vault master key) → not routed. 404 (not-routed),
    // never a 500 or a fall-through to the default tenant.
    if (!deps.connectionCredentialResolver) {
      res.writeHead(404).end('not found');
      return;
    }
    const connection = await deps.store.getShortcutConnectionById(connectionId);
    if (!connection) {
      // Unknown / non-shortcut / revoked connection — not routed.
      res.writeHead(404).end('not found');
      return;
    }
    // Resolve the connection's sealed webhook secret (org-scoped). Absent → fail closed (401), never
    // run unverified: a connection whose secret write didn't land 401s until a re-set adds it.
    const secret = await deps.connectionCredentialResolver.resolve(connection.orgId, connectionId, 'webhook_secret');
    if (secret === null) {
      res.writeHead(401).end('invalid signature');
      return;
    }
    // Build a per-request verifier with THIS connection's secret. The registered agent-id set is the
    // boot-time snapshot (assignee/self set), shared with the legacy route.
    const verifier = shortcutVerifier(secret, deps.registeredShortcutIds ?? new Set<string>());
    await handleWebhook(verifier, req, res, {
      connectionId,
      orgId: connection.orgId,
      repoRef: connection.repoRef,
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    // The deployed build SHA (baked into the image at build time as TASCA_GIT_SHA).
    // The CD deploy script polls this AFTER Coolify reports a finished rollout and
    // fails the job unless it matches the pushed tag — so a rollout that silently
    // re-served the OLD image (Coolify mutable-tag #5318) can't pass as success.
    // no-store: the verify must read the live container, never a cached value.
    if (req.method === 'GET' && req.url === '/version') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(process.env.TASCA_GIT_SHA ?? 'unknown');
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

    // Connection-scoped Shortcut intake (slice SC-1): POST /webhooks/shortcut/:connectionId. The path
    // carries the connection id; resolve the connection → its sealed webhook_secret → a per-request
    // verifier, then run the SAME verify→ledger→orchestrate flow with the connection's org + repo. Fail
    // CLOSED: an unknown/non-shortcut/revoked connection → 404; a connection with no sealed secret → 401.
    // Never 500, never the default tenant. (The legacy `/webhooks/shortcut` route above is unchanged.)
    if (req.method === 'POST' && req.url !== undefined) {
      const m = /^\/webhooks\/shortcut\/([^/]+)$/.exec(new URL(req.url, 'http://localhost').pathname);
      if (m) {
        await handleConnectionWebhook(decodeURIComponent(m[1]!), req, res);
        return;
      }
    }

    // Auth routes (only when wired). The handler returns true if it owned the
    // request; a false return falls through to the read API / 404 below.
    if (deps.authHandler && (await deps.authHandler(req, res))) {
      return;
    }

    // GitHub connect API (only when wired). Handles GET /api/connect/github + .../callback.
    if (deps.connectApi && (await githubConnectHandler(req, res, deps.connectApi))) return;

    // Org-management API (only when wired). Handles GET/POST /api/orgs + POST /api/active-org —
    // before the read/write API, which don't claim those paths.
    if (deps.orgApi && (await orgApiHandler(req, res, deps.orgApi))) return;

    // Create-agent API (only when wired). Owns POST /api/agents — before the generic read API, which
    // owns GET /api/agents (the roster list). Only the POST is claimed here; a GET falls through.
    if (deps.agentApi && (await agentApiHandler(req, res, deps.agentApi))) return;

    // Project API (only when wired). Handles GET /api/projects + POST /api/active-project before the
    // generic read API's /api/* claim.
    if (deps.projectApi && (await projectApiHandler(req, res, deps.projectApi))) return;

    // BYOK vendor-credential API (only when wired). Handles /api/orgs/credentials before the
    // org-api/read-api (more specific path; both must run before the generic read API's /api/* claim).
    if (deps.vendorCredentialApi && (await vendorCredentialApiHandler(req, res, deps.vendorCredentialApi))) return;

    // Per-agent identity API (only when wired). Handles POST /api/orgs/:orgId/agents/:agentId/identity/shortcut
    // before the generic read API's /api/* claim.
    if (deps.agentIdentityApi && (await agentIdentityApiHandler(req, res, deps.agentIdentityApi))) return;

    // Connection set API (only when wired). Handles POST /api/orgs/:orgId/connections/shortcut before
    // the generic read API's /api/* claim.
    if (deps.connectionApi && (await connectionApiHandler(req, res, deps.connectionApi))) return;

    // PM-assistant API (only when wired). Handles GET /api/proposals + the mutating POSTs.
    if (deps.proposalApi && (await proposalApiHandler(req, res, deps.proposalApi))) return;

    // Org-invite API (only when wired). Handles /api/invites* before the generic read API's /api/* claim.
    if (deps.inviteApi && (await inviteApiHandler(req, res, deps.inviteApi))) return;

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
