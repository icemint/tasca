// @vitest-environment happy-dom
// Post-login consume hook (slice 3.5-B.3.2). Proves: a pending token + an authed accept clears
// sessionStorage and shows a success notice; no token → a no-op; a 409/error → cleared + a quiet
// notice (never throws). SECURITY: the raw token is removed from sessionStorage after consume and
// never rendered into the DOM.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { consumePendingInvite } from './invite-consume';
import { PENDING_INVITE_KEY } from './invite-accept';
import { _resetCsrfForTest } from './api';
import { stubFetch } from './test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
  sessionStorage.clear();
  document.body.innerHTML = '';
});

const TOKEN = 'tok-pending-0xABC';

describe('consumePendingInvite', () => {
  it('a pending token + authed accept → clears sessionStorage and shows a success notice', async () => {
    _resetCsrfForTest();
    sessionStorage.setItem(PENDING_INVITE_KEY, TOKEN);
    stubFetch({
      '/api/csrf': { body: { token: 'c1' } },
      '/api/invites/accept': { body: { ok: true, orgId: 'Roadhero', role: 'member' } },
    });

    await consumePendingInvite();

    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull(); // token cleared
    expect(document.body.innerHTML).toContain('joined'); // success notice
    expect(document.body.innerHTML).not.toContain(TOKEN); // the raw token is never rendered
  });

  it('no pending token → a no-op (no fetch, no notice)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await consumePendingInvite();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe('');
  });

  it('a 409 (used/invalid) → clears the token, a quiet notice, never throws', async () => {
    _resetCsrfForTest();
    sessionStorage.setItem(PENDING_INVITE_KEY, TOKEN);
    stubFetch({
      '/api/csrf': { body: { token: 'c1' } },
      '/api/invites/accept': { status: 409, body: { error: 'this invite link is invalid or already used' } },
    });

    await expect(consumePendingInvite()).resolves.toBeUndefined(); // never throws

    expect(sessionStorage.getItem(PENDING_INVITE_KEY)).toBeNull(); // cleared even on failure
    expect(document.body.innerHTML).toContain('invalid or already used'); // quiet notice
  });

  it('the token is removed BEFORE the await, so a second invocation is a no-op (at most once)', async () => {
    _resetCsrfForTest();
    sessionStorage.setItem(PENDING_INVITE_KEY, TOKEN);
    let accepts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input).split('?')[0]!;
        if (path === '/api/csrf') return new Response(JSON.stringify({ token: 'c1' }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (path === '/api/invites/accept') {
          accepts++;
          return new Response(JSON.stringify({ ok: true, orgId: 'Roadhero', role: 'member' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await Promise.all([consumePendingInvite(), consumePendingInvite()]);
    expect(accepts).toBe(1); // the token was claimed once; the racing call saw nothing pending
  });
});
