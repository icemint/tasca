import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { managerApiHandler, type ManagerApiDeps, type ManagerApiStore } from './manager-api';
import { openVendorKey, type SealedCredential } from './vendor-credential';
import type { GovernanceAuditEvent, GovernanceAuditSink } from './governance-audit';
import type { OrgRole } from './membership';

const MASTER = randomBytes(32);
const TOKEN = 'shortcut-em-agent-user-token-PROD-do-not-leak-xyz';
const ORG = 'org1';
const MGR = 'mgr-elvis';
const PROJ = 'proj-alpha';

// ── fakes (real state) ───────────────────────────────────────────────────────
type ManagerRow = { id: string; name: string; shortcutMemberId: string | null; shortcutHandle: string | null };

class FakeStore implements ManagerApiStore {
  managers = new Map<string, ManagerRow>(); // key: `${org}:${id}`
  creds = new Map<string, { sealed: SealedCredential; fingerprint: string; createdBy: string | null }>();
  projects = new Map<string, { managerId: string | null }>(); // key: `${org}:${projectId}`
  identityShouldThrow = false;
  private seq = 0;

  constructor() {
    // seed one manager + one project in ORG so the happy paths resolve
    this.managers.set(`${ORG}:${MGR}`, { id: MGR, name: 'Elvis', shortcutMemberId: null, shortcutHandle: null });
    this.projects.set(`${ORG}:${PROJ}`, { managerId: null });
  }

  async createManager(orgId: string, name: string) {
    const id = `mgr_new_${++this.seq}`;
    this.managers.set(`${orgId}:${id}`, { id, name, shortcutMemberId: null, shortcutHandle: null });
    return { managerId: id };
  }
  async getManager(orgId: string, managerId: string) {
    return this.managers.get(`${orgId}:${managerId}`) ?? null;
  }
  async setManagerShortcutIdentity(
    orgId: string,
    managerId: string,
    memberId: string,
    handle: string | null,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ) {
    if (this.identityShouldThrow) throw new Error('manager identity write failed');
    const row = this.managers.get(`${orgId}:${managerId}`);
    if (row) {
      row.shortcutMemberId = memberId;
      row.shortcutHandle = handle;
    }
    this.creds.set(`${orgId}:${managerId}:shortcut`, { sealed, fingerprint, createdBy });
  }
  async setProjectManager(orgId: string, projectId: string, managerId: string): Promise<'ok' | 'not_found'> {
    const proj = this.projects.get(`${orgId}:${projectId}`);
    const mgr = this.managers.get(`${orgId}:${managerId}`);
    if (!proj || !mgr) return 'not_found';
    proj.managerId = managerId;
    return 'ok';
  }
}

class FakeAudit implements GovernanceAuditSink {
  rows: Array<{ orgId: string } & GovernanceAuditEvent> = [];
  async recordGovernanceAudit(orgId: string, e: { actorUserId: string; action: string; target?: string; payload?: Record<string, unknown> }) {
    this.rows.push({ orgId, id: String(this.rows.length + 1), actorUserId: e.actorUserId, action: e.action, target: e.target ?? null, payload: e.payload ?? {}, at: new Date().toISOString() });
  }
  async listGovernanceAudit() {
    return [];
  }
}

const throwingAudit: GovernanceAuditSink = {
  async recordGovernanceAudit() {
    throw new Error('audit store down');
  },
  async listGovernanceAudit() {
    return [];
  },
};

function deps(
  over: Partial<ManagerApiDeps> & { role?: OrgRole | null; activeOrg?: string | null } = {}
): ManagerApiDeps {
  return {
    store: (over.store as FakeStore) ?? new FakeStore(),
    masterKey: over.masterKey === undefined ? MASTER : over.masterKey,
    membership: {
      getActiveOrg: async () => (over.activeOrg === undefined ? ORG : over.activeOrg),
      getRole: async () => (over.role === undefined ? 'admin' : over.role),
    } as ManagerApiDeps['membership'],
    audit: over.audit ?? new FakeAudit(),
    verifySession: over.verifySession ?? (() => ({ userId: 'u1' })),
    ...(over.logger ? { logger: over.logger } : {}),
  };
}

function fakeReq(method: string, url: string, opts: { headers?: Record<string, string | string[]>; body?: string } = {}): IncomingMessage {
  const body = opts.body;
  return {
    method,
    url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
  } as unknown as IncomingMessage;
}
function fakeRes(): { captured: { statusCode: number; body: string }; res: ServerResponse } {
  const captured = { statusCode: 0, body: '' };
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
const csrf = (extra: Record<string, string | string[]> = {}) => ({ cookie: `tasca_csrf=${TOK}`, 'x-csrf-token': TOK, ...extra });
async function run(d: ManagerApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await managerApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

const CREATE_PATH = `/api/orgs/${ORG}/managers`;
const IDENTITY_PATH = `/api/orgs/${ORG}/managers/${MGR}/identity/shortcut`;
const ASSIGN_PATH = `/api/orgs/${ORG}/projects/${PROJ}/manager`;
const identityBody = JSON.stringify({ memberId: 'sc-member-em-1', token: TOKEN, handle: 'elvis-em' });

describe('manager API — create (EM v1 slice 1)', () => {
  it('POST (admin) creates a manager; governance-audits it', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', CREATE_PATH, { headers: csrf({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    expect(typeof r.json.managerId).toBe('string');
    const audit = (d.audit as FakeAudit).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'manager.create', target: r.json.managerId });
  });

  it('create does NOT require a master key (no credential sealed) → 200', async () => {
    const r = await run(deps({ masterKey: null }), fakeReq('POST', CREATE_PATH, { headers: csrf(), body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(200);
  });

  it('rejects a missing/blank name → 400', async () => {
    const r = await run(deps(), fakeReq('POST', CREATE_PATH, { headers: csrf(), body: JSON.stringify({ name: '  ' }) }));
    expect(r.statusCode).toBe(400);
  });

  it('non-admin (member) → 403, nothing created', async () => {
    const d = deps({ role: 'member' });
    const r = await run(d, fakeReq('POST', CREATE_PATH, { headers: csrf(), body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).managers.size).toBe(1); // only the seeded one
  });

  it('no CSRF → 403', async () => {
    const r = await run(deps(), fakeReq('POST', CREATE_PATH, { body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(403);
  });

  it('no session → 401', async () => {
    const r = await run(deps({ verifySession: () => null }), fakeReq('POST', CREATE_PATH, { headers: csrf(), body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(401);
  });

  it('no active org → 403', async () => {
    const r = await run(deps({ activeOrg: null }), fakeReq('POST', CREATE_PATH, { headers: csrf(), body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(403);
  });

  it('FAIL-CLOSED: path org ≠ active org → 403', async () => {
    const r = await run(deps({ activeOrg: 'other-org' }), fakeReq('POST', CREATE_PATH, { headers: csrf(), body: JSON.stringify({ name: 'Mona' }) }));
    expect(r.statusCode).toBe(403);
  });
});

describe('manager API — set Shortcut identity (write-only, fail-closed)', () => {
  it('POST (admin) seals the token + sets the member id; response has a fingerprint but NEVER the token', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', IDENTITY_PATH, { headers: csrf({ 'content-type': 'application/json' }), body: identityBody }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true, managerId: MGR });
    expect(typeof r.json.fingerprint).toBe('string');
    expect(r.body).not.toContain(TOKEN);

    const store = d.store as FakeStore;
    // the manager-row identity projection (load-bearing for dedupe) was set
    expect(store.managers.get(`${ORG}:${MGR}`)).toMatchObject({ shortcutMemberId: 'sc-member-em-1', shortcutHandle: 'elvis-em' });
    // stored SEALED — plaintext recoverable only with the master key
    const cred = store.creds.get(`${ORG}:${MGR}:shortcut`);
    expect(JSON.stringify(cred!.sealed)).not.toContain(TOKEN);
    expect(openVendorKey(cred!.sealed, MASTER)).toBe(TOKEN);

    // governance audit recorded with fingerprint + memberId, NEVER the token
    const audit = (d.audit as FakeAudit).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'manager.identity.shortcut.set', target: MGR });
    expect(JSON.stringify(audit[0]?.payload)).not.toContain(TOKEN);
  });

  it('handle defaults to null when omitted', async () => {
    const d = deps();
    await run(d, fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: JSON.stringify({ memberId: 'm', token: TOKEN }) }));
    expect((d.store as FakeStore).managers.get(`${ORG}:${MGR}`)?.shortcutHandle).toBeNull();
  });

  it('no master key → 503, nothing stored', async () => {
    const d = deps({ masterKey: null });
    const r = await run(d, fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: identityBody }));
    expect(r.statusCode).toBe(503);
    expect((d.store as FakeStore).creds.size).toBe(0);
  });

  it('manager NOT in this org → 404, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', `/api/orgs/${ORG}/managers/ghost/identity/shortcut`, { headers: csrf(), body: identityBody }));
    expect(r.statusCode).toBe(404);
    expect((d.store as FakeStore).creds.size).toBe(0);
  });

  it('non-admin → 403; no master key check is even reached', async () => {
    const r = await run(deps({ role: 'member' }), fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: identityBody }));
    expect(r.statusCode).toBe(403);
  });

  it('rejects a missing/blank token → 400, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: JSON.stringify({ memberId: 'm', token: '  ' }) }));
    expect(r.statusCode).toBe(400);
    expect((d.store as FakeStore).creds.size).toBe(0);
  });

  it('rejects a missing/blank memberId → 400', async () => {
    const r = await run(deps(), fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: JSON.stringify({ memberId: '', token: TOKEN }) }));
    expect(r.statusCode).toBe(400);
  });

  it('the governance audit is BEST-EFFORT: a failing audit write still returns 200 (credential already sealed)', async () => {
    const d = deps({ audit: throwingAudit });
    const r = await run(d, fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: identityBody }));
    expect(r.statusCode).toBe(200);
    expect((d.store as FakeStore).creds.size).toBe(1);
  });

  it('a store identity-write failure PROPAGATES (→ 500 at the server boundary)', async () => {
    const store = new FakeStore();
    store.identityShouldThrow = true;
    const d = deps({ store });
    await expect(run(d, fakeReq('POST', IDENTITY_PATH, { headers: csrf(), body: identityBody }))).rejects.toThrow('manager identity write failed');
  });
});

describe('manager API — assign to project (both-in-org)', () => {
  it('POST (admin) assigns the manager to the project; governance-audits it', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', ASSIGN_PATH, { headers: csrf({ 'content-type': 'application/json' }), body: JSON.stringify({ managerId: MGR }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    expect((d.store as FakeStore).projects.get(`${ORG}:${PROJ}`)?.managerId).toBe(MGR);
    const audit = (d.audit as FakeAudit).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'project.manager.assign', target: PROJ, payload: { managerId: MGR } });
  });

  it('a manager NOT in this org → 404 (store returns not_found)', async () => {
    const r = await run(deps(), fakeReq('POST', ASSIGN_PATH, { headers: csrf(), body: JSON.stringify({ managerId: 'ghost' }) }));
    expect(r.statusCode).toBe(404);
  });

  it('a project NOT in this org → 404', async () => {
    const r = await run(deps(), fakeReq('POST', `/api/orgs/${ORG}/projects/ghost/manager`, { headers: csrf(), body: JSON.stringify({ managerId: MGR }) }));
    expect(r.statusCode).toBe(404);
  });

  it('rejects a missing managerId → 400', async () => {
    const r = await run(deps(), fakeReq('POST', ASSIGN_PATH, { headers: csrf(), body: JSON.stringify({}) }));
    expect(r.statusCode).toBe(400);
  });

  it('non-admin → 403, not assigned', async () => {
    const d = deps({ role: 'member' });
    const r = await run(d, fakeReq('POST', ASSIGN_PATH, { headers: csrf(), body: JSON.stringify({ managerId: MGR }) }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).projects.get(`${ORG}:${PROJ}`)?.managerId).toBeNull();
  });
});

describe('manager API — routing', () => {
  it('does not claim non-matching routes (returns false → falls through)', async () => {
    const r = await run(deps(), fakeReq('GET', '/api/agents'));
    expect(r.owned).toBe(false);
  });
});
