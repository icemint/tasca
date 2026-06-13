import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inviteApiHandler, type InviteApiDeps, type InviteMembership } from './invite-api';
import {
  hashToken,
  type CreateInviteInput,
  type InviteSummary,
  type AcceptInviteResult,
  type InviteStore,
} from './invite';
import type { OrgRole } from './membership';

// ── fakes (real state) ───────────────────────────────────────────────────────
interface StoredInvite {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'revoked';
  expiresAt: number;
}

class FakeInviteStore implements InviteStore {
  rows: StoredInvite[] = [];
  /** Records each accept's enroll so the test can assert NO email comparison happened. */
  members = new Map<string, { orgId: string; role: OrgRole }>();
  private seq = 0;

  async createInvite(orgId: string, input: CreateInviteInput): Promise<{ id: string }> {
    const id = `inv${++this.seq}`;
    this.rows.push({
      id,
      orgId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      status: 'pending',
      expiresAt: input.expiresAt.getTime(),
    });
    return { id };
  }
  async listPendingInvites(orgId: string): Promise<InviteSummary[]> {
    return this.rows
      .filter((r) => r.orgId === orgId && r.status === 'pending' && r.expiresAt > Date.now())
      .map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: 'now', expiresAt: 'later' }));
  }
  async revokeInvite(orgId: string, id: string): Promise<boolean> {
    const r = this.rows.find((x) => x.orgId === orgId && x.id === id && x.status === 'pending');
    if (!r) return false;
    r.status = 'revoked';
    return true;
  }
  async acceptInvite(tokenHash: string, acceptingUserId: string): Promise<AcceptInviteResult> {
    const r = this.rows.find((x) => x.tokenHash === tokenHash);
    if (!r) return { kind: 'invalid' };
    if (r.status !== 'pending' || r.expiresAt <= Date.now()) return { kind: 'consumed' };
    r.status = 'accepted';
    // Enroll WITHOUT comparing the accepting identity's email to r.email — possession is the authz.
    this.members.set(`${acceptingUserId}:${r.orgId}`, { orgId: r.orgId, role: r.role });
    return { kind: 'ok', orgId: r.orgId, role: r.role };
  }
}

function membership(over: { activeOrg?: string | null; role?: OrgRole | null } = {}): InviteMembership {
  return {
    getActiveOrg: async () => (over.activeOrg === undefined ? 'org1' : over.activeOrg),
    getRole: async () => (over.role === undefined ? 'admin' : over.role),
    getOrgName: async () => 'Acme',
  };
}

function deps(over: Partial<InviteApiDeps> & { role?: OrgRole | null; activeOrg?: string | null } = {}): InviteApiDeps {
  return {
    store: over.store ?? new FakeInviteStore(),
    membership:
      over.membership ??
      membership({
        ...(over.role !== undefined ? { role: over.role } : {}),
        ...(over.activeOrg !== undefined ? { activeOrg: over.activeOrg } : {}),
      }),
    acceptBaseUrl: over.acceptBaseUrl ?? 'https://app.tasca.test',
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
async function run(d: InviteApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await inviteApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

describe('invite API — admin-gated create, privilege cap, possession-based accept', () => {
  it('POST /api/invites (admin) mints an invite; response carries the acceptUrl with the token', async () => {
    const store = new FakeInviteStore();
    const r = await run(
      deps({ store }),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'a@b.test', role: 'member' }) })
    );
    expect(r.statusCode).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.email).toBe('a@b.test');
    expect(r.json.role).toBe('member');
    expect(r.json.acceptUrl).toMatch(/^https:\/\/app\.tasca\.test\/invite\?token=.+/);
    // The stored row holds only the HASH of the token in the returned URL — never the raw token.
    const rawToken = new URL(r.json.acceptUrl).searchParams.get('token')!;
    expect(store.rows[0]!.tokenHash).toBe(hashToken(rawToken));
    expect(JSON.stringify(store.rows[0])).not.toContain(rawToken);
  });

  it('POST is admin-gated: a member gets 403', async () => {
    const r = await run(
      deps({ role: 'member' }),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'a@b.test', role: 'member' }) })
    );
    expect(r.statusCode).toBe(403);
  });

  it('privilege cap: an admin inviting an owner is 403; an owner inviting an owner is ok', async () => {
    const asAdmin = await run(
      deps({ role: 'admin' }),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'o@b.test', role: 'owner' }) })
    );
    expect(asAdmin.statusCode).toBe(403);
    const asOwner = await run(
      deps({ role: 'owner' }),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'o@b.test', role: 'owner' }) })
    );
    expect(asOwner.statusCode).toBe(200);
  });

  it('validation: a bad email is 400, a bad role is 400', async () => {
    const badEmail = await run(
      deps(),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'not-an-email', role: 'member' }) })
    );
    expect(badEmail.statusCode).toBe(400);
    const badRole = await run(
      deps(),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'a@b.test', role: 'superuser' }) })
    );
    expect(badRole.statusCode).toBe(400);
  });

  it('POST without CSRF is 403', async () => {
    const r = await run(deps(), fakeReq('POST', '/api/invites', { body: JSON.stringify({ email: 'a@b.test', role: 'member' }) }));
    expect(r.statusCode).toBe(403);
  });

  it('GET /api/invites (admin) lists pending invites; never includes a token', async () => {
    const store = new FakeInviteStore();
    await store.createInvite('org1', { email: 'a@b.test', role: 'member', tokenHash: hashToken('x'), invitedBy: 'u1', expiresAt: new Date(Date.now() + 1000) });
    const r = await run(deps({ store }), fakeReq('GET', '/api/invites'));
    expect(r.statusCode).toBe(200);
    expect(r.json.invites).toHaveLength(1);
    expect(JSON.stringify(r.json)).not.toContain('token');
    expect(JSON.stringify(r.json)).not.toContain(hashToken('x'));
  });

  it('DELETE /api/invites/:id (admin) revokes → 200; unknown → 404', async () => {
    const store = new FakeInviteStore();
    const { id } = await store.createInvite('org1', { email: 'a@b.test', role: 'member', tokenHash: hashToken('y'), invitedBy: 'u1', expiresAt: new Date(Date.now() + 1000) });
    const ok = await run(deps({ store }), fakeReq('DELETE', `/api/invites/${id}`, { headers: csrf() }));
    expect(ok.statusCode).toBe(200);
    const missing = await run(deps({ store }), fakeReq('DELETE', '/api/invites/nope', { headers: csrf() }));
    expect(missing.statusCode).toBe(404);
  });

  it('accept requires a session: 401 without one', async () => {
    const r = await run(
      deps({ verifySession: () => null }),
      fakeReq('POST', '/api/invites/accept', { headers: csrf(), body: JSON.stringify({ token: 'whatever' }) })
    );
    expect(r.statusCode).toBe(401);
  });

  it('accept happy path returns {ok,orgId,role}; the accepting email is NOT compared to the invite email', async () => {
    const store = new FakeInviteStore();
    await store.createInvite('org1', { email: 'invited@somewhere.test', role: 'admin', tokenHash: hashToken('grant'), invitedBy: 'u1', expiresAt: new Date(Date.now() + 1000) });
    // The session user 'u1' has a DIFFERENT email than the invite — accept must still succeed (possession).
    const r = await run(
      deps({ store, verifySession: () => ({ userId: 'u1' }) }),
      fakeReq('POST', '/api/invites/accept', { headers: csrf(), body: JSON.stringify({ token: 'grant' }) })
    );
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ ok: true, orgId: 'org1', role: 'admin' });
    expect(store.members.get('u1:org1')).toEqual({ orgId: 'org1', role: 'admin' });
  });

  it('accept failures are NON-enumerating: invalid and consumed both return the IDENTICAL generic 409', async () => {
    const store = new FakeInviteStore();
    await store.createInvite('org1', { email: 'a@b.test', role: 'member', tokenHash: hashToken('used'), invitedBy: 'u1', expiresAt: new Date(Date.now() + 1000) });
    await store.acceptInvite(hashToken('used'), 'someone'); // consume it

    const consumed = await run(deps({ store }), fakeReq('POST', '/api/invites/accept', { headers: csrf(), body: JSON.stringify({ token: 'used' }) }));
    const invalid = await run(deps({ store }), fakeReq('POST', '/api/invites/accept', { headers: csrf(), body: JSON.stringify({ token: 'never-existed' }) }));
    expect(consumed.statusCode).toBe(409);
    expect(invalid.statusCode).toBe(409);
    expect(consumed.json).toEqual(invalid.json); // byte-identical — no enumeration
  });

  it('no session membership → 403', async () => {
    const r = await run(
      deps({ activeOrg: null }),
      fakeReq('POST', '/api/invites', { headers: csrf(), body: JSON.stringify({ email: 'a@b.test', role: 'member' }) })
    );
    expect(r.statusCode).toBe(403);
  });
});
