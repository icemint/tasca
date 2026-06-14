import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tier } from '@tasca/domain';
import { writeApiHandler, type WriteApiDeps, type AgentWriter } from './write-api';
import type { TaskWriteOutcome } from './store';
import type { AgentStatus } from '@tasca/domain';
import type { AgentWriteOutcome, CapabilityProfilePatch } from '@tasca/identity';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

class FakeWriteStore {
  calls: string[] = [];
  lastTier: string | undefined;
  /** The org the store was last called with — proves the membership-resolved org (not a default)
   *  is threaded into the write, which is what scopes a mutation to the caller's own tenant. */
  lastOrgId: string | undefined;
  escalateResult: TaskWriteOutcome = { ok: true, status: 'needs_attention' };
  retierResult: TaskWriteOutcome = { ok: true, status: 'routable' };
  reassignResult: TaskWriteOutcome = { ok: true, status: 'routable' };
  interruptResult: TaskWriteOutcome = { ok: true, status: 'needs_attention' };
  forceResetResult: TaskWriteOutcome = { ok: true, status: 'needs_attention' };
  async escalateTask(orgId: string, id: string): Promise<TaskWriteOutcome> {
    this.lastOrgId = orgId;
    this.calls.push(`escalate:${id}`);
    return this.escalateResult;
  }
  async overrideTierEstimate(_orgId: string, id: string, tier: Tier): Promise<TaskWriteOutcome> {
    this.calls.push(`retier:${id}`);
    this.lastTier = tier;
    return this.retierResult;
  }
  async reassignTask(_orgId: string, id: string): Promise<TaskWriteOutcome> {
    this.calls.push(`reassign:${id}`);
    return this.reassignResult;
  }
  async interruptTask(_orgId: string, id: string): Promise<TaskWriteOutcome> {
    this.calls.push(`interrupt:${id}`);
    return this.interruptResult;
  }
  async forceResetTask(orgId: string, id: string): Promise<TaskWriteOutcome> {
    this.lastOrgId = orgId;
    this.calls.push(`force_reset:${id}`);
    return this.forceResetResult;
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
  headers: Record<string, string>;
}
function fakeRes(): { captured: Captured; res: ServerResponse } {
  const captured: Captured = { statusCode: 0, body: '', headers: {} };
  const res = {
    setHeader(k: string, v: string) {
      captured.headers[k.toLowerCase()] = v;
    },
    writeHead(code: number, hdrs?: Record<string, string>) {
      captured.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) captured.headers[k.toLowerCase()] = v;
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
/** Headers carrying a matching double-submit CSRF token. */
const csrf = (extra: Record<string, string | string[]> = {}) => ({
  cookie: `tasca_csrf=${TOK}`,
  'x-csrf-token': TOK,
  ...extra,
});

/** A role reader: maps any user to one active org (null = no membership) + a role in it. Role
 *  defaults to owner so the existing intervention/agent tests pass the 5b role gate. */
const membershipFor = (org: string | null, role: 'owner' | 'admin' | 'member' = 'owner') => ({
  async getActiveOrg() { return org; },
  async getRole() { return org === null ? null : role; },
});

function deps(store: FakeWriteStore, over: Partial<WriteApiDeps> = {}): WriteApiDeps {
  return {
    store,
    membership: membershipFor('org_default'),
    verifySession: () => ({ userId: 'user-1' }),
    secureCookies: false,
    ...over,
  };
}

async function run(d: WriteApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await writeApiHandler(req, res, d);
  return { owned, ...captured };
}

describe('writeApiHandler — routing + ownership', () => {
  it('does not own non-write paths (GET read endpoints, unknown POSTs)', async () => {
    const store = new FakeWriteStore();
    expect((await run(deps(store), fakeReq('GET', '/api/agents'))).owned).toBe(false);
    expect((await run(deps(store), fakeReq('POST', '/api/tasks/t1/frobnicate', { headers: csrf() }))).owned).toBe(false);
  });
});

describe('GET /api/csrf', () => {
  it('issues a double-submit token in a SameSite cookie + the body', async () => {
    const r = await run(deps(new FakeWriteStore()), fakeReq('GET', '/api/csrf'));
    expect(r.owned).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toMatch(/tasca_csrf=[0-9a-f]{64}; Path=\/; SameSite=Strict/);
    expect(JSON.parse(r.body).token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('write auth + CSRF gates', () => {
  it('401 without a valid session', async () => {
    const r = await run(deps(new FakeWriteStore(), { verifySession: () => null }), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
    expect(r.statusCode).toBe(401);
  });

  it('503 when no verifier is wired and not explicitly opened (fail closed)', async () => {
    const r = await run({ store: new FakeWriteStore(), membership: membershipFor('org_default') }, fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
    expect(r.statusCode).toBe(503);
  });

  it('403 when the CSRF header is missing', async () => {
    const r = await run(deps(new FakeWriteStore()), fakeReq('POST', '/api/tasks/t1/escalate', { headers: { cookie: `tasca_csrf=${TOK}` } }));
    expect(r.statusCode).toBe(403);
  });

  it('403 when the CSRF header does not match the cookie', async () => {
    const r = await run(deps(new FakeWriteStore()), fakeReq('POST', '/api/tasks/t1/escalate', { headers: { cookie: `tasca_csrf=${TOK}`, 'x-csrf-token': 'b'.repeat(64) } }));
    expect(r.statusCode).toBe(403);
  });

  it('a write never reaches the store until session AND CSRF pass', async () => {
    const store = new FakeWriteStore();
    await run(deps(store, { verifySession: () => null }), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
    await run(deps(store), fakeReq('POST', '/api/tasks/t1/escalate', { headers: { cookie: `tasca_csrf=${TOK}` } }));
    expect(store.calls).toEqual([]);
  });
});

describe('RBAC org membership (slice 4)', () => {
  it('fail-closed: a verified user with NO membership is rejected (403), and the store is never touched', async () => {
    const store = new FakeWriteStore();
    const r = await run(
      deps(store, { verifySession: () => ({ userId: 'u-orphan' }), membership: membershipFor(null) }),
      fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() })
    );
    expect(r.statusCode).toBe(403); // no membership → fail closed, never DEFAULT_ORG_ID
    expect(store.calls).toEqual([]); // and no mutation attempted
  });

  it('the write is scoped to the user’s RESOLVED org (membership), not a default', async () => {
    const store = new FakeWriteStore();
    const r = await run(
      deps(store, { verifySession: () => ({ userId: 'u-a' }), membership: membershipFor('org_a') }),
      fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() })
    );
    expect(r.statusCode).toBe(200);
    expect(store.lastOrgId).toBe('org_a'); // the membership org threads to the store, not org_default
  });

  it('CROSS-TENANT block: a member of org A mutating an org-B task is rejected (404) — the org-scoped write misses', async () => {
    // The store is org-scoped (slice 3b-2): escalateTask(orgId, taskId) only matches a task IN
    // orgId, returning not_found otherwise. So a user resolved to org A acting on a B-task gets a
    // store not_found → 404. (404, not 403: it does not even leak that the task exists elsewhere.)
    const store = new FakeWriteStore();
    store.escalateResult = { ok: false, reason: 'not_found' }; // the org-A-scoped UPDATE misses the org-B task
    const r = await run(
      deps(store, { verifySession: () => ({ userId: 'u-a' }), membership: membershipFor('org_a') }),
      fakeReq('POST', '/api/tasks/t-in-org-b/escalate', { headers: csrf() })
    );
    expect(r.statusCode).toBe(404);
    expect(store.lastOrgId).toBe('org_a'); // it WAS scoped to the actor's org (A), so the B-task is unreachable
  });
});

describe('task interventions (session + CSRF satisfied)', () => {
  it('escalate → calls the store and returns the new status', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, status: 'needs_attention' });
    expect(store.calls).toEqual(['escalate:t1']);
  });

  it('reassign → 200', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/reassign', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(store.calls).toEqual(['reassign:t1']);
  });

  it('retier → validates the tier and passes it to the store', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/retier', { headers: csrf(), body: JSON.stringify({ tier: 'hard' }) }));
    expect(r.statusCode).toBe(200);
    expect(store.lastTier).toBe('hard');
  });

  it('retier → 400 on an invalid tier (never hits the store)', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/retier', { headers: csrf(), body: JSON.stringify({ tier: 'galaxy' }) }));
    expect(r.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('maps a store conflict → 409 and not_found → 404', async () => {
    const store = new FakeWriteStore();
    store.escalateResult = { ok: false, reason: 'conflict' };
    expect((await run(deps(store), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }))).statusCode).toBe(409);
    store.escalateResult = { ok: false, reason: 'not_found' };
    expect((await run(deps(store), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }))).statusCode).toBe(404);
  });

  it('interrupt → calls interruptTask and returns the new status', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/interrupt', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, status: 'needs_attention' });
    expect(store.calls).toEqual(['interrupt:t1']);
  });

  it('surfaces too_late and no_inflight as DISTINCT 409 codes (not a generic conflict) — the UI-honesty contract', async () => {
    const store = new FakeWriteStore();
    // too_late: the runner already finished — the UI must say "already finished", never "interrupted".
    store.interruptResult = { ok: false, reason: 'too_late' };
    const late = await run(deps(store), fakeReq('POST', '/api/tasks/t1/interrupt', { headers: csrf() }));
    expect(late.statusCode).toBe(409);
    expect(JSON.parse(late.body).code).toBe('too_late');

    // no_inflight: running in-process, no job to cancel — distinct from too_late and from conflict.
    store.interruptResult = { ok: false, reason: 'no_inflight' };
    const inproc = await run(deps(store), fakeReq('POST', '/api/tasks/t1/interrupt', { headers: csrf() }));
    expect(inproc.statusCode).toBe(409);
    expect(JSON.parse(inproc.body).code).toBe('no_inflight');

    // generic conflict keeps its own distinct code.
    store.interruptResult = { ok: false, reason: 'conflict' };
    const conflict = await run(deps(store), fakeReq('POST', '/api/tasks/t1/interrupt', { headers: csrf() }));
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body).code).toBe('conflict');
  });

  it('force-reset → calls forceResetTask and returns the new status (admin escape hatch for issue 317)', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/force-reset', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, status: 'needs_attention' });
    expect(store.calls).toEqual(['force_reset:t1']);
  });

  it('force-reset is idempotent: a second call on an already-cleared task → 409 conflict', async () => {
    const store = new FakeWriteStore();
    store.forceResetResult = { ok: false, reason: 'conflict' };
    const r = await run(deps(store), fakeReq('POST', '/api/tasks/t1/force-reset', { headers: csrf() }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('conflict');
  });

  it('allowUnauthenticated opens the gate for dev (CSRF still required)', async () => {
    const store = new FakeWriteStore();
    const d: WriteApiDeps = { store, membership: membershipFor('org_default'), allowUnauthenticated: true, secureCookies: false };
    expect((await run(d, fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }))).statusCode).toBe(200);
    expect((await run(d, fakeReq('POST', '/api/tasks/t1/escalate', {}))).statusCode).toBe(403); // CSRF still enforced
  });
});

class FakeAgentWriter implements AgentWriter {
  calls: string[] = [];
  statusResult: AgentWriteOutcome = { ok: true, version: 4 };
  profileResult: AgentWriteOutcome = { ok: true, version: 4 };
  lastPatch: CapabilityProfilePatch | undefined;
  async setAgentStatus(id: string, status: AgentStatus, version: number): Promise<AgentWriteOutcome> {
    this.calls.push(`status:${id}:${status}:v${version}`);
    return this.statusResult;
  }
  async updateCapabilityProfile(id: string, patch: CapabilityProfilePatch, version: number): Promise<AgentWriteOutcome> {
    this.calls.push(`profile:${id}:v${version}`);
    this.lastPatch = patch;
    return this.profileResult;
  }
}

describe('agent-state writes (optimistic concurrency via version)', () => {
  function agentDeps(identity: FakeAgentWriter): WriteApiDeps {
    return { store: new FakeWriteStore(), identity, membership: membershipFor('org_default'), verifySession: () => ({ userId: 'u1' }), secureCookies: false };
  }

  it('pause/resume require the version and pass the right status', async () => {
    const id = new FakeAgentWriter();
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({ version: 3 }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, version: 4 });
    await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/resume', { headers: csrf(), body: JSON.stringify({ version: 4 }) }));
    expect(id.calls).toEqual(['status:a1:paused:v3', 'status:a1:active:v4']);
  });

  it('400 when version is missing (optimistic concurrency is mandatory)', async () => {
    const id = new FakeAgentWriter();
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({}) }));
    expect(r.statusCode).toBe(400);
    expect(id.calls).toEqual([]); // never reached the repo
  });

  it('a version_conflict returns 409 WITH currentVersion so the UI can reconcile to truth', async () => {
    const id = new FakeAgentWriter();
    id.statusResult = { ok: false, reason: 'version_conflict', currentVersion: 9 };
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({ version: 3 }) }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).currentVersion).toBe(9);
  });

  it('a missing agent → 404', async () => {
    const id = new FakeAgentWriter();
    id.statusResult = { ok: false, reason: 'not_found' };
    expect((await run(agentDeps(id), fakeReq('POST', '/api/agents/nope/pause', { headers: csrf(), body: JSON.stringify({ version: 0 }) }))).statusCode).toBe(404);
  });

  it('profile edit validates maxTier + numeric fields and forwards the patch', async () => {
    const id = new FakeAgentWriter();
    const ok = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'hard', concurrencyLimit: 3, costCeiling: null }) }));
    expect(ok.statusCode).toBe(200);
    expect(id.lastPatch).toEqual({ maxTier: 'hard', concurrencyLimit: 3, costCeiling: null });

    const badTier = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'galaxy', concurrencyLimit: 3, costCeiling: null }) }));
    expect(badTier.statusCode).toBe(400);
    const badNum = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'hard', concurrencyLimit: 1.5, costCeiling: null }) }));
    expect(badNum.statusCode).toBe(400);
  });

  it('profile edit accepts structured specialties + tier range and forwards them (issue 337)', async () => {
    const id = new FakeAgentWriter();
    const ok = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'hard', concurrencyLimit: 3, costCeiling: null, tiersCovered: ['low', 'hard'], languageSpecialties: ['typescript', 'python'], frameworkSpecialties: ['react'] }) }));
    expect(ok.statusCode).toBe(200);
    expect(id.lastPatch).toEqual({ maxTier: 'hard', concurrencyLimit: 3, costCeiling: null, tiersCovered: ['low', 'hard'], languageSpecialties: ['typescript', 'python'], frameworkSpecialties: ['react'] });
  });

  it('profile edit rejects out-of-taxonomy specialties — the server is the authority, not just the UI', async () => {
    const id = new FakeAgentWriter();
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'hard', concurrencyLimit: 3, costCeiling: null, languageSpecialties: ['cobol'] }) }));
    expect(r.statusCode).toBe(400);
    expect(id.calls).toEqual([]); // never reached the writer
  });

  it('profile edit rejects a covered tier above maxTier (incoherent range)', async () => {
    const id = new FakeAgentWriter();
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'low', concurrencyLimit: 3, costCeiling: null, tiersCovered: ['ultra'] }) }));
    expect(r.statusCode).toBe(400);
    expect(id.calls).toEqual([]);
  });

  it('profile edit rejects an over-long specialty array (bounded payload, no unbounded jsonb)', async () => {
    const id = new FakeAgentWriter();
    const flood = Array.from({ length: 200 }, () => 'typescript'); // all valid, but absurdly long
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'hard', concurrencyLimit: 3, costCeiling: null, languageSpecialties: flood }) }));
    expect(r.statusCode).toBe(400);
    expect(id.calls).toEqual([]);
  });

  it('profile edit WITHOUT specialty fields forwards only the three numerics (preserve-if-absent contract)', async () => {
    const id = new FakeAgentWriter();
    const r = await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/profile', { headers: csrf(), body: JSON.stringify({ version: 2, maxTier: 'medium', concurrencyLimit: 2, costCeiling: 5 }) }));
    expect(r.statusCode).toBe(200);
    expect(id.lastPatch).toEqual({ maxTier: 'medium', concurrencyLimit: 2, costCeiling: 5 }); // no specialty keys
  });

  it('agent routes 503 (not 404) when no identity writer is wired (honest "not enabled")', async () => {
    const d: WriteApiDeps = { store: new FakeWriteStore(), membership: membershipFor('org_default'), verifySession: () => ({ userId: 'u1' }), secureCookies: false };
    const r = await run(d, fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({ version: 0 }) }));
    expect(r.statusCode).toBe(503);
  });

  it('still session+CSRF gated', async () => {
    const id = new FakeAgentWriter();
    expect((await run({ store: new FakeWriteStore(), identity: id, membership: membershipFor('org_default'), verifySession: () => null, secureCookies: false }, fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({ version: 0 }) }))).statusCode).toBe(401);
    expect((await run(agentDeps(id), fakeReq('POST', '/api/agents/a1/pause', { body: JSON.stringify({ version: 0 }) }))).statusCode).toBe(403);
  });
});

describe('role gate (slice 5b) — additive over the membership/tenant gate', () => {
  // Task interventions need member+; agent/roster writes need admin+. The gate is on the endpoint.
  it('a MEMBER may run a task intervention (escalate = member+)', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store, { membership: membershipFor('org_default', 'member') }), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(store.calls).toEqual(['escalate:t1']);
  });

  it('a MEMBER may NOT run a roster/agent write (pause = admin+) → 403, store never touched', async () => {
    const id = new FakeAgentWriter();
    const r = await run(
      { store: new FakeWriteStore(), identity: id, membership: membershipFor('org_default', 'member'), verifySession: () => ({ userId: 'u1' }), secureCookies: false },
      fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({ version: 0 }) })
    );
    expect(r.statusCode).toBe(403); // role gate blocks before the agent write
  });

  it('an ADMIN may run a roster/agent write (pause = admin+)', async () => {
    const id = new FakeAgentWriter();
    const r = await run(
      { store: new FakeWriteStore(), identity: id, membership: membershipFor('org_default', 'admin'), verifySession: () => ({ userId: 'u1' }), secureCookies: false },
      fakeReq('POST', '/api/agents/a1/pause', { headers: csrf(), body: JSON.stringify({ version: 0 }) })
    );
    expect(r.statusCode).toBe(200); // role gate passes; the write proceeds
  });

  it('force-reset is admin+ (stronger than the member-level interrupt): a MEMBER → 403, store never touched', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store, { membership: membershipFor('org_default', 'member') }), fakeReq('POST', '/api/tasks/t1/force-reset', { headers: csrf() }));
    expect(r.statusCode).toBe(403);
    expect(store.calls).toEqual([]); // role gate blocks before the store write
  });

  it('an ADMIN may force-reset a stuck task', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store, { membership: membershipFor('org_default', 'admin') }), fakeReq('POST', '/api/tasks/t1/force-reset', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(store.calls).toEqual(['force_reset:t1']);
  });

  it('the role gate is ADDITIVE: no membership (resolveOrg null) still 403s before the role check', async () => {
    const store = new FakeWriteStore();
    const r = await run(deps(store, { membership: membershipFor(null) }), fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
    expect(r.statusCode).toBe(403); // membership layer (slice 4) fails closed first
    expect(store.calls).toEqual([]);
  });
});
