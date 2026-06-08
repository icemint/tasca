import { describe, it, expect, afterEach, vi } from 'vitest';
import { post, ensureCsrf, pauseAgent, _resetCsrfForTest } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
});

/** A fetch stub: GET /api/csrf → a token; POST → the queued responses (consumed in
 *  order), so a test can script a 403-then-200 retry. Records the POSTs. */
function mockWrites(postResponses: Array<{ status: number; body?: unknown }>) {
  const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  let i = 0;
  let csrfFetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const u = String(url);
      if (u === '/api/csrf') {
        csrfFetches++;
        return new Response(JSON.stringify({ token: `tok-${csrfFetches}` }), { status: 200 });
      }
      const r = postResponses[Math.min(i, postResponses.length - 1)]!;
      i++;
      posts.push({ url: u, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
    })
  );
  return { posts, csrfFetches: () => csrfFetches };
}

describe('CSRF token', () => {
  it('fetches once and caches; force re-fetches', async () => {
    const m = mockWrites([]);
    expect(await ensureCsrf()).toBe('tok-1');
    expect(await ensureCsrf()).toBe('tok-1'); // cached, no 2nd fetch
    expect(m.csrfFetches()).toBe(1);
    expect(await ensureCsrf(true)).toBe('tok-2'); // forced
    expect(m.csrfFetches()).toBe(2);
  });
});

describe('post — sends CSRF + classifies every outcome honestly', () => {
  it('200 → ok, with the token echoed in x-csrf-token', async () => {
    const m = mockWrites([{ status: 200, body: { ok: true, version: 5 } }]);
    const r = await post('/api/agents/a1/pause', { version: 4 });
    expect(r).toEqual({ kind: 'ok', data: { ok: true, version: 5 } });
    expect(m.posts[0]!.headers['x-csrf-token']).toBe('tok-1');
    expect(m.posts[0]!.body).toEqual({ version: 4 });
  });

  it('409 → conflict carrying the server truth (currentVersion)', async () => {
    mockWrites([{ status: 409, body: { error: 'changed', currentVersion: 9 } }]);
    const r = await post<{ currentVersion: number }>('/api/agents/a1/pause', { version: 4 });
    expect(r.kind).toBe('conflict');
    expect(r.kind === 'conflict' && r.data.currentVersion).toBe(9);
  });

  it('a 403 refreshes the CSRF token and retries ONCE (self-heals a stale token)', async () => {
    const m = mockWrites([{ status: 403 }, { status: 200, body: { ok: true } }]);
    const r = await post('/api/agents/a1/pause', { version: 1 });
    expect(r.kind).toBe('ok');
    expect(m.posts).toHaveLength(2);
    expect(m.posts[0]!.headers['x-csrf-token']).toBe('tok-1'); // first attempt
    expect(m.posts[1]!.headers['x-csrf-token']).toBe('tok-2'); // retried with a fresh token
  });

  it('a 403 that persists after the retry → forbidden (not a lie)', async () => {
    const m = mockWrites([{ status: 403 }, { status: 403 }]);
    expect((await post('/p', {})).kind).toBe('forbidden');
    expect(m.posts).toHaveLength(2);
  });

  it('a network failure → error (never a false success)', async () => {
    _resetCsrfForTest();
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url) === '/api/csrf') return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      throw new Error('down');
    }));
    expect((await post('/p', {})).kind).toBe('error');
  });
});

describe('post — status classification', () => {
  it.each([
    [401, 'unauth'],
    [404, 'notfound'],
    [503, 'unconfigured'],
    [500, 'error'],
  ])('%i → %s', async (status, kind) => {
    mockWrites([{ status: status as number, body: {} }]);
    expect((await post('/api/agents/a1/pause', { version: 1 })).kind).toBe(kind);
  });
});

describe('agent write helpers', () => {
  it('pauseAgent posts the version to the pause endpoint', async () => {
    const m = mockWrites([{ status: 200, body: { ok: true, version: 2 } }]);
    await pauseAgent('elvis', 1);
    expect(m.posts[0]!.url).toBe('/api/agents/elvis/pause');
    expect(m.posts[0]!.body).toEqual({ version: 1 });
  });
});
