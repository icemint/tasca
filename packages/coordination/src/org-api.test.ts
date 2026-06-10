import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { orgApiHandler, type OrgApiDeps } from './org-api';
import type { OrgMembershipRepo, OrgRole, OrgMemberSummary, MemberWriteOutcome, UserOrgSummary } from './membership';

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
  return { membership: repo, verifySession: () => ({ userId: 'u1' }), ...over };
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
    const r = await run({ membership: new FakeOrgRepo() }, fakeReq('GET', '/api/orgs'));
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
