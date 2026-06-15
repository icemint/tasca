import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  connectionApiHandler,
  type ConnectionApiDeps,
  type ShortcutConnectionWriter,
} from './connection-api';
import {
  ConnectionCredentialResolver,
  fingerprintConnectionKey,
  openVendorKey,
  type SealedCredential,
  type ConnectionCredentialKind,
  type ConnectionCredentialStore,
  type AgentCredentialValidator,
} from './vendor-credential';
import type { GovernanceAuditEvent, GovernanceAuditSink } from './governance-audit';
import type { OrgRole } from './membership';

const MASTER = randomBytes(32);
const WEBHOOK_SECRET = 'shortcut-webhook-secret-PROD-do-not-leak-abc';
const READ_TOKEN = 'shortcut-read-token-PROD-do-not-leak-xyz';
const ORG = 'org1';
const PROJECT = 'proj_eltexsoft';

// ── fakes (real state) ───────────────────────────────────────────────────────
class FakeStore implements ConnectionCredentialStore, ShortcutConnectionWriter {
  rows = new Map<string, { sealed: SealedCredential; fingerprint: string; createdBy: string | null }>();
  connections: Array<{ orgId: string; workspaceId: string; projectId: string }> = [];
  projects: Set<string> = new Set([`${ORG}:${PROJECT}`]);
  shouldThrowOnCredential = false;
  shouldThrowOnConnection = false;
  nextConnectionId = 'conn_eltexsoft';

  key(org: string, conn: string, kind: ConnectionCredentialKind) {
    return `${org}:${conn}:${kind}`;
  }
  async projectExistsInOrg(orgId: string, projectId: string) {
    return this.projects.has(`${orgId}:${projectId}`);
  }
  async upsertShortcutConnection(orgId: string, input: { workspaceId: string; projectId: string }) {
    if (this.shouldThrowOnConnection) throw new Error('connection write failed');
    this.connections.push({ orgId, ...input });
    return { connectionId: this.nextConnectionId };
  }
  async setConnectionCredential(org: string, conn: string, kind: ConnectionCredentialKind, sealed: SealedCredential, fp: string, by: string | null) {
    if (this.shouldThrowOnCredential) throw new Error('credential write failed');
    this.rows.set(this.key(org, conn, kind), { sealed, fingerprint: fp, createdBy: by });
  }
  async getSealedConnectionCredential(org: string, conn: string, kind: ConnectionCredentialKind) {
    return this.rows.get(this.key(org, conn, kind))?.sealed ?? null;
  }
  async getConnectionCredentialStatuses(org: string, conn: string) {
    // Status read: fingerprint + status ONLY (NEVER the sealed ciphertext) — mirrors the PG method.
    return (['webhook_secret', 'read_token'] as ConnectionCredentialKind[]).flatMap((kind) => {
      const row = this.rows.get(this.key(org, conn, kind));
      return row ? [{ kind, status: 'active' as const, fingerprint: row.fingerprint, lastValidatedAt: null }] : [];
    });
  }
  async getShortcutConnectionForOrg(orgId: string) {
    const c = this.connections.find((x) => x.orgId === orgId);
    return c ? { connectionId: this.nextConnectionId, workspaceId: c.workspaceId, projectId: c.projectId } : null;
  }
  async deleteShortcutConnection(orgId: string, connectionId: string) {
    const before = this.connections.length;
    this.connections = this.connections.filter((x) => x.orgId !== orgId);
    // Cascade the connection's credential rows (the FK ON DELETE CASCADE in PG).
    for (const k of [...this.rows.keys()]) {
      if (k.startsWith(`${orgId}:${connectionId}:`)) this.rows.delete(k);
    }
    return this.connections.length < before;
  }
}

/** A hand-rolled validator fake (real state) — records the probe + returns a scripted verdict. */
class FakeValidator implements AgentCredentialValidator {
  calls: Array<{ provider: string; token: string }> = [];
  verdict: { ok: true } | { ok: false; reason: string } = { ok: true };
  async validate(provider: 'shortcut' | 'github', token: string) {
    this.calls.push({ provider, token });
    return this.verdict;
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
  over: Partial<ConnectionApiDeps> & { role?: OrgRole | null; activeOrg?: string | null } = {}
): ConnectionApiDeps {
  const store = (over.store as FakeStore) ?? new FakeStore();
  return {
    store,
    resolver: over.resolver ?? new ConnectionCredentialResolver(store, over.masterKey === undefined ? MASTER : over.masterKey),
    validator: over.validator ?? new FakeValidator(),
    masterKey: over.masterKey === undefined ? MASTER : over.masterKey,
    membership: {
      getActiveOrg: async () => (over.activeOrg === undefined ? ORG : over.activeOrg),
      getRole: async () => (over.role === undefined ? 'admin' : over.role),
    } as ConnectionApiDeps['membership'],
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
async function run(d: ConnectionApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await connectionApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

const PATH = `/api/orgs/${ORG}/connections/shortcut`;
const goodBody = JSON.stringify({ workspaceId: 'ws-eltexsoft', projectId: PROJECT, webhookSecret: WEBHOOK_SECRET, readToken: READ_TOKEN });

describe('connection API — write-only, admin-gated, fail-closed (slice SC-1)', () => {
  it('POST (admin) upserts the connection, seals BOTH secrets, returns the webhook URL but NEVER a secret', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf({ 'content-type': 'application/json' }), body: goodBody }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ ok: true, connectionId: 'conn_eltexsoft', webhookUrl: '/webhooks/shortcut/conn_eltexsoft' });
    expect(r.body).not.toContain(WEBHOOK_SECRET); // the response NEVER echoes a secret
    expect(r.body).not.toContain(READ_TOKEN);

    // the connection (workspace→project binding) landed
    const store = d.store as FakeStore;
    expect(store.connections).toEqual([{ orgId: ORG, workspaceId: 'ws-eltexsoft', projectId: PROJECT }]);

    // BOTH secrets stored SEALED — plaintext recoverable only with the master key
    const sealedHook = await store.getSealedConnectionCredential(ORG, 'conn_eltexsoft', 'webhook_secret');
    const sealedRead = await store.getSealedConnectionCredential(ORG, 'conn_eltexsoft', 'read_token');
    expect(JSON.stringify(sealedHook)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(sealedRead)).not.toContain(READ_TOKEN);
    expect(openVendorKey(sealedHook!, MASTER)).toBe(WEBHOOK_SECRET);
    expect(openVendorKey(sealedRead!, MASTER)).toBe(READ_TOKEN);

    // governance audit recorded with fingerprints, NEVER either secret
    const audit = (d.audit as FakeAudit).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'connection.shortcut.set', target: 'conn_eltexsoft' });
    expect(JSON.stringify(audit[0]?.payload)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(audit[0]?.payload)).not.toContain(READ_TOKEN);
  });

  it('POST as a NON-admin (member) → 403, nothing stored', async () => {
    const d = deps({ role: 'member' });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).connections).toHaveLength(0);
    expect((d.store as FakeStore).rows.size).toBe(0);
  });

  it('POST without CSRF → 403, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { body: goodBody }));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).connections).toHaveLength(0);
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
    expect((d.store as FakeStore).connections).toHaveLength(0);
  });

  it('POST with no master key configured → 503 (cannot seal → refuse)', async () => {
    const d = deps({ masterKey: null });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(503);
    expect((d.store as FakeStore).connections).toHaveLength(0);
  });

  it('POST for a project NOT in this org → 404, nothing stored (no cross-tenant existence oracle)', async () => {
    const store = new FakeStore();
    store.projects = new Set(); // the projectId is not this org's
    const d = deps({ store });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(404);
    expect(store.connections).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('rejects a missing/blank workspaceId → 400', async () => {
    const r = await run(deps(), fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ workspaceId: '', projectId: PROJECT, webhookSecret: WEBHOOK_SECRET, readToken: READ_TOKEN }) }));
    expect(r.statusCode).toBe(400);
  });

  it('rejects a missing projectId → 400', async () => {
    const r = await run(deps(), fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ workspaceId: 'ws', webhookSecret: WEBHOOK_SECRET, readToken: READ_TOKEN }) }));
    expect(r.statusCode).toBe(400);
  });

  it('rejects a missing webhookSecret → 400, nothing stored', async () => {
    const d = deps();
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ workspaceId: 'ws', projectId: PROJECT, readToken: READ_TOKEN }) }));
    expect(r.statusCode).toBe(400);
    expect((d.store as FakeStore).connections).toHaveLength(0);
  });

  it('rejects a missing readToken → 400', async () => {
    const r = await run(deps(), fakeReq('POST', PATH, { headers: csrf(), body: JSON.stringify({ workspaceId: 'ws', projectId: PROJECT, webhookSecret: WEBHOOK_SECRET }) }));
    expect(r.statusCode).toBe(400);
  });

  it('the governance audit is BEST-EFFORT: a failing audit write still returns 200 (connection + secrets already landed)', async () => {
    const d = deps({ audit: throwingAudit });
    const r = await run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }));
    expect(r.statusCode).toBe(200);
    expect((d.store as FakeStore).rows.size).toBe(2); // both durable writes landed
  });

  it('ORDER (connection before credentials): if a credential write fails AFTER the connection lands, the connection survives (re-set heals); the error propagates (→ 500 at the server boundary)', async () => {
    const store = new FakeStore();
    store.shouldThrowOnCredential = true; // the credential write fails
    const d = deps({ store });
    await expect(run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }))).rejects.toThrow('credential write failed');
    // the connection (the load-bearing projection) DID land; its webhook 401s until a re-set adds secrets
    expect(store.connections).toHaveLength(1);
    expect(store.rows.size).toBe(0); // no secret stored (no orphan secret pointing at no connection)
  });

  it('ORDER (connection first): if the connection write fails, NOTHING is stored — clean failure, no orphan secret', async () => {
    const store = new FakeStore();
    store.shouldThrowOnConnection = true; // the FIRST write fails
    const d = deps({ store });
    await expect(run(d, fakeReq('POST', PATH, { headers: csrf(), body: goodBody }))).rejects.toThrow('connection write failed');
    expect(store.rows.size).toBe(0); // credential writes never reached
    expect(store.connections).toHaveLength(0);
  });

  it('does not claim non-matching routes (returns false → falls through)', async () => {
    const r = await run(deps(), fakeReq('GET', '/api/projects'));
    expect(r.owned).toBe(false);
  });
});

// ── GET status / POST test / DELETE — the consolidated four-verb surface ─────────
// Seed a configured connection (workspace→project + both secrets) so the status/delete reads have a
// connection to resolve.
async function seedConfigured(d: ConnectionApiDeps): Promise<void> {
  await run(d, fakeReq('POST', PATH, { headers: csrf({ 'content-type': 'application/json' }), body: goodBody }));
}

describe('connection API — GET status (member+), POST /test + DELETE (admin+)', () => {
  it('GET (member) returns the connection status with FINGERPRINTS, never a secret', async () => {
    const d = deps();
    await seedConfigured(d);
    const r = await run(deps({ store: d.store, role: 'member' }), fakeReq('GET', PATH));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ connected: true, workspaceId: 'ws-eltexsoft', projectId: PROJECT, webhookUrl: '/webhooks/shortcut/conn_eltexsoft' });
    // per-kind fingerprints present, but NEITHER secret is ever echoed
    const kinds = (r.json.credentials as Array<{ kind: string; fingerprint: string }>).map((c) => c.kind).sort();
    expect(kinds).toEqual(['read_token', 'webhook_secret']);
    expect(r.json.credentials).toContainEqual(expect.objectContaining({ kind: 'webhook_secret', status: 'active', fingerprint: fingerprintConnectionKey('webhook_secret', WEBHOOK_SECRET) }));
    expect(r.body).not.toContain(WEBHOOK_SECRET);
    expect(r.body).not.toContain(READ_TOKEN);
  });

  it('GET when NOTHING is configured returns a not-configured shape (connected:false)', async () => {
    const r = await run(deps(), fakeReq('GET', PATH));
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ connected: false });
  });

  it('GET succeeds (200) even with the master key UNSET — it reads fingerprint/status, never unseals', async () => {
    // Seed under a real key, then read with the same store but no master key in deps (status read needs none).
    const seeded = deps();
    await seedConfigured(seeded);
    const r = await run(deps({ store: seeded.store, masterKey: null }), fakeReq('GET', PATH));
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ connected: true });
  });

  it('GET allowed for a member; POST /test + DELETE are admin-only (member → 403)', async () => {
    const member = deps({ role: 'member' });
    expect((await run(member, fakeReq('GET', PATH))).statusCode).toBe(200);
    const t = await run(deps({ role: 'member' }), fakeReq('POST', `${PATH}/test`, { headers: csrf(), body: JSON.stringify({ readToken: READ_TOKEN }) }));
    expect(t.statusCode).toBe(403);
    const del = await run(deps({ role: 'member' }), fakeReq('DELETE', PATH, { headers: csrf() }));
    expect(del.statusCode).toBe(403);
  });

  it('POST /test maps a passing validator verdict → {ok:true} and probes the SUBMITTED read token', async () => {
    const validator = new FakeValidator();
    const r = await run(deps({ validator }), fakeReq('POST', `${PATH}/test`, { headers: csrf({ 'content-type': 'application/json' }), body: JSON.stringify({ readToken: READ_TOKEN }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(validator.calls).toEqual([{ provider: 'shortcut', token: READ_TOKEN }]);
  });

  it('POST /test maps a failing verdict → {ok:false, reason} (a curated reason, never the token)', async () => {
    const validator = new FakeValidator();
    validator.verdict = { ok: false, reason: 'the token was rejected by the platform (invalid or revoked)' };
    const r = await run(deps({ validator }), fakeReq('POST', `${PATH}/test`, { headers: csrf(), body: JSON.stringify({ readToken: READ_TOKEN }) }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ ok: false, reason: 'the token was rejected by the platform (invalid or revoked)' });
    expect(r.body).not.toContain(READ_TOKEN);
  });

  it('POST /test rejects a missing/blank readToken → 400 (never probes)', async () => {
    const validator = new FakeValidator();
    const r = await run(deps({ validator }), fakeReq('POST', `${PATH}/test`, { headers: csrf(), body: JSON.stringify({ readToken: '' }) }));
    expect(r.statusCode).toBe(400);
    expect(validator.calls).toHaveLength(0);
  });

  it('POST /test with no master key → 503 (the write surface is disabled)', async () => {
    const r = await run(deps({ masterKey: null }), fakeReq('POST', `${PATH}/test`, { headers: csrf(), body: JSON.stringify({ readToken: READ_TOKEN }) }));
    expect(r.statusCode).toBe(503);
  });

  it('DELETE removes the connection AND cascades both credential rows AND invalidates the resolver', async () => {
    const store = new FakeStore();
    const invalidated: string[] = [];
    const resolver = { invalidate: (_o: string, conn: string, kind: ConnectionCredentialKind) => invalidated.push(`${conn}:${kind}`) };
    const d = deps({ store, resolver: resolver as unknown as ConnectionApiDeps['resolver'] });
    await seedConfigured(d);
    expect(store.rows.size).toBe(2);
    invalidated.length = 0; // ignore the POST's cache-bust; assert only the DELETE's

    const r = await run(d, fakeReq('DELETE', PATH, { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(store.connections).toHaveLength(0);
    expect(store.rows.size).toBe(0); // both credential rows cascaded
    expect(invalidated.sort()).toEqual(['conn_eltexsoft:read_token', 'conn_eltexsoft:webhook_secret']);

    // the delete is audited with the connectionId, never a secret
    const audit = (d.audit as FakeAudit).rows;
    expect(audit.some((e) => e.action === 'connection.shortcut.delete' && e.target === 'conn_eltexsoft')).toBe(true);
  });

  it('DELETE when NOTHING is configured → 404 (honest no-op)', async () => {
    const r = await run(deps(), fakeReq('DELETE', PATH, { headers: csrf() }));
    expect(r.statusCode).toBe(404);
  });

  it('DELETE without CSRF → 403, nothing removed', async () => {
    const d = deps();
    await seedConfigured(d);
    const r = await run(deps({ store: d.store }), fakeReq('DELETE', PATH));
    expect(r.statusCode).toBe(403);
    expect((d.store as FakeStore).connections).toHaveLength(1);
  });

  it('DELETE with no master key → 503 (the write surface is disabled)', async () => {
    const d = deps();
    await seedConfigured(d);
    const r = await run(deps({ store: d.store, masterKey: null }), fakeReq('DELETE', PATH, { headers: csrf() }));
    expect(r.statusCode).toBe(503);
    expect((d.store as FakeStore).connections).toHaveLength(1);
  });
});
