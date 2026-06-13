import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { orgApiHandler, type OrgApiDeps } from './org-api';
import type { OrgMembershipRepo, OrgRole, OrgMemberSummary, MemberWriteOutcome, UserOrgSummary } from './membership';
import type { OrgRosterRepo, HiredAgent, HireOutcome } from './roster';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

class FakeOrgRepo implements OrgMembershipRepo {
  orgs: UserOrgSummary[] = [];
  private members = new Set<string>();
  created: Array<{ userId: string; name: string }> = [];
  switched: Array<{ userId: string; orgId: string }> = [];
  // role of the CALLER (userId 'u1') in the active org — drives the 5b owner gate.
  callerRole: OrgRole = 'owner';
  membersList: OrgMemberSummary[] = [];
  added: Array<{ orgId: string; email: string; role: OrgRole }> = [];
  roleChanges: Array<{ orgId: string; userId: string; role: OrgRole }> = [];
  removed: Array<{ orgId: string; userId: string }> = [];
  nextMemberOutcome: MemberWriteOutcome = 'ok';
  orgName: string | null = 'Acme';
  renames: Array<{ orgId: string; name: string }> = [];

  addMember(userId: string, orgId: string) {
    this.members.add(`${userId}:${orgId}`);
  }
  async getActiveOrg() {
    return 'org_default';
  }
  async isMember(userId: string, orgId: string) {
    return this.members.has(`${userId}:${orgId}`);
  }
  async listOrgsForUser() {
    return this.orgs;
  }
  async ensurePersonalOrg() {
    return 'org_default';
  }
  async ensureInstanceMembership() {
    return undefined;
  }
  async createOrg(userId: string, name: string) {
    this.created.push({ userId, name });
    return 'org-new';
  }
  async setActiveOrg(userId: string, orgId: string) {
    this.switched.push({ userId, orgId });
  }
  async getRole() {
    return this.callerRole;
  }
  async listMembers() {
    return this.membersList;
  }
  async addMemberByEmail(orgId: string, email: string, role: OrgRole) {
    this.added.push({ orgId, email, role });
    return this.nextMemberOutcome;
  }
  async setMemberRole(orgId: string, userId: string, role: OrgRole) {
    this.roleChanges.push({ orgId, userId, role });
    return this.nextMemberOutcome;
  }
  async removeMember(orgId: string, userId: string) {
    this.removed.push({ orgId, userId });
    return this.nextMemberOutcome;
  }
  async getOrgName() {
    return this.orgName;
  }
  async renameOrg(orgId: string, name: string) {
    this.renames.push({ orgId, name });
    this.orgName = name;
  }
}

class FakeRoster implements OrgRosterRepo {
  hired: HiredAgent[] = [];
  hires: Array<{ orgId: string; agentId: string }> = [];
  unhires: Array<{ orgId: string; agentId: string }> = [];
  nextHireOutcome: HireOutcome = 'ok';
  nextUnhireRemoved = true;

  async hire(orgId: string, agentId: string) {
    this.hires.push({ orgId, agentId });
    return this.nextHireOutcome;
  }
  async unhire(orgId: string, agentId: string) {
    this.unhires.push({ orgId, agentId });
    return this.nextUnhireRemoved;
  }
  async listHired() {
    return this.hired;
  }
  async hiredAgentIds() {
    return this.hired.map((h) => h.agentId);
  }
  async isHired(_orgId: string, agentId: string) {
    return this.hired.some((h) => h.agentId === agentId);
  }
  async findHiredAgentByName(_orgId: string, name: string) {
    return this.hired.find((h) => h.name.toLowerCase() === name.toLowerCase())?.agentId ?? null;
  }
}

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
    setHeader() {},
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

function deps(repo: FakeOrgRepo, over: Partial<OrgApiDeps> = {}): OrgApiDeps {
  return { membership: repo, roster: new FakeRoster(), verifySession: () => ({ userId: 'u1' }), ...over };
}

async function run(d: OrgApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await orgApiHandler(req, res, d);
  return { owned, ...captured };
}

describe('orgApiHandler — routing + ownership', () => {
  it('does not own non-org paths', async () => {
    const repo = new FakeOrgRepo();
    expect((await run(deps(repo), fakeReq('GET', '/api/tasks'))).owned).toBe(false);
    expect((await run(deps(repo), fakeReq('PUT', '/api/orgs'))).owned).toBe(false); // wrong method
    expect((await run(deps(repo), fakeReq('GET', '/api/active-org'))).owned).toBe(false); // switch is POST-only
  });
});

describe('GET /api/orgs — the switcher list', () => {
  it('returns the user’s orgs', async () => {
    const repo = new FakeOrgRepo();
    repo.orgs = [{ id: 'o1', name: 'One', role: 'owner', active: true }];
    const r = await run(deps(repo), fakeReq('GET', '/api/orgs'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ orgs: [{ id: 'o1', name: 'One', role: 'owner', active: true }] });
  });
});

describe('auth + CSRF gates', () => {
  it('401 without a valid session', async () => {
    const r = await run(deps(new FakeOrgRepo(), { verifySession: () => null }), fakeReq('GET', '/api/orgs'));
    expect(r.statusCode).toBe(401);
  });
  it('503 when no verifier is wired and not explicitly opened', async () => {
    const r = await run({ membership: new FakeOrgRepo(), roster: new FakeRoster() }, fakeReq('GET', '/api/orgs'));
    expect(r.statusCode).toBe(503);
  });
  it('POST /api/orgs without CSRF → 403, no org created', async () => {
    const repo = new FakeOrgRepo();
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs', { body: JSON.stringify({ name: 'X' }) }));
    expect(r.statusCode).toBe(403);
    expect(repo.created).toEqual([]);
  });
});

describe('POST /api/orgs — create', () => {
  it('creates an org owned by the user', async () => {
    const repo = new FakeOrgRepo();
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs', { headers: csrf(), body: JSON.stringify({ name: 'Acme' }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ id: 'org-new' });
    expect(repo.created).toEqual([{ userId: 'u1', name: 'Acme' }]);
  });
  it('400 on a missing/blank name (never reaches the repo)', async () => {
    const repo = new FakeOrgRepo();
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs', { headers: csrf(), body: JSON.stringify({ name: '  ' }) }));
    expect(r.statusCode).toBe(400);
    expect(repo.created).toEqual([]);
  });
});

describe('POST /api/active-org — switch (authz by membership)', () => {
  it('switches when the user IS a member', async () => {
    const repo = new FakeOrgRepo();
    repo.addMember('u1', 'o-mine');
    const r = await run(deps(repo), fakeReq('POST', '/api/active-org', { headers: csrf(), body: JSON.stringify({ orgId: 'o-mine' }) }));
    expect(r.statusCode).toBe(200);
    expect(repo.switched).toEqual([{ userId: 'u1', orgId: 'o-mine' }]);
  });

  it('REJECTS (403) switching to an org the user is NOT a member of — and never switches', async () => {
    const repo = new FakeOrgRepo(); // u1 is a member of nothing
    const r = await run(deps(repo), fakeReq('POST', '/api/active-org', { headers: csrf(), body: JSON.stringify({ orgId: 'someone-elses-org' }) }));
    expect(r.statusCode).toBe(403);
    expect(repo.switched).toEqual([]); // the active org was NOT changed
  });

  it('400 when orgId is missing', async () => {
    const repo = new FakeOrgRepo();
    const r = await run(deps(repo), fakeReq('POST', '/api/active-org', { headers: csrf(), body: JSON.stringify({}) }));
    expect(r.statusCode).toBe(400);
    expect(repo.switched).toEqual([]);
  });
});

describe('member management — OWNER-gated (slice 5b)', () => {
  it('GET /api/orgs/members lists the team (any member)', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    repo.membersList = [{ userId: 'u1', email: 'a@x', displayName: 'A', role: 'owner' }];
    const r = await run(deps(repo), fakeReq('GET', '/api/orgs/members'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).members).toHaveLength(1);
  });

  it('an OWNER can add a member by email + role', async () => {
    const repo = new FakeOrgRepo(); // callerRole defaults to owner
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs/members', { headers: csrf(), body: JSON.stringify({ email: 'new@x', role: 'admin' }) }));
    expect(r.statusCode).toBe(200);
    expect(repo.added).toEqual([{ orgId: 'org_default', email: 'new@x', role: 'admin' }]);
  });

  it('PRIV-ESC BLOCK: a MEMBER cannot add a member (403) — the gate is on the endpoint, not the UI', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs/members', { headers: csrf(), body: JSON.stringify({ email: 'evil@x', role: 'owner' }) }));
    expect(r.statusCode).toBe(403);
    expect(repo.added).toEqual([]); // never reached the repo
  });

  it('PRIV-ESC BLOCK: a MEMBER cannot change a role (403) — no self-promotion path', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs/members/u1/role', { headers: csrf(), body: JSON.stringify({ role: 'owner' }) }));
    expect(r.statusCode).toBe(403);
    expect(repo.roleChanges).toEqual([]);
  });

  it('an ADMIN cannot manage members either (owner-only) — 403', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'admin';
    const r = await run(deps(repo), fakeReq('DELETE', '/api/orgs/members/u2', { headers: csrf() }));
    expect(r.statusCode).toBe(403);
    expect(repo.removed).toEqual([]);
  });

  it('an OWNER changes a role; a last-owner refusal maps to 409', async () => {
    const repo = new FakeOrgRepo();
    const ok = await run(deps(repo), fakeReq('POST', '/api/orgs/members/u2/role', { headers: csrf(), body: JSON.stringify({ role: 'admin' }) }));
    expect(ok.statusCode).toBe(200);
    expect(repo.roleChanges).toEqual([{ orgId: 'org_default', userId: 'u2', role: 'admin' }]);

    const repo2 = new FakeOrgRepo();
    repo2.nextMemberOutcome = 'last_owner';
    const refused = await run(deps(repo2), fakeReq('DELETE', '/api/orgs/members/u-owner', { headers: csrf() }));
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body).code).toBe('last_owner');
  });

  it('400 on an invalid role value (never reaches the repo)', async () => {
    const repo = new FakeOrgRepo();
    const r = await run(deps(repo), fakeReq('POST', '/api/orgs/members', { headers: csrf(), body: JSON.stringify({ email: 'x@x', role: 'superuser' }) }));
    expect(r.statusCode).toBe(400);
    expect(repo.added).toEqual([]);
  });
});

describe('workspace settings — name (slice 3.5-B.2)', () => {
  it('GET /api/org returns the active org id + name + the caller’s role (any member)', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    repo.orgName = 'Acme';
    const r = await run(deps(repo), fakeReq('GET', '/api/org'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ id: 'org_default', name: 'Acme', role: 'member' });
  });

  it('POST /api/org/name renames the active org for an ADMIN', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'admin';
    const r = await run(deps(repo), fakeReq('POST', '/api/org/name', { headers: csrf(), body: JSON.stringify({ name: '  Globex  ' }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, name: 'Globex' }); // trimmed
    expect(repo.renames).toEqual([{ orgId: 'org_default', name: 'Globex' }]);
  });

  it('PRIV-ESC BLOCK: a MEMBER cannot rename the workspace (403), no rename recorded', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    const r = await run(deps(repo), fakeReq('POST', '/api/org/name', { headers: csrf(), body: JSON.stringify({ name: 'Hijack' }) }));
    expect(r.statusCode).toBe(403);
    expect(repo.renames).toEqual([]);
  });

  it('rename requires CSRF (403) and a non-empty / ≤80-char name (400) — never reaches the repo', async () => {
    const noCsrf = new FakeOrgRepo();
    const rCsrf = await run(deps(noCsrf), fakeReq('POST', '/api/org/name', { body: JSON.stringify({ name: 'X' }) }));
    expect(rCsrf.statusCode).toBe(403);
    expect(noCsrf.renames).toEqual([]);

    const empty = new FakeOrgRepo();
    const rEmpty = await run(deps(empty), fakeReq('POST', '/api/org/name', { headers: csrf(), body: JSON.stringify({ name: '   ' }) }));
    expect(rEmpty.statusCode).toBe(400);
    expect(empty.renames).toEqual([]);

    const long = new FakeOrgRepo();
    const rLong = await run(deps(long), fakeReq('POST', '/api/org/name', { headers: csrf(), body: JSON.stringify({ name: 'a'.repeat(81) }) }));
    expect(rLong.statusCode).toBe(400);
    expect(long.renames).toEqual([]);
  });

  it('NOT covered by the single-tenant guard: /api/org + /api/org/name work with singleTenant true AND false', async () => {
    for (const singleTenant of [true, false]) {
      const repo = new FakeOrgRepo(); // owner by default
      const info = await run(deps(repo, { singleTenant }), fakeReq('GET', '/api/org'));
      expect(info.statusCode).toBe(200);
      const rename = await run(
        deps(repo, { singleTenant }),
        fakeReq('POST', '/api/org/name', { headers: csrf(), body: JSON.stringify({ name: 'Renamed' }) })
      );
      expect(rename.statusCode).toBe(200);
      expect(repo.renames).toEqual([{ orgId: 'org_default', name: 'Renamed' }]);
    }
  });
});

describe('roster management — ADMIN-gated (slice 5d)', () => {
  it('GET /api/orgs/agents — ANY member may list the hired roster', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    const roster = new FakeRoster();
    roster.hired = [{ agentId: 'agent-elvis', name: 'Elvis', status: 'active' }];
    const r = await run(deps(repo, { roster }), fakeReq('GET', '/api/orgs/agents'));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ agents: [{ agentId: 'agent-elvis', name: 'Elvis', status: 'active' }] });
  });

  it('an ADMIN hires an agent → 200, the hire is recorded', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'admin';
    const roster = new FakeRoster();
    const r = await run(
      deps(repo, { roster }),
      fakeReq('POST', '/api/orgs/agents', { headers: csrf(), body: JSON.stringify({ agentId: 'agent-elvis' }) })
    );
    expect(r.statusCode).toBe(200);
    expect(roster.hires).toEqual([{ orgId: 'org_default', agentId: 'agent-elvis' }]);
  });

  it('PRIV-ESC BLOCK: a MEMBER cannot hire (403) — the roster boundary is gated on the endpoint, no hire recorded', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    const roster = new FakeRoster();
    const r = await run(
      deps(repo, { roster }),
      fakeReq('POST', '/api/orgs/agents', { headers: csrf(), body: JSON.stringify({ agentId: 'agent-elvis' }) })
    );
    expect(r.statusCode).toBe(403);
    expect(roster.hires).toEqual([]); // never reached the repo
  });

  it('PRIV-ESC BLOCK: a MEMBER cannot unhire (403), no unhire recorded', async () => {
    const repo = new FakeOrgRepo();
    repo.callerRole = 'member';
    const roster = new FakeRoster();
    const r = await run(deps(repo, { roster }), fakeReq('DELETE', '/api/orgs/agents/agent-elvis', { headers: csrf() }));
    expect(r.statusCode).toBe(403);
    expect(roster.unhires).toEqual([]);
  });

  it('hire of an unknown agent → 404; hire of an already-hired agent → 409', async () => {
    const notFound = new FakeRoster();
    notFound.nextHireOutcome = 'not_found';
    const r404 = await run(
      deps(new FakeOrgRepo(), { roster: notFound }),
      fakeReq('POST', '/api/orgs/agents', { headers: csrf(), body: JSON.stringify({ agentId: 'ghost' }) })
    );
    expect(r404.statusCode).toBe(404);

    const dup = new FakeRoster();
    dup.nextHireOutcome = 'already_hired';
    const r409 = await run(
      deps(new FakeOrgRepo(), { roster: dup }),
      fakeReq('POST', '/api/orgs/agents', { headers: csrf(), body: JSON.stringify({ agentId: 'agent-elvis' }) })
    );
    expect(r409.statusCode).toBe(409);
    expect(JSON.parse(r409.body).code).toBe('already_hired');
  });

  it('an OWNER unhires an agent → 200; unhiring a not-hired agent → 404', async () => {
    const repo = new FakeOrgRepo(); // owner by default
    const roster = new FakeRoster();
    const ok = await run(deps(repo, { roster }), fakeReq('DELETE', '/api/orgs/agents/agent-elvis', { headers: csrf() }));
    expect(ok.statusCode).toBe(200);
    expect(roster.unhires).toEqual([{ orgId: 'org_default', agentId: 'agent-elvis' }]);

    const missing = new FakeRoster();
    missing.nextUnhireRemoved = false;
    const r404 = await run(deps(new FakeOrgRepo(), { roster: missing }), fakeReq('DELETE', '/api/orgs/agents/nope', { headers: csrf() }));
    expect(r404.statusCode).toBe(404);
  });

  it('hire requires CSRF (403) and a non-empty agentId (400)', async () => {
    const noCsrf = new FakeRoster();
    const rCsrf = await run(
      deps(new FakeOrgRepo(), { roster: noCsrf }),
      fakeReq('POST', '/api/orgs/agents', { body: JSON.stringify({ agentId: 'agent-elvis' }) })
    );
    expect(rCsrf.statusCode).toBe(403);
    expect(noCsrf.hires).toEqual([]);

    const bad = new FakeRoster();
    const rBad = await run(
      deps(new FakeOrgRepo(), { roster: bad }),
      fakeReq('POST', '/api/orgs/agents', { headers: csrf(), body: JSON.stringify({ agentId: '' }) })
    );
    expect(rBad.statusCode).toBe(400);
    expect(bad.hires).toEqual([]);
  });
});

describe('single-tenant gating (slice 3.5-B.1)', () => {
  it('with singleTenant: true, the 3 multiplicity routes 404 and never act', async () => {
    const repo = new FakeOrgRepo();
    repo.addMember('u1', 'o-mine');
    const d = (over: Partial<OrgApiDeps> = {}) => deps(repo, { singleTenant: true, ...over });

    const list = await run(d(), fakeReq('GET', '/api/orgs'));
    expect(list.statusCode).toBe(404);

    const create = await run(d(), fakeReq('POST', '/api/orgs', { headers: csrf(), body: JSON.stringify({ name: 'Acme' }) }));
    expect(create.statusCode).toBe(404);
    expect(repo.created).toEqual([]); // never created

    const switchOrg = await run(d(), fakeReq('POST', '/api/active-org', { headers: csrf(), body: JSON.stringify({ orgId: 'o-mine' }) }));
    expect(switchOrg.statusCode).toBe(404);
    expect(repo.switched).toEqual([]); // never switched
  });

  it('with singleTenant: true, member-management + roster routes still work', async () => {
    const repo = new FakeOrgRepo(); // owner by default
    const members = await run(deps(repo, { singleTenant: true }), fakeReq('GET', '/api/orgs/members'));
    expect(members.statusCode).toBe(200);

    const add = await run(
      deps(repo, { singleTenant: true }),
      fakeReq('POST', '/api/orgs/members', { headers: csrf(), body: JSON.stringify({ email: 'new@x', role: 'admin' }) })
    );
    expect(add.statusCode).toBe(200);
    expect(repo.added).toEqual([{ orgId: 'org_default', email: 'new@x', role: 'admin' }]);

    const roster = new FakeRoster();
    const hire = await run(
      deps(repo, { singleTenant: true, roster }),
      fakeReq('POST', '/api/orgs/agents', { headers: csrf(), body: JSON.stringify({ agentId: 'agent-elvis' }) })
    );
    expect(hire.statusCode).toBe(200);
    expect(roster.hires).toEqual([{ orgId: 'org_default', agentId: 'agent-elvis' }]);
  });

  it('REGRESSION: with singleTenant false/unset (default), all 3 routes behave as today', async () => {
    const repo = new FakeOrgRepo();
    repo.addMember('u1', 'o-mine');
    repo.orgs = [{ id: 'o1', name: 'One', role: 'owner', active: true }];

    const list = await run(deps(repo), fakeReq('GET', '/api/orgs'));
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).orgs).toHaveLength(1);

    const create = await run(deps(repo), fakeReq('POST', '/api/orgs', { headers: csrf(), body: JSON.stringify({ name: 'Acme' }) }));
    expect(create.statusCode).toBe(200);
    expect(repo.created).toEqual([{ userId: 'u1', name: 'Acme' }]);

    const switchOrg = await run(deps(repo), fakeReq('POST', '/api/active-org', { headers: csrf(), body: JSON.stringify({ orgId: 'o-mine' }) }));
    expect(switchOrg.statusCode).toBe(200);
    expect(repo.switched).toEqual([{ userId: 'u1', orgId: 'o-mine' }]);
  });
});
