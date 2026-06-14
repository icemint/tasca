// Engineering Manager admin API (EM v1 slice 1). The EM is a DISTINCT entity (NOT an agent): it
// reasons + communicates and comments AS ITSELF, under its OWN sealed credential — never the agent
// vault. This API builds the entity + its identity + its project link. Three routes:
//   POST /api/orgs/:orgId/managers                              {name}                  — create (admin+).
//   POST /api/orgs/:orgId/managers/:managerId/identity/shortcut {memberId, token, ...}  — set identity (admin+).
//   POST /api/orgs/:orgId/projects/:projectId/manager          {managerId}             — assign to project (admin+).
//
// WRITE-ONLY for the identity route: the token is taken in on POST, sealed, and dropped; it is NEVER
// echoed, NEVER logged, NEVER read back. That response carries only a fingerprint + ok.
//
// Gating order mirrors agent-identity-api / connection-api EXACTLY:
//   session → 401, getActiveOrg → 403, path-org must equal the active org → 403, CSRF → 403,
//   role admin+ → 403, (credential routes) master key present → 503, entity-in-org → 404.
// admin+ on every route because a manager + its credential + its project binding are GOVERNANCE, not a
// member-level action.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type RoleReader } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';
import type { GovernanceAuditSink } from './governance-audit';
import { sealVendorKey, fingerprintManagerKey } from './vendor-credential';

/** The manager write/read seam this API needs from the store — narrowed so the test fake stays small. */
export interface ManagerApiStore {
  createManager(orgId: string, name: string): Promise<{ managerId: string }>;
  getManager(
    orgId: string,
    managerId: string
  ): Promise<{ id: string; name: string; shortcutMemberId: string | null; shortcutHandle: string | null } | null>;
  setManagerShortcutIdentity(
    orgId: string,
    managerId: string,
    memberId: string,
    handle: string | null,
    sealed: { ciphertext: string; nonce: string; authTag: string },
    fingerprint: string,
    createdBy: string | null
  ): Promise<void>;
  setProjectManager(orgId: string, projectId: string, managerId: string): Promise<'ok' | 'not_found'>;
}

export interface ManagerApiDeps {
  store: ManagerApiStore;
  /** The env-held master key. ABSENT → the credential (identity) surface is disabled (503) — fail closed.
   *  The create + project-assign routes do NOT seal anything, so they do not require it. */
  masterKey: Buffer | null;
  membership: RoleReader;
  /** Governance audit trail. Best-effort relative to the op (already committed). */
  audit?: GovernanceAuditSink;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const NAME_MAX = 200;
const MEMBER_ID_MAX = 200;
const TOKEN_MAX = 4096;
const HANDLE_MAX = 80;

type Route =
  | { kind: 'create' }
  | { kind: 'set-identity'; managerId: string }
  | { kind: 'assign-project'; projectId: string };

function matchRoute(method: string, path: string): Route | null {
  if (method !== 'POST') return null;
  if (/^\/api\/orgs\/[^/]+\/managers$/.test(path)) return { kind: 'create' };
  const ident = /^\/api\/orgs\/[^/]+\/managers\/([^/]+)\/identity\/shortcut$/.exec(path);
  if (ident) return { kind: 'set-identity', managerId: decodeURIComponent(ident[1]!) };
  const assign = /^\/api\/orgs\/[^/]+\/projects\/([^/]+)\/manager$/.exec(path);
  if (assign) return { kind: 'assign-project', projectId: decodeURIComponent(assign[1]!) };
  return null;
}

/** The path org segment (the same position in all three routes). */
function pathOrg(path: string): string | null {
  const m = /^\/api\/orgs\/([^/]+)\//.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function managerApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ManagerApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors agent-identity-api / connection-api) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('manager-api: session verification threw', { err: String(err) });
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
  // The path org MUST be the caller's active org — never let a caller act on another tenant's manager by
  // naming a different org in the URL (fail closed on tenant ambiguity).
  if (pathOrg(path) !== activeOrg) {
    sendJson(res, 403, { error: 'org mismatch' });
    return true;
  }
  const orgId = activeOrg;

  // ── mutation: CSRF + ADMIN+ (manager/credential/binding governance) ──
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
  if (callerRole === null || !atLeast(callerRole, 'admin')) {
    sendJson(res, 403, { error: 'admin role required to manage managers' });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return true;
  }

  if (route.kind === 'create') return handleCreate(res, deps, orgId, userId, body);
  if (route.kind === 'set-identity') return handleSetIdentity(res, deps, orgId, userId, route.managerId, body);
  return handleAssignProject(res, deps, orgId, userId, route.projectId, body);
}

/** POST /api/orgs/:orgId/managers — create a manager. No credential → no master key needed. */
async function handleCreate(
  res: ServerResponse,
  deps: ManagerApiDeps,
  orgId: string,
  userId: string,
  body: unknown
): Promise<boolean> {
  const { name } = body as { name?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > NAME_MAX) {
    sendJson(res, 400, { error: `name (1–${NAME_MAX} chars) is required` });
    return true;
  }
  const { managerId } = await deps.store.createManager(orgId, name.trim());
  await recordAudit(deps, orgId, userId, { action: 'manager.create', target: managerId, payload: { name: name.trim() } });
  sendJson(res, 200, { ok: true, managerId });
  return true;
}

/** POST /api/orgs/:orgId/managers/:managerId/identity/shortcut — seal the manager's Shortcut token +
 *  set its member id/handle. WRITE-ONLY (returns a fingerprint, never the token). */
async function handleSetIdentity(
  res: ServerResponse,
  deps: ManagerApiDeps,
  orgId: string,
  userId: string,
  managerId: string,
  body: unknown
): Promise<boolean> {
  // No master key → cannot seal; refuse rather than store an unsealable token.
  if (!deps.masterKey) {
    deps.logger?.error('manager-api: TASCA_SECRET_STORE_KEY not configured — cannot seal');
    sendJson(res, 503, { error: 'credential storage is not configured on this server' });
    return true;
  }
  // The manager must exist IN THIS org — a 404 (not 403) so a caller can't probe other orgs' managers.
  if (!(await deps.store.getManager(orgId, managerId))) {
    sendJson(res, 404, { error: 'no such manager in this organization' });
    return true;
  }

  const { memberId, token, handle } = body as { memberId?: unknown; token?: unknown; handle?: unknown };
  if (typeof memberId !== 'string' || memberId.trim().length === 0 || memberId.trim().length > MEMBER_ID_MAX) {
    sendJson(res, 400, { error: `memberId (1–${MEMBER_ID_MAX} chars) is required` });
    return true;
  }
  if (typeof token !== 'string' || token.trim().length === 0 || token.trim().length > TOKEN_MAX) {
    sendJson(res, 400, { error: `token (1–${TOKEN_MAX} chars) is required` });
    return true;
  }
  if (handle !== undefined && (typeof handle !== 'string' || handle.length > HANDLE_MAX)) {
    sendJson(res, 400, { error: `handle must be a string (≤${HANDLE_MAX} chars)` });
    return true;
  }
  const trimmedMemberId = memberId.trim();
  const trimmedToken = token.trim();

  // Seal the token (never persist plaintext) + a non-reversible fingerprint in the MANAGER hash domain
  // (so it can never collide with an agent/vendor/connection fingerprint).
  const sealed = sealVendorKey(trimmedToken, deps.masterKey);
  const fingerprint = fingerprintManagerKey('shortcut', trimmedToken);

  // The store writes the manager-row identity FIRST (the load-bearing dedupe projection), then the
  // sealed credential — in one transaction (mirrors the SC-3 ordering lesson).
  await deps.store.setManagerShortcutIdentity(
    orgId,
    managerId,
    trimmedMemberId,
    handle ?? null,
    sealed,
    fingerprint,
    userId === '(dev)' ? null : userId
  );

  // Governance trail: record the set with the fingerprint — NEVER the token. Best-effort.
  await recordAudit(deps, orgId, userId, {
    action: 'manager.identity.shortcut.set',
    target: managerId,
    payload: { memberId: trimmedMemberId, fingerprint },
  });

  // WRITE-ONLY response: ok + fingerprint, never the token.
  sendJson(res, 200, { ok: true, managerId, fingerprint });
  return true;
}

/** POST /api/orgs/:orgId/projects/:projectId/manager — assign a manager to a project (both in-org). */
async function handleAssignProject(
  res: ServerResponse,
  deps: ManagerApiDeps,
  orgId: string,
  userId: string,
  projectId: string,
  body: unknown
): Promise<boolean> {
  const { managerId } = body as { managerId?: unknown };
  if (typeof managerId !== 'string' || managerId.trim().length === 0) {
    sendJson(res, 400, { error: 'managerId is required' });
    return true;
  }
  const trimmedManagerId = managerId.trim();
  // The store VERIFIES both the project and the manager are in THIS org — a foreign-org project id OR
  // manager id is indistinguishably 'not_found' (404), so there is no cross-tenant existence oracle.
  const outcome = await deps.store.setProjectManager(orgId, projectId, trimmedManagerId);
  if (outcome !== 'ok') {
    sendJson(res, 404, { error: 'no such project or manager in this organization' });
    return true;
  }
  await recordAudit(deps, orgId, userId, {
    action: 'project.manager.assign',
    target: projectId,
    payload: { managerId: trimmedManagerId },
  });
  sendJson(res, 200, { ok: true });
  return true;
}

/** Best-effort governance-audit write (mirrors agent-identity-api / connection-api): the op already
 *  succeeded, so a write failure is logged, never failing the response. NEVER pass a raw token. */
async function recordAudit(
  deps: ManagerApiDeps,
  orgId: string,
  userId: string,
  e: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.recordGovernanceAudit(orgId, { actorUserId: userId, ...e });
  } catch (err) {
    deps.logger?.error('manager-api: governance audit write failed', {
      orgId,
      action: e.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
