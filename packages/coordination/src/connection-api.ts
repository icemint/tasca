// Shortcut connection set API (slice SC-1). Binds a Shortcut WORKSPACE to a PROJECT (project = 1 repo
// + N trackers), and seals the connection's two secrets — its inbound webhook signing secret + a read
// token — so the connection-scoped webhook route can verify deliveries from that workspace and resolve
// them to the project's repo. One route:
//   POST /api/orgs/:orgId/connections/shortcut  {workspaceId, projectId, webhookSecret, readToken} — admin+.
//
// WRITE-ONLY: both secrets are taken in on POST, sealed, and dropped; they are NEVER echoed, NEVER
// logged, NEVER read back. The response carries the connectionId + the webhook URL the operator pastes
// into Shortcut — no secret, no fingerprint of the secret in the body.
//
// Gating order mirrors agent-identity-api EXACTLY:
//   session → 401, getActiveOrg → 403, path-org must equal the active org → 403, CSRF → 403,
//   role admin+ → 403, master key present → 503, project exists IN this org → 404.
// admin+ because binding a connection + sealing its secrets is credential GOVERNANCE, not a
// member-level action.

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
} from './vendor-credential';

/** The connection write seam this API needs from the store — narrowed so the test fake stays small. */
export interface ShortcutConnectionWriter {
  projectExistsInOrg(orgId: string, projectId: string): Promise<boolean>;
  upsertShortcutConnection(
    orgId: string,
    input: { workspaceId: string; projectId: string }
  ): Promise<{ connectionId: string }>;
}

export interface ConnectionApiDeps {
  store: ConnectionCredentialStore & ShortcutConnectionWriter;
  /** Cache-bust the connection-credential resolver on a re-set so a new secret takes effect at once. */
  resolver: Pick<ConnectionCredentialResolver, 'invalidate'>;
  /** The env-held master key. ABSENT → the credential surface is disabled (503) — fail closed. */
  masterKey: Buffer | null;
  membership: RoleReader;
  /** Governance audit trail. Best-effort relative to the connection op (already upserted+sealed). */
  audit?: GovernanceAuditSink;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const WORKSPACE_ID_MAX = 200;
const SECRET_MAX = 500;

/** `POST /api/orgs/:orgId/connections/shortcut` → the path org, or null. */
function matchRoute(method: string, path: string): { orgId: string } | null {
  if (method !== 'POST') return null;
  const m = /^\/api\/orgs\/([^/]+)\/connections\/shortcut$/.exec(path);
  if (!m) return null;
  return { orgId: decodeURIComponent(m[1]!) };
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

  // ── mutation: CSRF + ADMIN+ (connection/credential governance) ──
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
  if (callerRole === null || !atLeast(callerRole, 'admin')) {
    sendJson(res, 403, { error: 'admin role required to manage connections' });
    return true;
  }
  // No master key → cannot seal; refuse rather than store an unsealable secret.
  if (!deps.masterKey) {
    deps.logger?.error('connection-api: TASCA_SECRET_STORE_KEY not configured — cannot seal');
    sendJson(res, 503, { error: 'credential storage is not configured on this server' });
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
