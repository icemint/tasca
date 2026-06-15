// Shortcut connection API (slice SC-1 + connection-credentials). Binds a Shortcut WORKSPACE to a
// PROJECT (project = 1 repo + N trackers), and seals the connection's two secrets — its inbound webhook
// signing secret + a read token — so the connection-scoped webhook route can verify deliveries from that
// workspace and resolve them to the project's repo. Four routes:
//   GET    /api/orgs/:orgId/connections/shortcut                — connection STATUS (member+).
//   POST   /api/orgs/:orgId/connections/shortcut  {workspaceId, projectId, webhookSecret, readToken} — admin+.
//   POST   /api/orgs/:orgId/connections/shortcut/test {readToken} — live-probe the SUBMITTED read token (admin+).
//   DELETE /api/orgs/:orgId/connections/shortcut                — disconnect + cascade secrets (admin+).
//
// WRITE-ONLY for the SECRETS: both secrets are taken in on POST, sealed, and dropped; they are NEVER
// echoed, NEVER logged, NEVER read back. The POST response carries the connectionId + the webhook URL
// the operator pastes into Shortcut — no secret, no fingerprint of the secret in that body. The GET
// STATUS read returns per-kind {status, fingerprint, lastValidatedAt} — the FINGERPRINT is a
// non-reversible hash (≠ the secret; the same posture the vendor + agent cards already take), already
// persisted in connection_credential.key_fingerprint + the audit trail. Still never the secret/ciphertext.
//
// Gating order mirrors agent-credential-api EXACTLY:
//   session → 401, getActiveOrg → 403, path-org must equal the active org → 403; then GET is member+
//   and reads status (it succeeds even with the master key unset — it reads fingerprint/status columns,
//   no unseal); the mutations + /test require CSRF → 403, role admin+ → 403, master key present → 503.
// admin+ for writes because binding a connection + sealing its secrets is credential GOVERNANCE, not a
// member-level action; the project-exists check (POST) is a 404 (no cross-tenant existence oracle).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type RoleReader } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';
import type { GovernanceAuditSink } from './governance-audit';
import {
  sealVendorKey,
  fingerprintConnectionKey,
  type ConnectionCredentialStore,
  type ConnectionCredentialResolver,
  type AgentCredentialValidator,
} from './vendor-credential';

/** The connection read/write seam this API needs from the store — narrowed so the test fake stays small. */
export interface ShortcutConnectionWriter {
  projectExistsInOrg(orgId: string, projectId: string): Promise<boolean>;
  upsertShortcutConnection(
    orgId: string,
    input: { workspaceId: string; projectId: string }
  ): Promise<{ connectionId: string }>;
  getShortcutConnectionForOrg(
    orgId: string
  ): Promise<{ connectionId: string; workspaceId: string; projectId: string | null } | null>;
  deleteShortcutConnection(orgId: string, connectionId: string): Promise<boolean>;
}

export interface ConnectionApiDeps {
  store: ConnectionCredentialStore & ShortcutConnectionWriter;
  /** Cache-bust the connection-credential resolver on a re-set / delete so a change takes effect at once. */
  resolver: Pick<ConnectionCredentialResolver, 'invalidate'>;
  /** Live per-platform probe (validate-on-input) — the SAME validator the agent credentials use; /test
   *  probes the SUBMITTED read token against Shortcut's member endpoint. */
  validator: AgentCredentialValidator;
  /** The env-held master key. ABSENT → the WRITE surface is disabled (503) — fail closed. The GET status
   *  read still succeeds (it reads fingerprint/status columns, no unseal). */
  masterKey: Buffer | null;
  membership: RoleReader;
  /** Governance audit trail. Best-effort relative to the connection op (already upserted+sealed/removed). */
  audit?: GovernanceAuditSink;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const WORKSPACE_ID_MAX = 200;
const SECRET_MAX = 500;

type Route =
  | { kind: 'status'; orgId: string }
  | { kind: 'set'; orgId: string }
  | { kind: 'test'; orgId: string }
  | { kind: 'delete'; orgId: string };

function matchRoute(method: string, path: string): Route | null {
  const test = /^\/api\/orgs\/([^/]+)\/connections\/shortcut\/test$/.exec(path);
  if (test) {
    if (method !== 'POST') return null;
    return { kind: 'test', orgId: decodeURIComponent(test[1]!) };
  }
  const base = /^\/api\/orgs\/([^/]+)\/connections\/shortcut$/.exec(path);
  if (!base) return null;
  const orgId = decodeURIComponent(base[1]!);
  if (method === 'GET') return { kind: 'status', orgId };
  if (method === 'POST') return { kind: 'set', orgId };
  if (method === 'DELETE') return { kind: 'delete', orgId };
  return null;
}

export async function connectionApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectionApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors agent-identity-api) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('connection-api: session verification threw', { err: String(err) });
      sendJson(res, 401, { authenticated: false });
      return true;
    }
    if (!session) {
      sendJson(res, 401, { authenticated: false });
      return true;
    }
  } else if (!deps.allowUnauthenticated) {
    sendJson(res, 503, { error: 'auth not configured' });
    return true;
  }
  const userId = session?.userId ?? '(dev)';

  const activeOrg = await deps.membership.getActiveOrg(userId);
  if (activeOrg === null) {
    sendJson(res, 403, { error: 'no organization membership' });
    return true;
  }
  // The path org MUST be the caller's active org — never let a caller act on another tenant's
  // connection by naming a different org in the URL (fail closed on tenant ambiguity).
  if (route.orgId !== activeOrg) {
    sendJson(res, 403, { error: 'org mismatch' });
    return true;
  }
  const orgId = activeOrg;

  // GET — connection STATUS only (no secret). Any member may see whether/how Shortcut is connected
  // (drives the "ask an admin" UX for non-admins). Succeeds even with the master key unset — it reads
  // the fingerprint/status columns, never unseals (matches the vendor + agent status reads).
  if (route.kind === 'status') {
    sendJson(res, 200, await buildStatus(deps, orgId));
    return true;
  }

  // ── mutations + /test: CSRF + ADMIN+ (connection/credential governance) ──
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
  if (callerRole === null || !atLeast(callerRole, 'admin')) {
    sendJson(res, 403, { error: 'admin role required to manage connections' });
    return true;
  }
  // No master key → the write surface is disabled (set cannot seal; /test + DELETE present a coherent
  // disabled UX). Refuse rather than imply a half-working surface.
  if (!deps.masterKey) {
    deps.logger?.error('connection-api: TASCA_SECRET_STORE_KEY not configured — credential surface disabled');
    sendJson(res, 503, { error: 'credential storage is not configured on this server' });
    return true;
  }

  // POST .../shortcut/test — live-probe the SUBMITTED read token (pre-save). Never unseals a stored
  // secret; never persists. Returns {ok} or {ok:false, reason} (a fixed curated reason — never the token).
  if (route.kind === 'test') {
    let testBody: unknown;
    try {
      testBody = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid body' });
      return true;
    }
    const token = (testBody as { readToken?: unknown }).readToken;
    if (typeof token !== 'string' || token.trim().length === 0 || token.trim().length > SECRET_MAX) {
      sendJson(res, 400, { error: `readToken (1–${SECRET_MAX} chars) is required` });
      return true;
    }
    const verdict = await deps.validator.validate('shortcut', token.trim());
    sendJson(res, 200, verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason });
    return true;
  }

  // DELETE .../shortcut — disconnect: remove the connection (its secrets cascade) + invalidate the
  // resolver for both kinds so a removed secret stops resolving from THIS node's cache. A no-op (no
  // connection) is a 404. NOTE (multi-node): invalidate busts only THIS node's cache (~60s TTL window
  // elsewhere) — see the ConnectionCredentialResolver KNOWN LIMITATION; single-node dispatch has none.
  if (route.kind === 'delete') {
    const existing = await deps.store.getShortcutConnectionForOrg(orgId);
    if (!existing) {
      sendJson(res, 404, { error: 'no Shortcut connection configured' });
      return true;
    }
    const removed = await deps.store.deleteShortcutConnection(orgId, existing.connectionId);
    deps.resolver.invalidate(orgId, existing.connectionId, 'webhook_secret');
    deps.resolver.invalidate(orgId, existing.connectionId, 'read_token');
    if (removed) {
      await recordAudit(deps, orgId, userId, {
        action: 'connection.shortcut.delete',
        target: existing.connectionId,
      });
    }
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no Shortcut connection configured' });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return true;
  }
  const { workspaceId, projectId, webhookSecret, readToken } = body as {
    workspaceId?: unknown;
    projectId?: unknown;
    webhookSecret?: unknown;
    readToken?: unknown;
  };

  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0 || workspaceId.trim().length > WORKSPACE_ID_MAX) {
    sendJson(res, 400, { error: `workspaceId (1–${WORKSPACE_ID_MAX} chars) is required` });
    return true;
  }
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    sendJson(res, 400, { error: 'projectId is required' });
    return true;
  }
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0 || webhookSecret.length > SECRET_MAX) {
    sendJson(res, 400, { error: `webhookSecret (1–${SECRET_MAX} chars) is required` });
    return true;
  }
  if (typeof readToken !== 'string' || readToken.length === 0 || readToken.length > SECRET_MAX) {
    sendJson(res, 400, { error: `readToken (1–${SECRET_MAX} chars) is required` });
    return true;
  }
  const trimmedWorkspaceId = workspaceId.trim();
  const trimmedProjectId = projectId.trim();

  // The project MUST be one of THIS org's — a 404 (not 403) so a caller can't probe other orgs'
  // projects by id (no cross-tenant existence oracle).
  if (!(await deps.store.projectExistsInOrg(orgId, trimmedProjectId))) {
    sendJson(res, 404, { error: 'no such project in this organization' });
    return true;
  }

  // Seal both secrets (never persist plaintext) + non-reversible fingerprints for the audit trail.
  const webhookSealed = sealVendorKey(webhookSecret, deps.masterKey);
  const readSealed = sealVendorKey(readToken, deps.masterKey);
  const webhookFingerprint = fingerprintConnectionKey('webhook_secret', webhookSecret);
  const readFingerprint = fingerprintConnectionKey('read_token', readToken);

  // Three writes land in separate rows with no shared transaction, so order them so a partial failure
  // degrades safely. CONNECTION ROW FIRST: it is the load-bearing projection — the webhook route + the
  // repo-link resolve against it, and it is the entity the credentials FK. If a credential write throws
  // after it lands, the connection exists with NO (or one) secret → its webhook deliveries fail closed
  // (401) until a re-set adds the secrets — visible + recoverable, never an orphan secret pointing at no
  // connection. The upsert is idempotent (ON CONFLICT DO UPDATE) and the credential sets are too
  // (ON CONFLICT DO UPDATE), so a re-set fully heals any partial outcome.
  const { connectionId } = await deps.store.upsertShortcutConnection(orgId, {
    workspaceId: trimmedWorkspaceId,
    projectId: trimmedProjectId,
  });
  const createdBy = userId === '(dev)' ? null : userId;
  await deps.store.setConnectionCredential(orgId, connectionId, 'webhook_secret', webhookSealed, webhookFingerprint, createdBy);
  await deps.store.setConnectionCredential(orgId, connectionId, 'read_token', readSealed, readFingerprint, createdBy);
  deps.resolver.invalidate(orgId, connectionId, 'webhook_secret'); // a re-set takes effect immediately on this node
  deps.resolver.invalidate(orgId, connectionId, 'read_token');

  // Governance trail: record the set with the fingerprints — NEVER the secrets. Best-effort (the
  // connection + credentials already landed, so a failed audit write must not turn this into a 500).
  await recordAudit(deps, orgId, userId, {
    action: 'connection.shortcut.set',
    target: connectionId,
    payload: { workspaceId: trimmedWorkspaceId, projectId: trimmedProjectId, webhookFingerprint, readFingerprint },
  });

  // The webhook URL the operator pastes into Shortcut. NEVER returns either secret.
  sendJson(res, 200, { ok: true, connectionId, webhookUrl: `/webhooks/shortcut/${connectionId}` });
  return true;
}

/** Build the connection STATUS payload (GET) — the bound workspace/project + webhook URL + per-kind
 *  {kind, status, fingerprint, lastValidatedAt}. NEVER a secret or ciphertext (fingerprints only — a
 *  non-reversible hash). `connected:false` (a not-configured shape) when no Shortcut connection exists. */
async function buildStatus(deps: ConnectionApiDeps, orgId: string): Promise<Record<string, unknown>> {
  const conn = await deps.store.getShortcutConnectionForOrg(orgId);
  if (!conn) return { connected: false };
  const credentials = await deps.store.getConnectionCredentialStatuses(orgId, conn.connectionId);
  return {
    connected: true,
    workspaceId: conn.workspaceId,
    projectId: conn.projectId,
    webhookUrl: `/webhooks/shortcut/${conn.connectionId}`,
    credentials,
  };
}

/** Best-effort governance-audit write (mirrors agent-identity-api): the connection op already
 *  succeeded, so a write failure is logged, never failing the response. NEVER pass a raw secret. */
async function recordAudit(
  deps: ConnectionApiDeps,
  orgId: string,
  userId: string,
  e: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.recordGovernanceAudit(orgId, { actorUserId: userId, ...e });
  } catch (err) {
    deps.logger?.error('connection-api: governance audit write failed', {
      orgId,
      action: e.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
