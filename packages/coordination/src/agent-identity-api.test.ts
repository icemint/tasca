import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  agentIdentityApiHandler,
  type AgentIdentityApiDeps,
  type IdentityBindingWriter,
  type OrgAgentReader,
} from './agent-identity-api';
import {
  AgentCredentialResolver,
  openVendorKey,
  type SealedCredential,
  type AgentCredentialProvider,
  type AgentCredentialStore,
} from './vendor-credential';
import type { GovernanceAuditEvent, GovernanceAuditSink } from './governance-audit';
import type { OrgRole } from './membership';

const MASTER = randomBytes(32);
const TOKEN = 'shortcut-agent-user-token-PROD-do-not-leak-abc';
const ORG = 'org1';
const AGENT = 'agent-elvis';

// ── fakes (real state) ───────────────────────────────────────────────────────
class FakeStore implements AgentCredentialStore {
  rows = new Map<string, { sealed: SealedCredential; fingerprint: string; createdBy: string | null }>();
  key(org: string, agent: string, p: AgentCredentialProvider) {
    return `${org}:${agent}:${p}`;
  }
  async setAgentCredential(org: string, agent: string, p: AgentCredentialProvider, sealed: SealedCredential, fp: string, by: string | null) {
    this.rows.set(this.key(org, agent, p), { sealed, fingerprint: fp, createdBy: by });
  }
  async getSealedAgentCredential(org: string, agent: string, p: AgentCredentialProvider) {
    return this.rows.get(this.key(org, agent, p))?.sealed ?? null;
  }
}

class FakeIdentity implements IdentityBindingWriter {
  bindings: Array<{ agentId: string; platform: string; externalId: string; externalHandle?: string; credentialRef?: string; state?: string }> = [];
  shouldThrow = false;
  async upsertBinding(input: { agentId: string; platform: 'shortcut'; externalId: string; externalHandle?: string; credentialRef?: string; state?: 'active' }) {
    if (this.shouldThrow) throw new Error('binding write failed');
    this.bindings.push(input);
    return { id: 'b1', ...input };
  }
}

class FakeRoster implements OrgAgentReader {
  constructor(private hired: Set<string> = new Set([`${ORG}:${AGENT}`])) {}
  async isHired(orgId: string, agentId: string) {
    return this.hired.has(`${orgId}:${agentId}`);
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
  over: Partial<AgentIdentityApiDeps> & { role?: OrgRole | null; activeOrg?: string | null } = {}
): AgentIdentityApiDeps {
  const store = (over.store as FakeStore) ?? new FakeStore();
  return {
    store,
    resolver: over.resolver ?? new AgentCredentialResolver(store, over.masterKey === undefined ? MASTER : over.masterKey),
    identity: over.identity ?? new FakeIdentity(),
    roster: over.roster ?? new FakeRoster(),
    masterKey: over.masterKey === undefined ? MASTER : over.masterKey,
    membership: {
      getActiveOrg: async () => (over.activeOrg === undefined ? ORG : over.activeOrg),
      getRole: async () => (over.role === undefined ? 'admin' : over.role),
    } as AgentIdentityApiDeps['membership'],
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
async function run(d: AgentIdentityApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await agentIdentityApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

const PATH = `/api/orgs/${ORG}/agents/${AGENT}/identity/shortcut`;
const goodBody = JSON.stringify({ memberId: 'sc-member-123', token: TOKEN, handle: 'elvis' });

describe('agent-identity API — write-only, admin-gated, fail-closed (slice SC-3)', () => {
  it('POST (admin) seals the token + upserts the binding; response carries a fingerprint but NEVER the token', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf({ 'content-type': 'application/json' }), body: goodBody }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true, agentId: AGENT, provider: 'shortcut' });
    expect(typeof r.json.fingerprint).toBe('string');
    expect(r.body).not.toContain(TOKEN); // the response NEVER echoes the token

    // stored SEALED — plaintext recoverable only with the master key
    const sealed = await (d.store as FakeStore).getSealedAgentCredential(ORG, AGENT, 'shortcut');
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(openVendorKey(sealed!, MASTER)).toBe(TOKEN);

    // identity_binding projection upserted with the structured pointer (never the token)
    const binding = (d.identity as FakeIdentity).bindings[0];
    expect(binding).toMatchObject({
      agentId: AGENT,
      platform: 'shortcut',
      externalId: 'sc-member-123',
      externalHandle: 'elvis',
      credentialRef: `org_agent_cred:${ORG}:${AGENT}:shortcut`,
      state: 'active',
    });

    // governance audit recorded with fingerprint + memberId, NEVER the token
    const audit = (d.audit as FakeAudit).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'agent.identity.shortcut.set', target: AGENT });
    expect(JSON.stringify(audit[0]?.payload)).not.toContain(TOKEN);
  });

  it('POST as a NON-admin (member) → 403, nothing stored', async () => {
    const d = deps({ role: 'member' });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST without CSRF → 403, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { body: goodBody }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST with no session → 401', async () => {
    const r = await run(deps({ verifySession: () => null }), fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(401);
  });

  it('POST with no active org → 403', async () => {
    const r = await run(deps({ activeOrg: null }), fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(403);
  });

  it('FAIL-CLOSED: a path org that is NOT the caller’s active org → 403, nothing stored', async () => {
    const d = deps({ activeOrg: 'other-org' }); // active org differs from the org in the URL
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST with no master key configured → 503 (cannot seal → refuse)', async () => {
    const d = deps({ masterKey: null });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(503);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST for an agent NOT hired in this org → 404, nothing stored', async () => {
    const d = deps({ roster: new FakeRoster(new Set()) });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(404);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('rejects a missing/blank memberId → 400', async () => {
    const r = await run(deps(), fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ memberId: '', token: TOKEN }) }));
    expect(r.statusCode).toBe(400);
  });

  it('rejects a missing/blank token → 400, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ memberId: 'm', token: '  ' }) }));
    expect(r.statusCode).toBe(400);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('rejects an over-long handle → 400', async () => {
    const r = await run(deps(), fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ memberId: 'm', token: TOKEN, handle: 'x'.repeat(81) }) }));
    expect(r.statusCode).toBe(400);
  });

  it('the governance audit is BEST-EFFORT: a failing audit write still returns 200 (credential already sealed+stored)', async () => {
    const d = deps({ audit: throwingAudit });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(200);
    expect((d.store as FakeStore).rows.size).toBe(1); // the durable write landed
  });

  it('does not claim non-matching routes (returns false → falls through)', async () => {
    const r = await run(deps(), fakeReq('GET', '/api/agents'));
    expect(r.owned).toBe(false);
  });
});
