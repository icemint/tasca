import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Tier } from '@tasca/domain';
import { writeApiHandler, type WriteApiDeps } from './write-api';
import type { TaskWriteOutcome } from './store';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

class FakeWriteStore {
  calls: string[] = [];
  lastTier: string | undefined;
  escalateResult: TaskWriteOutcome = { ok: true, status: 'needs_attention' };
  retierResult: TaskWriteOutcome = { ok: true, status: 'routable' };
  reassignResult: TaskWriteOutcome = { ok: true, status: 'routable' };
  async escalateTask(id: string): Promise<TaskWriteOutcome> {
    this.calls.push(`escalate:${id}`);
    return this.escalateResult;
  }
  async overrideTierEstimate(id: string, tier: Tier): Promise<TaskWriteOutcome> {
    this.calls.push(`retier:${id}`);
    this.lastTier = tier;
    return this.retierResult;
  }
  async reassignTask(id: string): Promise<TaskWriteOutcome> {
    this.calls.push(`reassign:${id}`);
    return this.reassignResult;
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

function deps(store: FakeWriteStore, over: Partial<WriteApiDeps> = {}): WriteApiDeps {
  return {
    store,
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
    const r = await run({ store: new FakeWriteStore() }, fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }));
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

  it('allowUnauthenticated opens the gate for dev (CSRF still required)', async () => {
    const store = new FakeWriteStore();
    const d: WriteApiDeps = { store, allowUnauthenticated: true, secureCookies: false };
    expect((await run(d, fakeReq('POST', '/api/tasks/t1/escalate', { headers: csrf() }))).statusCode).toBe(200);
    expect((await run(d, fakeReq('POST', '/api/tasks/t1/escalate', {}))).statusCode).toBe(403); // CSRF still enforced
  });
});
