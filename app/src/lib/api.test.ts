import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAgents, getSession } from './api';
import { stubFetch, stubFetchReject } from './test-support';

afterEach(() => vi.unstubAllGlobals());

describe('read-API client — honest result classification', () => {
  it('returns ok + parsed data on 200', async () => {
    stubFetch({ '/api/agents': { body: [{ id: 'a' }] } });
    const res = await getAgents();
    expect(res).toEqual({ kind: 'ok', data: [{ id: 'a' }] });
  });

  it('classifies 401 as unauth', async () => {
    stubFetch({ '/api/agents': { status: 401, body: { error: 'no' } } });
    expect((await getAgents()).kind).toBe('unauth');
  });

  it('classifies a body {authenticated:false} as unauth (not only 401)', async () => {
    stubFetch({ '/api/auth/me': { body: { authenticated: false } } });
    expect((await getSession()).kind).toBe('unauth');
  });

  it('classifies a 5xx as error with the status', async () => {
    stubFetch({ '/api/agents': { status: 503, body: {} } });
    const res = await getAgents();
    expect(res.kind).toBe('error');
    expect(res).toMatchObject({ message: expect.stringContaining('503') });
  });

  it('classifies a network failure as error', async () => {
    stubFetchReject();
    const res = await getAgents();
    expect(res).toMatchObject({ kind: 'error', message: 'Network unreachable' });
  });

  it('classifies malformed JSON as error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })));
    expect((await getAgents()).kind).toBe('error');
  });
});
