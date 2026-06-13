// Accept-flow logic (slice 3.5-B.3.2) — pure decision tree, tested with hand-rolled fakes for the
// session + accept dependencies (no DOM, no network). Covers: no token → invalid; authed + ok →
// redirect; authed + 409 → invalid; unauthed → stores token + sign-in.

import { describe, it, expect, vi } from 'vitest';
import { runAcceptFlow, type AcceptDeps } from './invite-accept';
import type { ApiResult, WriteResult } from './api';
import type { SessionResponse } from './contract';

type AcceptResult = WriteResult<{ ok: true; orgId: string; role: string } | { error: string }>;

function deps(over: Partial<AcceptDeps>): { d: AcceptDeps; stored: string[]; redirected: () => number } {
  const stored: string[] = [];
  let redirects = 0;
  const d: AcceptDeps = {
    token: 'tok-1',
    getSession: async (): Promise<ApiResult<SessionResponse>> => ({
      kind: 'ok',
      data: { authenticated: true, user: { id: 'u1', email: 'a@b.c', displayName: null, avatarUrl: null, provider: 'github' } },
    }),
    acceptInvite: async (): Promise<AcceptResult> => ({ kind: 'ok', data: { ok: true, orgId: 'org_x', role: 'member' } }),
    storePendingToken: (t: string) => { stored.push(t); },
    redirectHome: () => { redirects++; },
    ...over,
  };
  return { d, stored, redirected: () => redirects };
}

describe('runAcceptFlow', () => {
  it('no token → invalid (no session call, no accept, no store)', async () => {
    const getSession = vi.fn();
    const acceptInvite = vi.fn();
    const { d } = deps({ token: null, getSession, acceptInvite });
    expect(await runAcceptFlow(d)).toBe('invalid');
    expect(getSession).not.toHaveBeenCalled();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('authenticated + accept ok → accepted, and redirects home', async () => {
    const { d, redirected } = deps({});
    expect(await runAcceptFlow(d)).toBe('accepted');
    expect(redirected()).toBe(1);
  });

  it('authenticated + 409 conflict → invalid (generic), no redirect', async () => {
    const { d, redirected } = deps({
      acceptInvite: async (): Promise<AcceptResult> => ({ kind: 'conflict', data: { error: 'this invite link is invalid or already used' } }),
    });
    expect(await runAcceptFlow(d)).toBe('invalid');
    expect(redirected()).toBe(0);
  });

  it('authenticated + other failure → failed (retryable)', async () => {
    const { d } = deps({ acceptInvite: async (): Promise<AcceptResult> => ({ kind: 'error', message: 'boom' }) });
    expect(await runAcceptFlow(d)).toBe('failed');
  });

  it('not authenticated → stores the token and shows sign-in (no accept attempted)', async () => {
    const acceptInvite = vi.fn();
    const { d, stored } = deps({
      getSession: async (): Promise<ApiResult<SessionResponse>> => ({ kind: 'ok', data: { authenticated: false } }),
      acceptInvite,
    });
    expect(await runAcceptFlow(d)).toBe('signin');
    expect(stored).toEqual(['tok-1']); // token stashed for the post-login consume hook
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('a session read failure is treated as not-authenticated → stores + sign-in', async () => {
    const { d, stored } = deps({
      getSession: async (): Promise<ApiResult<SessionResponse>> => ({ kind: 'error', message: 'network' }),
    });
    expect(await runAcceptFlow(d)).toBe('signin');
    expect(stored).toEqual(['tok-1']);
  });
});
