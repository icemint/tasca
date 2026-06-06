import { describe, it, expect } from 'vitest';
import { exchangeCode, fetchIdentity, ProviderError, PROVIDER_CONFIG } from './providers';

// A fake fetch driven by a route table keyed on URL → handler. Mirrors the
// shortcut adapter's injected-fetch test style.
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, ...(init ? { init } : {}) });
    const handler = routes[u];
    if (!handler) throw new Error(`unexpected fetch to ${u}`);
    return handler(init);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe('exchangeCode', () => {
  it('POSTs form-encoded PKCE params and returns the access_token', async () => {
    const { fetch, calls } = fakeFetch({
      [PROVIDER_CONFIG.github.tokenUrl]: () =>
        new Response(JSON.stringify({ access_token: 'gho_abc', token_type: 'bearer' }), { status: 200 }),
    });
    const token = await exchangeCode(
      'github',
      { code: 'c', codeVerifier: 'v', redirectUri: 'https://app.tasca.dev/api/auth/github/callback', clientId: 'id', clientSecret: 'sec' },
      fetch
    );
    expect(token).toBe('gho_abc');
    const body = String(calls[0]!.init!.body);
    expect(body).toContain('code_verifier=v');
    expect(body).toContain('grant_type=authorization_code');
    expect(calls[0]!.init!.method).toBe('POST');
  });

  it('throws ProviderError on a non-2xx token response', async () => {
    const { fetch } = fakeFetch({
      [PROVIDER_CONFIG.google.tokenUrl]: () => new Response('nope', { status: 400 }),
    });
    await expect(
      exchangeCode('google', { code: 'c', codeVerifier: 'v', redirectUri: 'r', clientId: 'i', clientSecret: 's' }, fetch)
    ).rejects.toThrow(ProviderError);
  });

  it('throws ProviderError when access_token is missing', async () => {
    const { fetch } = fakeFetch({
      [PROVIDER_CONFIG.github.tokenUrl]: () => new Response(JSON.stringify({ error: 'bad' }), { status: 200 }),
    });
    await expect(
      exchangeCode('github', { code: 'c', codeVerifier: 'v', redirectUri: 'r', clientId: 'i', clientSecret: 's' }, fetch)
    ).rejects.toThrow(/access_token/);
  });

  it('maps a fetch rejection (timeout) to ProviderError', async () => {
    const impl = (async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(
      exchangeCode('github', { code: 'c', codeVerifier: 'v', redirectUri: 'r', clientId: 'i', clientSecret: 's' }, impl)
    ).rejects.toThrow(ProviderError);
  });
});

describe('fetchIdentity (github)', () => {
  it('resolves the primary verified email from /user/emails', async () => {
    const { fetch } = fakeFetch({
      [PROVIDER_CONFIG.github.userInfoUrl]: () =>
        new Response(JSON.stringify({ id: 42, login: 'octocat', name: 'Octo Cat', email: null, avatar_url: 'http://a' }), { status: 200 }),
      [`${PROVIDER_CONFIG.github.userInfoUrl}/emails`]: () =>
        new Response(
          JSON.stringify([
            { email: 'secondary@x.com', primary: false, verified: true },
            { email: 'me@x.com', primary: true, verified: true },
          ]),
          { status: 200 }
        ),
    });
    const id = await fetchIdentity('github', 'tok', fetch);
    expect(id).toEqual({
      providerUserId: '42',
      email: 'me@x.com',
      emailVerified: true,
      displayName: 'Octo Cat',
      avatarUrl: 'http://a',
    });
  });

  it('falls back to login as displayName when name is null', async () => {
    const { fetch } = fakeFetch({
      [PROVIDER_CONFIG.github.userInfoUrl]: () =>
        new Response(JSON.stringify({ id: 7, login: 'ghost', name: null }), { status: 200 }),
      [`${PROVIDER_CONFIG.github.userInfoUrl}/emails`]: () =>
        new Response(JSON.stringify([{ email: 'g@x.com', primary: true, verified: true }]), { status: 200 }),
    });
    const id = await fetchIdentity('github', 'tok', fetch);
    expect(id.displayName).toBe('ghost');
  });

  it('throws ProviderError on a non-2xx /user', async () => {
    const { fetch } = fakeFetch({
      [PROVIDER_CONFIG.github.userInfoUrl]: () => new Response('unauth', { status: 401 }),
    });
    await expect(fetchIdentity('github', 'tok', fetch)).rejects.toThrow(ProviderError);
  });
});

describe('fetchIdentity (google)', () => {
  it('parses userinfo over TLS and coerces a string email_verified', async () => {
    const { fetch, calls } = fakeFetch({
      [PROVIDER_CONFIG.google.userInfoUrl]: () =>
        new Response(
          JSON.stringify({ sub: 'g-123', email: 'user@gmail.com', email_verified: 'true', name: 'A User', picture: 'http://p' }),
          { status: 200 }
        ),
    });
    const id = await fetchIdentity('google', 'tok', fetch);
    expect(id).toEqual({
      providerUserId: 'g-123',
      email: 'user@gmail.com',
      emailVerified: true,
      displayName: 'A User',
      avatarUrl: 'http://p',
    });
    // Confirms we hit the userinfo endpoint (not local JWT verification).
    expect(calls[0]!.url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
  });

  it('treats a missing email_verified as false', async () => {
    const { fetch } = fakeFetch({
      [PROVIDER_CONFIG.google.userInfoUrl]: () =>
        new Response(JSON.stringify({ sub: 'g-1', email: 'u@x.com' }), { status: 200 }),
    });
    const id = await fetchIdentity('google', 'tok', fetch);
    expect(id.emailVerified).toBe(false);
  });
});
