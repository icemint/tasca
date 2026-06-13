// The project API (slice Project-A): list the active org's projects + switch the active project.
// A project is a finer filter WITHIN the org boundary (org_id stays the tenant scope), so these
// routes resolve the user's ACTIVE ORG and operate on its projects — never another tenant's.
//
// SESSION-gated; the POST is CSRF-protected (double-submit), mirroring org-api. Deliberately NOT
// single-tenant-gated: projects exist in every edition (a single-tenant instance still has 1+
// project), so unlike the org-multiplicity routes these are always live.
//
// Switching the active project is VALIDATED in the store: a foreign-org or unknown project is
// rejected (403/404), never activated — a user can never point their task view at another tenant's
// project.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import type { CoordinationStore } from './store';
import type { OrgMembershipReader } from './resolve-org';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';

export interface ProjectApiDeps {
  /** The project read/switch surface — the org's project list + the validated active-project switch. */
  store: Pick<CoordinationStore, 'listProjects' | 'setActiveProject'>;
  /** Resolves the user's active org (the tenant boundary the project list is scoped to). */
  membership: OrgMembershipReader;
  /** Verify the request's session (same contract as the read/org API). */
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /** Fail-closed escape hatch: no verifier wired → 503 unless explicitly opened (dev/tests only). */
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

type Route = { kind: 'list-projects' } | { kind: 'switch-project' };

function matchRoute(method: string, path: string): Route | null {
  if (path === '/api/projects') return method === 'GET' ? { kind: 'list-projects' } : null;
  if (path === '/api/active-project') return method === 'POST' ? { kind: 'switch-project' } : null;
  return null;
}

export async function projectApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProjectApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors the read/org API) ──────────────────────────
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('project-api: session verification threw', { err: String(err) });
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
    // GET /api/projects — the active org's projects (any member). No CSRF (read).
    if (route.kind === 'list-projects') {
      const orgId = await deps.membership.getActiveOrg(userId);
      if (orgId === null) {
        sendJson(res, 403, { error: 'no organization membership' });
        return true;
      }
      sendJson(res, 200, { projects: await deps.store.listProjects(orgId) });
      return true;
    }

    // POST /api/active-project — switch the active project. CSRF double-submit.
    if (!verifyCsrf(req)) {
      sendJson(res, 403, { error: 'missing or invalid CSRF token' });
      return true;
    }
    const body = await readBody(req, res);
    if (body === undefined) return true;
    const projectId = (body as { projectId?: unknown }).projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      sendJson(res, 400, { error: 'projectId is required' });
      return true;
    }
    // The store VALIDATES the project exists IN the user's active org — a foreign-org id and a
    // nonexistent one are indistinguishably 'not_found' (404), so there is no cross-tenant existence
    // oracle (project ids are deterministic). A foreign tenant's project is never activated.
    const outcome = await deps.store.setActiveProject(userId, projectId);
    if (outcome === 'ok') {
      sendJson(res, 200, { ok: true, activeProjectId: projectId });
      return true;
    }
    sendJson(res, 404, { error: 'no such project' });
    return true;
  } catch (err) {
    deps.logger?.error('project-api: handler failed', { path, err: String(err) });
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
