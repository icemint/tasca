import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { githubConnectHandler, type GitHubConnectDeps, type ConsumedState } from './github-connect';
import type { OrgRole } from './membership';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

class FakeInstallState {
  issued: Array<{ userId: string; orgId: string; state: string }> = [];
  nextConsume: ConsumedState | null = { userId: 'u1', orgId: 'org-a' };
  consumed: string[] = [];
  async issue(userId: string, orgId: string) {
    const state = `state-${this.issued.length}`;
    this.issued.push({ userId, orgId, state });
    return state;
  }
  async consume(state: string) {
    this.consumed.push(state);
    return this.nextConsume;
  }
  async deleteExpired() {
    return 0;
  }
}

class FakeMembership {
  activeOrg: string | null = 'org-a';
  role: OrgRole | null = 'admin';
  async getActiveOrg() {
    return this.activeOrg;
  }
  async getRole() {
    return this.role;
  }
}

class FakeConnectionStore {
  existingOrg: string | null = null; // what account is currently bound to (re-connect guard)
  bound: Array<{ orgId: string; workspaceId: string; installationId: string }> = [];
  upsertError: { code?: string } | null = null; // set to simulate a concurrent unique violation
  async getOrgForConnection() {
    return this.existingOrg;
  }
  async upsertGitHubInstallation(orgId: string, input: { workspaceId: string; installationId: string }) {
    if (this.upsertError) throw this.upsertError;
    this.bound.push({ orgId, ...input });
  }
}

class FakeAppClient {
  account = 'acme';
  async getInstallationAccount() {
    return this.account;
  }
}

function fakeReq(url: string): IncomingMessage {
  return { method: 'GET', url, headers: {} } as unknown as IncomingMessage;
}

function fakeRes(): { captured: { statusCode: number; location: string | undefined }; res: ServerResponse } {
  const captured = { statusCode: 0, location: undefined as string | undefined };
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      captured.statusCode = code;
      if (headers?.location) captured.location = headers.location;
      return res;
    },
    end() {
      return res;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

function deps(over: Partial<GitHubConnectDeps> = {}): GitHubConnectDeps {
  return {
    installState: new FakeInstallState(),
    membership: new FakeMembership(),
    store: new FakeConnectionStore(),
    appClient: new FakeAppClient(),
    appSlug: 'tasca-dev',
    verifySession: () => ({ userId: 'u1' }),
    ...over,
  };
}

async function run(d: GitHubConnectDeps, url: string) {
  const { captured, res } = fakeRes();
  const owned = await githubConnectHandler(fakeReq(url), res, d);
  return { owned, ...captured };
}

describe('GitHub connect — begin (GET /api/connect/github)', () => {
  it('an ADMIN gets a 302 to the install URL with a state bound to {userId, active org}', async () => {
    const installState = new FakeInstallState();
    const r = await run(deps({ installState }), '/api/connect/github');
    expect(r.statusCode).toBe(302);
    expect(r.location).toMatch(/^https:\/\/github\.com\/apps\/tasca-dev\/installations\/new\?state=state-0$/);
    expect(installState.issued).toEqual([{ userId: 'u1', orgId: 'org-a', state: 'state-0' }]); // org captured AT BEGIN
  });

  it('a MEMBER cannot initiate a connect (403 — gate on the endpoint)', async () => {
    const membership = new FakeMembership();
    membership.role = 'member';
    const installState = new FakeInstallState();
    const r = await run(deps({ membership, installState }), '/api/connect/github');
    expect(r.statusCode).toBe(403);
    expect(installState.issued).toEqual([]); // no nonce issued
  });

  it('a user with no active org → 403', async () => {
    const membership = new FakeMembership();
    membership.activeOrg = null;
    const r = await run(deps({ membership }), '/api/connect/github');
    expect(r.statusCode).toBe(403);
  });

  it('no session → 401', async () => {
    const r = await run(deps({ verifySession: () => null }), '/api/connect/github');
    expect(r.statusCode).toBe(401);
  });
});

describe('GitHub connect — callback (binds installation → org)', () => {
  it('binds the installation to the NONCE’s org (authoritative — never re-resolved at callback)', async () => {
    const store = new FakeConnectionStore();
    const installState = new FakeInstallState();
    installState.nextConsume = { userId: 'u1', orgId: 'org-at-begin' };
    // Membership says the active org is DIFFERENT now (user switched mid-flow) — must be IGNORED.
    const membership = new FakeMembership();
    membership.activeOrg = 'org-switched-to';
    const r = await run(deps({ store, installState, membership }), '/api/connect/github/callback?installation_id=99&state=state-0');
    expect(r.statusCode).toBe(302);
    expect(r.location).toBe('/?connect=success');
    expect(store.bound).toEqual([{ orgId: 'org-at-begin', workspaceId: 'acme', installationId: '99' }]); // nonce's org, not the switched one
  });

  it('a bad/expired/replayed state → error redirect, nothing bound', async () => {
    const store = new FakeConnectionStore();
    const installState = new FakeInstallState();
    installState.nextConsume = null; // consume finds nothing
    const r = await run(deps({ store, installState }), '/api/connect/github/callback?installation_id=99&state=stale');
    expect(r.statusCode).toBe(302);
    expect(r.location).toBe('/?connect=error&reason=bad_state');
    expect(store.bound).toEqual([]);
  });

  it('a session that does NOT match the nonce initiator → error, nothing bound', async () => {
    const store = new FakeConnectionStore();
    const installState = new FakeInstallState();
    installState.nextConsume = { userId: 'someone-else', orgId: 'org-a' };
    const r = await run(deps({ store, installState, verifySession: () => ({ userId: 'u1' }) }), '/api/connect/github/callback?installation_id=99&state=state-0');
    expect(r.location).toBe('/?connect=error&reason=session_mismatch');
    expect(store.bound).toEqual([]);
  });

  it('RE-CONNECT GUARD: an account already bound to a DIFFERENT org is refused (no hijack)', async () => {
    const store = new FakeConnectionStore();
    store.existingOrg = 'someone-elses-org'; // acme is already bound elsewhere
    const installState = new FakeInstallState();
    installState.nextConsume = { userId: 'u1', orgId: 'org-a' };
    const r = await run(deps({ store, installState }), '/api/connect/github/callback?installation_id=99&state=state-0');
    expect(r.location).toBe('/?connect=error&reason=already_connected');
    expect(store.bound).toEqual([]); // not re-bound
  });

  it('re-connect to the SAME org is allowed (idempotent re-install)', async () => {
    const store = new FakeConnectionStore();
    store.existingOrg = 'org-a'; // already bound to the same org
    const installState = new FakeInstallState();
    installState.nextConsume = { userId: 'u1', orgId: 'org-a' };
    const r = await run(deps({ store, installState }), '/api/connect/github/callback?installation_id=100&state=state-0');
    expect(r.location).toBe('/?connect=success');
    expect(store.bound).toEqual([{ orgId: 'org-a', workspaceId: 'acme', installationId: '100' }]); // installation_id refreshed
  });

  it('missing installation_id/state → error', async () => {
    const r = await run(deps(), '/api/connect/github/callback?state=state-0');
    expect(r.location).toBe('/?connect=error&reason=missing_params');
  });

  it('CONCURRENT race: the github-account unique violation (23505) on upsert → already_connected, not a 500', async () => {
    // Both callbacks pass the read-guard (existingOrg null), but the DB unique catches the second.
    const store = new FakeConnectionStore();
    store.existingOrg = null;
    store.upsertError = { code: '23505' };
    const installState = new FakeInstallState();
    installState.nextConsume = { userId: 'u1', orgId: 'org-a' };
    const r = await run(deps({ store, installState }), '/api/connect/github/callback?installation_id=99&state=state-0');
    expect(r.location).toBe('/?connect=error&reason=already_connected'); // not a generic internal error
  });
});
