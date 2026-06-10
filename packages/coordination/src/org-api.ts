// The org-management API (slice 5a + 5b — onboarding): list the user's orgs, create a new org,
// switch the active org, and manage the active org's MEMBERS (list/add/change-role/remove).
// SESSION-gated; the POSTs/DELETEs are CSRF-protected (double-submit). Deliberately NOT
// resolveOrg-gated at the handler entry — these operate on the MEMBERSHIP layer (which orgs the
// user belongs to / which is active), not on org-scoped tenant data. The member-management routes
// DO resolve the user's active org (that's the org they manage) and require the OWNER role there.
//
// Two authz layers, both server-side + additive (slice 5b):
//   - membership (you must be in the active org)             — the tenant boundary
//   - role (only an OWNER may add/change-role/remove members) — authority within the org
// Switching the active org is isMember-authz'd; member management is owner-authz'd. Last-owner
// protection (in the repo) refuses to leave an org with zero owners.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type OrgMembershipRepo, type OrgRole, type MemberWriteOutcome } from './membership';
import type { OrgRosterRepo } from './roster';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';

export interface OrgApiDeps {
  membership: OrgMembershipRepo;
  /** The org roster (slice 5d): hire/unhire managed agents into the active org. */
  roster: OrgRosterRepo;
  /** Verify the request's session (same contract as the read/write API). */
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /** Fail-closed escape hatch: no verifier wired → 503 unless explicitly opened (dev/tests only). */
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];
const isRole = (v: unknown): v is OrgRole => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

type Route =
  | { kind: 'list-orgs' }
  | { kind: 'create-org' }
  | { kind: 'switch-org' }
  | { kind: 'list-members' }
  | { kind: 'add-member' }
  | { kind: 'set-role'; userId: string }
  | { kind: 'remove-member'; userId: string }
  | { kind: 'list-agents' }
  | { kind: 'hire-agent' }
  | { kind: 'unhire-agent'; agentId: string };

function matchRoute(method: string, path: string): Route | null {
  if (path === '/api/orgs') {
    if (method === 'GET') return { kind: 'list-orgs' };
    if (method === 'POST') return { kind: 'create-org' };
    return null;
  }
  if (path === '/api/active-org') return method === 'POST' ? { kind: 'switch-org' } : null;
  if (path === '/api/orgs/members') {
    if (method === 'GET') return { kind: 'list-members' };
    if (method === 'POST') return { kind: 'add-member' };
    return null;
  }
  if (path === '/api/orgs/agents') {
    if (method === 'GET') return { kind: 'list-agents' };
    if (method === 'POST') return { kind: 'hire-agent' };
    return null;
  }
  const agentM = /^\/api\/orgs\/agents\/([^/]+)$/.exec(path);
  if (agentM && method === 'DELETE') return { kind: 'unhire-agent', agentId: decodeURIComponent(agentM[1]!) };
  const roleM = /^\/api\/orgs\/members\/([^/]+)\/role$/.exec(path);
  if (roleM && method === 'POST') return { kind: 'set-role', userId: decodeURIComponent(roleM[1]!) };
  const memM = /^\/api\/orgs\/members\/([^/]+)$/.exec(path);
  if (memM && method === 'DELETE') return { kind: 'remove-member', userId: decodeURIComponent(memM[1]!) };
  return null;
}

/** Map a member-management outcome to an HTTP response. */
function sendMemberOutcome(res: ServerResponse, outcome: MemberWriteOutcome): void {
  if (outcome === 'ok') return sendJson(res, 200, { ok: true });
  if (outcome === 'not_found') return sendJson(res, 404, { error: 'no such user/member' });
  if (outcome === 'already_member') return sendJson(res, 409, { error: 'already a member', code: 'already_member' });
  // last_owner — refused to leave the org without an owner.
  return sendJson(res, 409, { error: 'cannot remove or demote the last owner', code: 'last_owner' });
}

export async function orgApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OrgApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

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
    // GET /api/orgs — the switcher list (the user's orgs). No CSRF (read).
    if (route.kind === 'list-orgs') {
      sendJson(res, 200, { orgs: await deps.membership.listOrgsForUser(userId) });
      return true;
    }
    // GET /api/orgs/members — the active org's team (any member may see it).
    if (route.kind === 'list-members') {
      const orgId = await deps.membership.getActiveOrg(userId);
      if (orgId === null) {
        sendJson(res, 403, { error: 'no organization membership' });
        return true;
      }
      sendJson(res, 200, { members: await deps.membership.listMembers(orgId) });
      return true;
    }
    // GET /api/orgs/agents — the active org's hired roster (any member may see it).
    if (route.kind === 'list-agents') {
      const orgId = await deps.membership.getActiveOrg(userId);
      if (orgId === null) {
        sendJson(res, 403, { error: 'no organization membership' });
        return true;
      }
      sendJson(res, 200, { agents: await deps.roster.listHired(orgId) });
      return true;
    }

    // ── mutations: CSRF double-submit ─────────────────────────────────────────
    if (!verifyCsrf(req)) {
      sendJson(res, 403, { error: 'missing or invalid CSRF token' });
      return true;
    }

    // Personal actions (no role needed): create your own org / switch your active org.
    if (route.kind === 'create-org') {
      const body = await readBody(req, res);
      if (body === undefined) return true;
      const name = (body as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
        sendJson(res, 400, { error: 'name (1–100 chars) is required' });
        return true;
      }
      sendJson(res, 200, { id: await deps.membership.createOrg(userId, name.trim()) });
      return true;
    }
    if (route.kind === 'switch-org') {
      const body = await readBody(req, res);
      if (body === undefined) return true;
      const orgId = (body as { orgId?: unknown }).orgId;
      if (typeof orgId !== 'string' || orgId.length === 0) {
        sendJson(res, 400, { error: 'orgId is required' });
        return true;
      }
      // AUTHZ: only to an org you are a member of — never point your session at a foreign tenant.
      if (!(await deps.membership.isMember(userId, orgId))) {
        sendJson(res, 403, { error: 'not a member of that org' });
        return true;
      }
      await deps.membership.setActiveOrg(userId, orgId);
      sendJson(res, 200, { ok: true, activeOrgId: orgId });
      return true;
    }

    const orgId = await deps.membership.getActiveOrg(userId);
    if (orgId === null) {
      sendJson(res, 403, { error: 'no organization membership' });
      return true;
    }
    const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access

    // ── roster management on the ACTIVE org: ADMIN+ (slice 5b: roster = admin) ──
    // Hiring/unhiring agents is a roster write — gate on the endpoint (a member calling → 403),
    // server-side. The org_agent join is the tenant boundary on the candidate set, so only an
    // admin+ can change which agents serve this org's tasks.
    if (route.kind === 'hire-agent' || route.kind === 'unhire-agent') {
      if (callerRole === null || !atLeast(callerRole, 'admin')) {
        sendJson(res, 403, { error: 'admin role required to manage the roster' });
        return true;
      }
      if (route.kind === 'hire-agent') {
        const body = await readBody(req, res);
        if (body === undefined) return true;
        const agentId = (body as { agentId?: unknown }).agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          sendJson(res, 400, { error: 'agentId is required' });
          return true;
        }
        const outcome = await deps.roster.hire(orgId, agentId);
        if (outcome === 'ok') return sendJson(res, 200, { ok: true }), true;
        if (outcome === 'not_found') return sendJson(res, 404, { error: 'no such agent' }), true;
        return sendJson(res, 409, { error: 'already hired', code: 'already_hired' }), true;
      }
      // unhire-agent
      const removed = await deps.roster.unhire(orgId, route.agentId);
      sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'agent not hired by this org' });
      return true;
    }

    // ── member management on the ACTIVE org: OWNER only (slice 5b) ─────────────
    // The role gate, server-side on the endpoint (not the UI): a member calling this → 403. A user
    // cannot self-promote — changing roles requires OWNER, which a member/admin does not have.
    if (callerRole !== 'owner') {
      sendJson(res, 403, { error: 'only an owner may manage members' });
      return true;
    }

    if (route.kind === 'add-member') {
      const body = await readBody(req, res);
      if (body === undefined) return true;
      const { email, role } = body as { email?: unknown; role?: unknown };
      if (typeof email !== 'string' || email.length === 0) {
        sendJson(res, 400, { error: 'email is required' });
        return true;
      }
      if (!isRole(role)) {
        sendJson(res, 400, { error: 'role must be one of ' + ROLES.join(', ') });
        return true;
      }
      sendMemberOutcome(res, await deps.membership.addMemberByEmail(orgId, email, role));
      return true;
    }
    if (route.kind === 'set-role') {
      const body = await readBody(req, res);
      if (body === undefined) return true;
      const role = (body as { role?: unknown }).role;
      if (!isRole(role)) {
        sendJson(res, 400, { error: 'role must be one of ' + ROLES.join(', ') });
        return true;
      }
      sendMemberOutcome(res, await deps.membership.setMemberRole(orgId, route.userId, role));
      return true;
    }
    // remove-member
    sendMemberOutcome(res, await deps.membership.removeMember(orgId, route.userId));
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
