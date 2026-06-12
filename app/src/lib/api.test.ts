import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAgents, getSession, redirectIfAuthenticated, canManageActiveOrg, connectGitHub } from './api';
import { stubFetch, stubFetchReject } from './test-support';

afterEach(() => vi.unstubAllGlobals());

describe('canManageActiveOrg — admin gate, fail-closed', () => {
  const orgs = (o: unknown) => stubFetch({ '/api/orgs': { body: { orgs: o } } });
  it('true when the ACTIVE org role is admin', async () => {
    orgs([{ id: 'o1', name: 'A', role: 'admin', active: true }]);
    expect(await canManageActiveOrg()).toBe(true);
  });
  it('true for owner', async () => {
    orgs([{ id: 'o1', name: 'A', role: 'owner', active: true }]);
    expect(await canManageActiveOrg()).toBe(true);
  });
  it('false for member / viewer', async () => {
    orgs([{ id: 'o1', name: 'A', role: 'member', active: true }]);
    expect(await canManageActiveOrg()).toBe(false);
  });
  it('reads the ACTIVE org, not another org the user owns', async () => {
    orgs([
      { id: 'o1', name: 'A', role: 'owner', active: false },
      { id: 'o2', name: 'B', role: 'viewer', active: true },
    ]);
    expect(await canManageActiveOrg()).toBe(false); // active org = the viewer one
  });
  it('fail-closed: false when /api/orgs errors (never falsely enable)', async () => {
    stubFetch({ '/api/orgs': { status: 503, body: {} } });
    expect(await canManageActiveOrg()).toBe(false);
  });
  it('fail-closed: false when the user has no orgs', async () => {
    orgs([]);
    expect(await canManageActiveOrg()).toBe(false); // no active org → no manage rights
  });
});

describe('connectGitHub — begins the install via a navigation', () => {
  it('assigns location to /api/connect/github (redirect-out, not a write)', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, replace: vi.fn(), search: '' });
    connectGitHub();
    expect(assign).toHaveBeenCalledWith('/api/connect/github');
  });
});

describe('redirectIfAuthenticated — the login page must not loop an already-authenticated user', () => {
  it('redirects into the app (location.replace to home) when the session is authenticated', async () => {
    stubFetch({ '/api/auth/me': { body: { authenticated: true, user: { id: 'u1', email: 'a@b.com', displayName: 'A', avatarUrl: null, provider: 'github' } } } });
    const replace = vi.fn();
    vi.stubGlobal('location', { replace, assign: vi.fn(), search: '' });
    const did = await redirectIfAuthenticated('/roster');
    expect(did).toBe(true);
    expect(replace).toHaveBeenCalledWith('/roster'); // replace, not assign — login is not left in history
  });

  it('does NOT redirect when unauthenticated (stays on the login page)', async () => {
    stubFetch({ '/api/auth/me': { body: { authenticated: false } } });
    const replace = vi.fn();
    vi.stubGlobal('location', { replace, assign: vi.fn(), search: '' });
    const did = await redirectIfAuthenticated('/roster');
    expect(did).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does NOT redirect on a transient /api/auth/me error (no false bounce)', async () => {
    stubFetch({ '/api/auth/me': { status: 503, body: {} } });
    const replace = vi.fn();
    vi.stubGlobal('location', { replace, assign: vi.fn(), search: '' });
    expect(await redirectIfAuthenticated('/roster')).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

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
