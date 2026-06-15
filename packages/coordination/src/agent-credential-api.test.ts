import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  agentCredentialApiHandler,
  type AgentCredentialApiDeps,
} from './agent-credential-api';
import type { OrgAgentReader } from './agent-identity-api';
import {
  AgentCredentialResolver,
  openVendorKey,
  liveAgentCredentialValidator,
  type SealedCredential,
  type AgentCredentialProvider,
  type AgentCredentialStatus,
  type AgentCredentialStore,
  type AgentCredentialValidator,
} from './vendor-credential';
import type { GovernanceAuditEvent, GovernanceAuditSink } from './governance-audit';
import type { OrgRole } from './membership';

const MASTER = randomBytes(32);
const TOKEN = 'github-agent-token-PROD-do-not-leak-abc';
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
  async getAgentCredentialStatuses(org: string, agent: string): Promise<AgentCredentialStatus[]> {
    const out: AgentCredentialStatus[] = [];
    for (const [k, v] of this.rows) {
      const [o, a, p] = k.split(':');
      if (o === org && a === agent) {
        out.push({ provider: p as AgentCredentialProvider, status: 'active', fingerprint: v.fingerprint, lastValidatedAt: null });
      }
    }
    return out.sort((x, y) => x.provider.localeCompare(y.provider));
  }
  async deleteAgentCredential(org: string, agent: string, p: AgentCredentialProvider) {
    return this.rows.delete(this.key(org, agent, p));
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

/** An always-accept validator (the default for happy-path tests). */
const okValidator: AgentCredentialValidator = { async validate() { return { ok: true }; } };
/** An always-reject validator (validate-before-persist). */
const rejectValidator: AgentCredentialValidator = { async validate() { return { ok: false, reason: 'the token was rejected by the platform (invalid or revoked)' }; } };
/** A validator that LEAKS the token in a thrown error — proves H3 (the token escapes neither the
 *  response body nor any log even when the validator misbehaves). */
const leakyThrowingValidator: AgentCredentialValidator = {
  async validate(_provider, token) {
    throw new Error(`upstream rejected token=${token}`);
  },
};

function deps(
  over: Partial<AgentCredentialApiDeps> & { role?: OrgRole | null; activeOrg?: string | null } = {}
): AgentCredentialApiDeps {
  const store = (over.store as FakeStore) ?? new FakeStore();
  return {
    store,
    resolver: over.resolver ?? new AgentCredentialResolver(store, over.masterKey === undefined ? MASTER : over.masterKey),
    validator: over.validator ?? okValidator,
    roster: over.roster ?? new FakeRoster(),
    masterKey: over.masterKey === undefined ? MASTER : over.masterKey,
    membership: {
      getActiveOrg: async () => (over.activeOrg === undefined ? ORG : over.activeOrg),
      getRole: async () => (over.role === undefined ? 'admin' : over.role),
    } as AgentCredentialApiDeps['membership'],
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
async function run(d: AgentCredentialApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await agentCredentialApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

const PATH = `/api/orgs/${ORG}/agents/${AGENT}/credentials`;
const setBody = (over: Record<string, unknown> = {}) => JSON.stringify({ provider: 'github', token: TOKEN, ...over });

describe('agent-credential API — write-only, admin-gated, fail-closed (slice SC-3-B)', () => {
  // ── gating chain ──
  it('POST with no session → 401', async () => {
    const r = await run(deps({ verifySession: () => null }), fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(401);
  });

  it('POST with no active org → 403', async () => {
    const r = await run(deps({ activeOrg: null }), fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(403);
  });

  it('H1: a path org that is NOT the caller’s active org → 403, nothing stored', async () => {
    const d = deps({ activeOrg: 'other-org' });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST without CSRF → 403, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { body: setBody() }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST as a NON-admin (member) → 403, nothing stored', async () => {
    const d = deps({ role: 'member' });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('M1: POST with no master key → 503, nothing stored', async () => {
    const d = deps({ masterKey: null });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(503);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('H1: POST for an agent NOT hired in this org → 404 (not 403 — no cross-org enumeration), nothing stored', async () => {
    const d = deps({ roster: new FakeRoster(new Set()) });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(404);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  // ── GET (member+, fingerprint-only) ──
  it('GET returns status + fingerprint ONLY — no ciphertext, no token', async () => {
    const d = deps();
    await run(d, fakeReq('POST', PATH, { headers: csrf({ 'content-type': 'application/json' }), body: setBody() }));
    const r = await run(d, fakeReq('GET', PATH));
    expect(r.statusCode).toBe(200);
    expect(r.json.credentials).toHaveLength(1);
    expect(r.json.credentials[0]).toMatchObject({ provider: 'github', status: 'active' });
    expect(typeof r.json.credentials[0].fingerprint).toBe('string');
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toContain('ciphertext');
  });

  it('GET as a member (read of which credentials exist) → 200', async () => {
    const r = await run(deps({ role: 'member' }), fakeReq('GET', PATH));
    expect(r.statusCode).toBe(200);
  });

  it('H1: GET is org-scoped — a path org that is not the active org → 403', async () => {
    const r = await run(deps({ activeOrg: 'other-org' }), fakeReq('GET', PATH));
    expect(r.statusCode).toBe(403);
  });

  // ── POST (validate-before-persist, write-only, leak-proof) ──
  it('POST (admin) seals the token; response carries provider + fingerprint but NEVER the token', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf({ 'content-type': 'application/json' }), body: setBody() }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true, provider: 'github' });
    expect(typeof r.json.fingerprint).toBe('string');
    expect(r.body).not.toContain(TOKEN);

    // stored SEALED — plaintext recoverable only with the master key
    const sealed = await (d.store as FakeStore).getSealedAgentCredential(ORG, AGENT, 'github');
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(openVendorKey(sealed!, MASTER)).toBe(TOKEN);

    // governance audit recorded with provider + fingerprint, NEVER the token
    const audit = (d.audit as FakeAudit).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'agent.credential.set', target: `${AGENT}:github` });
    expect(JSON.stringify(audit[0]?.payload)).not.toContain(TOKEN);
  });

  it('C3: POST whose token the platform REJECTS → 400 key_invalid, store untouched (validate-before-persist)', async () => {
    const d = deps({ validator: rejectValidator });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(400);
    expect(r.json.code).toBe('key_invalid');
    expect((d.store as FakeStore).rows.size).toBe(0);
    expect(r.body).not.toContain(TOKEN);
  });

  it('H3: a validator that throws WITH the token in its message ⇒ the token escapes neither the response nor the audit (error propagates, store untouched)', async () => {
    const d = deps({ validator: leakyThrowingValidator });
    await expect(run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }))).rejects.toThrow();
    // the throw happened BEFORE seal+store — nothing persisted, nothing audited
    expect((d.store as FakeStore).rows.size).toBe(0);
    expect((d.audit as FakeAudit).rows).toHaveLength(0);
  });

  it('C1: a body baseUrl is IGNORED — the live validator only ever hits the hardcoded host, with no token in the URL (C2)', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchSpy = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const d = deps({ validator: liveAgentCredentialValidator(fetchSpy) });
    const r = await run(
      d,
      fakeReq('POST', PATH, { headers: csrf(), body: setBody({ baseUrl: 'http://169.254.169.254/latest/meta-data' }) })
    );
    expect(r.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/user'); // the hardcoded host, NOT the body baseUrl
    expect(calls[0]!.url).not.toContain(TOKEN); // C2: no token in the URL/query
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`); // token only in a header
  });

  it('M4: an over-long token → 400, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody({ token: 'x'.repeat(4097) }) }));
    expect(r.statusCode).toBe(400);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('M4: an unknown provider → 400, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody({ provider: 'linear' }) }));
    expect(r.statusCode).toBe(400);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('M4: a blank token → 400, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody({ token: '  ' }) }));
    expect(r.statusCode).toBe(400);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('the governance audit is BEST-EFFORT: a failing audit write still returns 200 (token already sealed+stored)', async () => {
    const throwingAudit: GovernanceAuditSink = {
      async recordGovernanceAudit() { throw new Error('audit store down'); },
      async listGovernanceAudit() { return []; },
    };
    const d = deps({ audit: throwingAudit });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    expect(r.statusCode).toBe(200);
    expect((d.store as FakeStore).rows.size).toBe(1);
  });

  // ── DELETE (admin+, invalidates, audits) ──
  it('M2: DELETE removes the credential, busts the resolver cache, and audits the removal', async () => {
    const store = new FakeStore();
    let invalidated: [string, string, string] | null = null;
    const resolver = { invalidate: (o: string, a: string, p: AgentCredentialProvider) => { invalidated = [o, a, p]; } };
    const d = deps({ store, resolver });
    await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody() }));
    const r = await run(d, fakeReq('DELETE', `${PATH}/github`, { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(store.rows.size).toBe(0);
    expect(invalidated).toEqual([ORG, AGENT, 'github']);
    const del = (d.audit as FakeAudit).rows.find((e) => e.action === 'agent.credential.delete');
    expect(del).toMatchObject({ target: `${AGENT}:github` });
  });

  it('DELETE of a provider with nothing configured → 404', async () => {
    const r = await run(deps(), fakeReq('DELETE', `${PATH}/github`, { headers: csrf() }));
    expect(r.statusCode).toBe(404);
  });

  it('DELETE as a member → 403', async () => {
    const r = await run(deps({ role: 'member' }), fakeReq('DELETE', `${PATH}/github`, { headers: csrf() }));
    expect(r.statusCode).toBe(403);
  });

  // ── /test (admin+, validates submitted token, leak-proof) ──
  it('POST /test (admin) returns {ok:true} for an accepted token', async () => {
    const r = await run(deps(), fakeReq('POST', `${PATH}/github/test`, { headers: csrf(), body: JSON.stringify({ token: TOKEN }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  it('H2: POST /test returns {ok:false, reason} WITHOUT leaking the token or a raw upstream error', async () => {
    const r = await run(deps({ validator: rejectValidator }), fakeReq('POST', `${PATH}/github/test`, { headers: csrf(), body: JSON.stringify({ token: TOKEN }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(typeof r.json.reason).toBe('string');
    expect(r.body).not.toContain(TOKEN);
  });

  it('H2: POST /test as a member → 403', async () => {
    const r = await run(deps({ role: 'member' }), fakeReq('POST', `${PATH}/github/test`, { headers: csrf(), body: JSON.stringify({ token: TOKEN }) }));
    expect(r.statusCode).toBe(403);
  });

  it('POST /test without CSRF → 403', async () => {
    const r = await run(deps(), fakeReq('POST', `${PATH}/github/test`, { body: JSON.stringify({ token: TOKEN }) }));
    expect(r.statusCode).toBe(403);
  });

  it('POST /test with a blank token → 400', async () => {
    const r = await run(deps(), fakeReq('POST', `${PATH}/github/test`, { headers: csrf(), body: JSON.stringify({ token: '  ' }) }));
    expect(r.statusCode).toBe(400);
  });

  // ── shortcut provider also flows ──
  it('POST seals a shortcut token under a DISTINCT provider fingerprint domain', async () => {
    const d = deps();
    await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody({ provider: 'github' }) }));
    await run(d, fakeReq('POST', PATH, { headers: csrf(), body: setBody({ provider: 'shortcut' }) }));
    const gh = (d.store as FakeStore).rows.get(`${ORG}:${AGENT}:github`);
    const sc = (d.store as FakeStore).rows.get(`${ORG}:${AGENT}:shortcut`);
    expect(gh).toBeDefined();
    expect(sc).toBeDefined();
    // same token, different provider domain → different fingerprint (no collision)
    expect(gh!.fingerprint).not.toBe(sc!.fingerprint);
  });

  it('does not claim non-matching routes (returns false → falls through)', async () => {
    const r = await run(deps(), fakeReq('GET', '/api/agents'));
    expect(r.owned).toBe(false);
  });
});
