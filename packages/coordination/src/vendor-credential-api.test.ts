import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { vendorCredentialApiHandler, type VendorCredentialApiDeps } from './vendor-credential-api';
import {
  VendorKeyResolver,
  openVendorKey,
  type SealedCredential,
  type VendorProvider,
  type VendorCredentialStore,
  type VendorCredentialStatus,
  type VendorValidator,
} from './vendor-credential';
import type { GovernanceAuditEvent, GovernanceAuditSink } from './governance-audit';
import type { OrgRole } from './membership';

const MASTER = randomBytes(32);
const SECRET = 'sk-ant-PROD-SECRET-do-not-leak-abcdef0123';

// ── fakes (real state) ───────────────────────────────────────────────────────
class FakeStore implements VendorCredentialStore {
  rows = new Map<string, { sealed: SealedCredential; fingerprint: string; createdBy: string | null }>();
  key(org: string, p: VendorProvider) {
    return `${org}:${p}`;
  }
  async setVendorCredential(org: string, p: VendorProvider, sealed: SealedCredential, fp: string, by: string | null) {
    this.rows.set(this.key(org, p), { sealed, fingerprint: fp, createdBy: by });
  }
  async getVendorCredentialStatuses(org: string): Promise<VendorCredentialStatus[]> {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${org}:`))
      .map(([k, v]) => ({ provider: k.split(':')[1] as VendorProvider, status: 'active', fingerprint: v.fingerprint, lastValidatedAt: null }));
  }
  async getSealedVendorCredential(org: string, p: VendorProvider) {
    return this.rows.get(this.key(org, p))?.sealed ?? null;
  }
  async deleteVendorCredential(org: string, p: VendorProvider) {
    return this.rows.delete(this.key(org, p));
  }
}

const okValidator: VendorValidator = { validate: async () => ({ ok: true }) };
const rejectValidator: VendorValidator = { validate: async () => ({ ok: false, reason: 'the key was rejected by the vendor (invalid or revoked)' }) };

/** In-memory governance-audit sink (real state) — newest-first, org-scoped, like the Pg impl. */
class FakeAudit implements GovernanceAuditSink {
  rows: Array<{ orgId: string } & GovernanceAuditEvent> = [];
  async recordGovernanceAudit(orgId: string, e: { actorUserId: string; action: string; target?: string; payload?: Record<string, unknown> }) {
    this.rows.push({ orgId, id: String(this.rows.length + 1), actorUserId: e.actorUserId, action: e.action, target: e.target ?? null, payload: e.payload ?? {}, at: new Date().toISOString() });
  }
  async listGovernanceAudit(orgId: string, opts?: { limit?: number }): Promise<GovernanceAuditEvent[]> {
    return this.rows.filter((r) => r.orgId === orgId).slice().reverse().slice(0, opts?.limit ?? 50)
      .map(({ orgId: _o, ...e }) => e);
  }
}

/** A sink whose record always throws — to prove the audit write is best-effort (never fails the op). */
const throwingAudit: GovernanceAuditSink = {
  async recordGovernanceAudit() {
    throw new Error('audit store down');
  },
  async listGovernanceAudit() {
    return [];
  },
};

function deps(over: Partial<VendorCredentialApiDeps> & { role?: OrgRole | null; activeOrg?: string | null } = {}): VendorCredentialApiDeps {
  const store = over.store ?? new FakeStore();
  return {
    store,
    resolver: over.resolver ?? new VendorKeyResolver(store, over.masterKey === undefined ? MASTER : over.masterKey),
    validator: over.validator ?? okValidator,
    masterKey: over.masterKey === undefined ? MASTER : over.masterKey,
    membership: {
      getActiveOrg: async () => (over.activeOrg === undefined ? 'org1' : over.activeOrg),
      getRole: async () => (over.role === undefined ? 'admin' : over.role),
    } as VendorCredentialApiDeps['membership'],
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
async function run(d: VendorCredentialApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await vendorCredentialApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

describe('vendor-credential API — write-only, admin-gated, fail-closed', () => {
  it('POST (admin) validates → seals → stores; response carries status+fingerprint but NEVER the key', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf({ 'content-type': 'application/json' }), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true, provider: 'anthropic', status: 'active' });
    expect(typeof r.json.fingerprint).toBe('string');
    expect(r.body).not.toContain(SECRET); // the response NEVER echoes the key
    // …and it is stored SEALED (the plaintext is recoverable only with the master key, never from the API).
    const sealed = await (d.store as FakeStore).getSealedVendorCredential('org1', 'anthropic');
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(openVendorKey(sealed!, MASTER)).toBe(SECRET);
  });

  it('GET (any member) returns status + fingerprint, NEVER the key', async () => {
    const d = deps({ role: 'member' });
    await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }))
      .catch(() => {}); // member can't POST; seed via the store directly instead
    await (d.store as FakeStore).setVendorCredential('org1', 'anthropic', { ciphertext: 'x', nonce: 'y', authTag: 'z' }, 'fp123', 'u1');
    const r = await run(d, fakeReq('GET', '/api/orgs/credentials'));
    expect(r.statusCode).toBe(200);
    expect(r.json.credentials[0]).toMatchObject({ provider: 'anthropic', status: 'active', fingerprint: 'fp123' });
    expect(r.body).not.toContain(SECRET);
  });

  it('POST as a NON-admin (member) → 403, nothing stored (gate on the endpoint)', async () => {
    const d = deps({ role: 'member' });
    const r = await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST without CSRF → 403', async () => {
    const r = await run(deps(), fakeReq('POST', '/api/orgs/credentials', { body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    expect(r.statusCode).toBe(403);
  });

  it('POST a key the vendor REJECTS → 400, nothing stored (validate before store)', async () => {
    const d = deps({ validator: rejectValidator });
    const r = await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'anthropic', key: 'sk-bad' }) }));
    expect(r.statusCode).toBe(400);
    expect(r.json.code).toBe('key_invalid');
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST with no master key configured → 503 (cannot seal → refuse to store)', async () => {
    const d = deps({ masterKey: null });
    const r = await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    expect(r.statusCode).toBe(503);
  });

  it('DELETE (admin) removes the key; idempotent 404 when none', async () => {
    const d = deps();
    await (d.store as FakeStore).setVendorCredential('org1', 'anthropic', { ciphertext: 'x', nonce: 'y', authTag: 'z' }, 'fp', null);
    expect((await run(d, fakeReq('DELETE', '/api/orgs/credentials/anthropic', { headers: csrf() }))).statusCode).toBe(200);
    expect((await run(d, fakeReq('DELETE', '/api/orgs/credentials/anthropic', { headers: csrf() }))).statusCode).toBe(404);
  });

  it('unknown provider on POST → 400', async () => {
    const r = await run(deps(), fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'openai', key: SECRET }) }));
    expect(r.statusCode).toBe(400);
  });

  it('no session → 401; no active org → 403; non-matching path → not owned', async () => {
    expect((await run(deps({ verifySession: () => null }), fakeReq('GET', '/api/orgs/credentials'))).statusCode).toBe(401);
    expect((await run(deps({ activeOrg: null }), fakeReq('GET', '/api/orgs/credentials'))).statusCode).toBe(403);
    expect((await run(deps(), fakeReq('GET', '/api/tasks'))).owned).toBe(false);
  });
});

describe('vendor-credential API — governance audit trail (slice 3.5-A.2c.1)', () => {
  it('POST records a credential.set audit row with the fingerprint — and NEVER the raw key', async () => {
    const audit = new FakeAudit();
    const d = deps({ audit });
    const r = await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf({ 'content-type': 'application/json' }), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    expect(r.statusCode).toBe(200);
    expect(audit.rows).toHaveLength(1);
    const row = audit.rows[0]!;
    expect(row).toMatchObject({ orgId: 'org1', actorUserId: 'u1', action: 'credential.set', target: 'anthropic' });
    expect(row.payload).toMatchObject({ status: 'active' });
    expect(typeof (row.payload as { fingerprint?: unknown }).fingerprint).toBe('string');
    // CRITICAL: the audit payload (and the whole row) must NEVER contain the raw key.
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(Object.values(row.payload)).not.toContain(SECRET);
  });

  it('DELETE records a credential.delete audit row (empty payload, no key)', async () => {
    const audit = new FakeAudit();
    const d = deps({ audit });
    await (d.store as FakeStore).setVendorCredential('org1', 'anthropic', { ciphertext: 'x', nonce: 'y', authTag: 'z' }, 'fp', null);
    const r = await run(d, fakeReq('DELETE', '/api/orgs/credentials/anthropic', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actorUserId: 'u1', action: 'credential.delete', target: 'anthropic', payload: {} });
    expect(JSON.stringify(audit.rows[0])).not.toContain(SECRET);
  });

  it('a 404 DELETE (no key configured) records NOTHING (only successful ops are audited)', async () => {
    const audit = new FakeAudit();
    const r = await run(deps({ audit }), fakeReq('DELETE', '/api/orgs/credentials/anthropic', { headers: csrf() }));
    expect(r.statusCode).toBe(404);
    expect(audit.rows).toHaveLength(0);
  });

  it('a failing audit write is BEST-EFFORT: the credential op still succeeds (200), the error is logged', async () => {
    const logged: Array<{ message: string }> = [];
    const logger = { error: (message: string) => logged.push({ message }), info: () => {} };
    const r = await run(deps({ audit: throwingAudit, logger }), fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    expect(r.statusCode).toBe(200); // the key is sealed+stored; a broken audit must NOT fail the store
    expect(logged.some((l) => l.message.includes('governance audit write failed'))).toBe(true);
  });

  it('GET /audit as ADMIN returns the events; the payloads carry NO raw key', async () => {
    const audit = new FakeAudit();
    const d = deps({ audit });
    await run(d, fakeReq('POST', '/api/orgs/credentials', { headers: csrf(), body: JSON.stringify({ provider: 'anthropic', key: SECRET }) }));
    const r = await run(d, fakeReq('GET', '/api/orgs/credentials/audit'));
    expect(r.statusCode).toBe(200);
    expect(r.json.events).toHaveLength(1);
    expect(r.json.events[0]).toMatchObject({ action: 'credential.set', target: 'anthropic' });
    expect(r.body).not.toContain(SECRET); // the audit read NEVER exposes the key
  });

  it('GET /audit as a NON-admin (member) → 403 (governance-sensitive, gated like the writes)', async () => {
    const r = await run(deps({ role: 'member' }), fakeReq('GET', '/api/orgs/credentials/audit'));
    expect(r.statusCode).toBe(403);
  });

  it('GET /audit with no audit sink wired → 200 with an empty list', async () => {
    const d = deps();
    delete (d as { audit?: unknown }).audit;
    const r = await run(d, fakeReq('GET', '/api/orgs/credentials/audit'));
    expect(r.statusCode).toBe(200);
    expect(r.json.events).toEqual([]);
  });
});
