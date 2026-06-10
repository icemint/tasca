// The org-management API (slice 5a — onboarding): list the user's orgs, create a new org, and
// switch the active org. SESSION-gated (the same verifier as the read/write API); the POSTs are
// CSRF-protected (double-submit). Deliberately NOT resolveOrg-gated — these operate on the
// MEMBERSHIP layer (which orgs the user belongs to / which is active), not on org-scoped tenant
// data, so they must work regardless of — and in order to change — the user's active org.
//
// Switching the active org is an AUTHZ'd action: you can only switch to an org you are a member of
// (isMember). Combined with resolveOrg reading the VALIDATED active org, this makes the active org a
// real tenant boundary — a user can never point their session at an org they don't belong to.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import type { OrgMembershipRepo } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';

export interface OrgApiDeps {
  membership: OrgMembershipRepo;
  /** Verify the request's session (same contract as the read/write API). */
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /** Fail-closed escape hatch: no verifier wired → 503 unless explicitly opened (dev/tests only). */
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

/**
 * Handle an org-management request. Returns `true` when it owned the request, `false` otherwise
 * (so the caller falls through to its other handlers / 404). Owns GET+POST /api/orgs and
 * POST /api/active-org.
 */
export async function orgApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OrgApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const method = req.method;
  const isOrgs = path === '/api/orgs';
  const isActive = path === '/api/active-org';
  if (!isOrgs && !isActive) return false;
  if (isActive && method !== 'POST') return false;
  if (isOrgs && method !== 'GET' && method !== 'POST') return false;

  // ── session enforcement (mirrors the read/write API) ────────────────────────
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('org-api: session verification threw', { err: String(err) });
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

  try {
    // GET /api/orgs — the switcher list (the user's orgs + roles + which is active). No CSRF (read).
    if (isOrgs && method === 'GET') {
      sendJson(res, 200, { orgs: await deps.membership.listOrgsForUser(userId) });
      return true;
    }

    // ── mutations: CSRF double-submit ─────────────────────────────────────────
    if (!verifyCsrf(req)) {
      sendJson(res, 403, { error: 'missing or invalid CSRF token' });
      return true;
    }

    // POST /api/orgs — create a new org (the caller becomes its owner; active switches to it).
    if (isOrgs && method === 'POST') {
      const body = await readBody(req, res);
      if (body === undefined) return true;
      const name = (body as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
        sendJson(res, 400, { error: 'name (1–100 chars) is required' });
        return true;
      }
      const orgId = await deps.membership.createOrg(userId, name.trim());
      sendJson(res, 200, { id: orgId });
      return true;
    }

    // POST /api/active-org — switch the active org. AUTHZ: only to an org you are a member of.
    const body = await readBody(req, res);
    if (body === undefined) return true;
    const orgId = (body as { orgId?: unknown }).orgId;
    if (typeof orgId !== 'string' || orgId.length === 0) {
      sendJson(res, 400, { error: 'orgId is required' });
      return true;
    }
    if (!(await deps.membership.isMember(userId, orgId))) {
      // Not a member → reject. You can never set your active org to a tenant you don't belong to.
      sendJson(res, 403, { error: 'not a member of that org' });
      return true;
    }
    await deps.membership.setActiveOrg(userId, orgId);
    sendJson(res, 200, { ok: true, activeOrgId: orgId });
    return true;
  } catch (err) {
    deps.logger?.error('org-api: handler failed', { path, err: String(err) });
    sendJson(res, 500, { error: 'internal error' });
    return true;
  }
}

/** Read+parse the JSON body; on a bad body send 400 and return undefined (caller stops). */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  try {
    return await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return undefined;
  }
}
