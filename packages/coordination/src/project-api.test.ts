import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectApiHandler, type ProjectApiDeps } from './project-api';
import type { ProjectSummary } from './store';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

/** A project store fake: per-org projects + a validated active-project switch (foreign org rejected). */
class FakeProjectStore {
  // org → its projects
  projects: Record<string, ProjectSummary[]> = {};
  // the org each project belongs to (for the foreign-org rejection)
  projectOrg: Record<string, string> = {};
  active: Record<string, string> = {};
  // the user's active org, the boundary listProjects is scoped to
  activeOrgOf = 'org_a';

  async listProjects(orgId: string): Promise<ProjectSummary[]> {
    return this.projects[orgId] ?? [];
  }
  async getActiveProject(userId: string): Promise<string | null> {
    return this.active[userId] ?? null;
  }
  async setActiveProject(userId: string, projectId: string): Promise<'ok' | 'not_found'> {
    // A foreign-org project is indistinguishable from a nonexistent one — both 'not_found' (no oracle).
    const org = this.projectOrg[projectId];
    if (org === undefined || org !== this.activeOrgOf) return 'not_found';
    this.active[userId] = projectId;
    return 'ok';
  }
  async clearActiveProject(userId: string): Promise<void> {
    delete this.active[userId];
  }
}

const membershipFor = (org: string | null) => ({ async getActiveOrg() { return org; } });

function fakeReq(
  method: string,
  url: string,
  opts: { headers?: Record<string, string | string[]>; body?: string } = {}
): IncomingMessage {
  const body = opts.body;
  const req = {
    method,
    url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

interface Captured {
  statusCode: number;
  body: string;
}
function fakeRes(): { captured: Captured; res: ServerResponse } {
  const captured: Captured = { statusCode: 0, body: '' };
  const res = {
    writeHead(code: number) {
      captured.statusCode = code;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

const TOK = 'a'.repeat(64);
const csrf = (extra: Record<string, string | string[]> = {}) => ({
  cookie: `tasca_csrf=${TOK}`,
  'x-csrf-token': TOK,
  ...extra,
});

function deps(store: FakeProjectStore, org: string | null = 'org_a', over: Partial<ProjectApiDeps> = {}): ProjectApiDeps {
  return { store, membership: membershipFor(org), verifySession: () => ({ userId: 'u1' }), ...over };
}

async function run(d: ProjectApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await projectApiHandler(req, res, d);
  return { owned, ...captured };
}

describe('projectApiHandler — routing + ownership', () => {
  it('does not own non-project paths / wrong methods', async () => {
    const s = new FakeProjectStore();
    expect((await run(deps(s), fakeReq('GET', '/api/tasks'))).owned).toBe(false);
    expect((await run(deps(s), fakeReq('GET', '/api/active-project'))).owned).toBe(false); // switch is POST-only
    expect((await run(deps(s), fakeReq('POST', '/api/projects'))).owned).toBe(false); // list is GET-only
  });
});

describe('GET /api/projects — the active org’s projects', () => {
  it('returns ONLY the active org’s projects', async () => {
    const s = new FakeProjectStore();
    s.projects = {
      org_a: [{ id: 'p1', name: 'a', repoRef: 'owner/a' }],
      org_b: [{ id: 'p9', name: 'foreign', repoRef: 'x/y' }],
    };
    const r = await run(deps(s, 'org_a'), fakeReq('GET', '/api/projects'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({
      projects: [{ id: 'p1', name: 'a', repoRef: 'owner/a' }],
      activeProjectId: null, // nothing selected → the "all projects" view
    });
  });

  it('returns the user’s active project so the switcher can mark it', async () => {
    const s = new FakeProjectStore();
    s.projects = { org_a: [{ id: 'p1', name: 'a', repoRef: 'owner/a' }] };
    s.active = { u1: 'p1' };
    const r = await run(deps(s, 'org_a'), fakeReq('GET', '/api/projects'));
    expect(JSON.parse(r.body).activeProjectId).toBe('p1');
  });

  it('403 when the user has no org membership', async () => {
    const r = await run(deps(new FakeProjectStore(), null), fakeReq('GET', '/api/projects'));
    expect(r.statusCode).toBe(403);
  });
});

describe('auth + CSRF gates', () => {
  it('401 without a valid session', async () => {
    const r = await run(deps(new FakeProjectStore(), 'org_a', { verifySession: () => null }), fakeReq('GET', '/api/projects'));
    expect(r.statusCode).toBe(401);
  });
  it('503 when no verifier is wired and not explicitly opened', async () => {
    const r = await run({ store: new FakeProjectStore(), membership: membershipFor('org_a') }, fakeReq('GET', '/api/projects'));
    expect(r.statusCode).toBe(503);
  });
  it('POST /api/active-project without CSRF → 403, nothing activated', async () => {
    const s = new FakeProjectStore();
    s.projectOrg = { p1: 'org_a' };
    const r = await run(deps(s), fakeReq('POST', '/api/active-project', { body: JSON.stringify({ projectId: 'p1' }) }));
    expect(r.statusCode).toBe(403);
    expect(s.active.u1).toBeUndefined();
  });

  it('DELETE /api/active-project without CSRF → 403, nothing cleared', async () => {
    const s = new FakeProjectStore();
    s.active = { u1: 'p1' };
    const r = await run(deps(s), fakeReq('DELETE', '/api/active-project'));
    expect(r.statusCode).toBe(403);
    expect(s.active.u1).toBe('p1'); // untouched
  });

  it('DELETE /api/active-project requires a session (401)', async () => {
    const r = await run(
      deps(new FakeProjectStore(), 'org_a', { verifySession: () => null }),
      fakeReq('DELETE', '/api/active-project', { headers: csrf() })
    );
    expect(r.statusCode).toBe(401);
  });
});

describe('DELETE /api/active-project — clear to the “all projects” view', () => {
  it('clears the selection and reports activeProjectId:null', async () => {
    const s = new FakeProjectStore();
    s.active = { u1: 'p1' };
    const r = await run(deps(s), fakeReq('DELETE', '/api/active-project', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, activeProjectId: null });
    expect(s.active.u1).toBeUndefined();
  });

  it('is idempotent — clearing with no selection still succeeds', async () => {
    const s = new FakeProjectStore();
    const r = await run(deps(s), fakeReq('DELETE', '/api/active-project', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, activeProjectId: null });
  });
});

describe('POST /api/active-project — switch (store-validated in-org)', () => {
  it('activates an in-org project', async () => {
    const s = new FakeProjectStore();
    s.projectOrg = { p1: 'org_a' };
    s.activeOrgOf = 'org_a';
    const r = await run(deps(s), fakeReq('POST', '/api/active-project', { headers: csrf(), body: JSON.stringify({ projectId: 'p1' }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, activeProjectId: 'p1' });
    expect(s.active.u1).toBe('p1');
  });

  it('404 (NOT 403) for a FOREIGN-org project — same outcome as unknown, so no existence oracle; never activated', async () => {
    const s = new FakeProjectStore();
    s.projectOrg = { pforeign: 'org_b' };
    s.activeOrgOf = 'org_a';
    const r = await run(deps(s), fakeReq('POST', '/api/active-project', { headers: csrf(), body: JSON.stringify({ projectId: 'pforeign' }) }));
    expect(r.statusCode).toBe(404); // indistinguishable from an unknown id (below)
    expect(s.active.u1).toBeUndefined();
  });

  it('404 for an unknown project (byte-identical to the foreign-org case above)', async () => {
    const s = new FakeProjectStore();
    const r = await run(deps(s), fakeReq('POST', '/api/active-project', { headers: csrf(), body: JSON.stringify({ projectId: 'ghost' }) }));
    expect(r.statusCode).toBe(404);
  });

  it('400 on a missing projectId (never reaches the store)', async () => {
    const s = new FakeProjectStore();
    const r = await run(deps(s), fakeReq('POST', '/api/active-project', { headers: csrf(), body: JSON.stringify({}) }));
    expect(r.statusCode).toBe(400);
    expect(s.active.u1).toBeUndefined();
  });
});
