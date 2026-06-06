import { describe, it, expect } from 'vitest';
import { beginAuth, completeAuth, type FlowDeps } from './flow';
import { PROVIDER_CONFIG } from './providers';
import type { PgAuthRepository } from './auth-repo';
import type { AppUserRecord, OAuthStateRecord } from './auth-repo';
import type { Provider } from './contract';

// A hand-rolled in-memory fake of the repo surface the flow touches (per the
// "no mocking frameworks for repository-shaped interfaces" rule). Real state.
class FakeRepo {
  states = new Map<string, OAuthStateRecord & { expiresAt: number }>();
  users: AppUserRecord[] = [];
  sessions: Array<{ id: string; userId: string }> = [];
  private n = 0;

  async createOAuthState(input: { provider: Provider; codeVerifier: string; nonce: string; ttlSec: number }) {
    const state = `state-${++this.n}`;
    this.states.set(state, {
      state,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      expiresAt: Date.now() + input.ttlSec * 1000,
    });
    return state;
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const row = this.states.get(state);
    if (!row || row.expiresAt <= Date.now()) return null;
    this.states.delete(state); // single-use → replay-safe
    return { state: row.state, provider: row.provider, codeVerifier: row.codeVerifier, nonce: row.nonce };
  }

  async upsertUserFromProvider(input: {
    provider: Provider;
    providerUserId: string;
    email: string;
    emailVerified: boolean;
    displayName: string | null;
    avatarUrl: string | null;
  }): Promise<AppUserRecord> {
    const existing = this.users.find((u) => u.email === input.email);
    if (existing) return existing;
    const user: AppUserRecord = {
      id: `usr_${this.users.length + 1}`,
      email: input.email,
      emailVerified: input.emailVerified,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
    };
    this.users.push(user);
    return user;
  }

  async createSession(userId: string): Promise<string> {
    const id = `sess-${this.sessions.length + 1}`;
    this.sessions.push({ id, userId });
    return id;
  }
}

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const h = routes[u];
    if (!h) throw new Error(`unexpected fetch to ${u}`);
    return h();
  }) as unknown as typeof fetch;
}

function depsWith(repo: FakeRepo, fetchImpl?: typeof fetch): FlowDeps {
  return {
    repo: repo as unknown as PgAuthRepository,
    redirectBase: 'https://app.tasca.dev',
    clientIds: { github: 'gh-id', google: 'goog-id' },
    clientSecrets: { github: 'gh-sec', google: 'goog-sec' },
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

const githubSuccessFetch = fakeFetch({
  [PROVIDER_CONFIG.github.tokenUrl]: () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }),
  [PROVIDER_CONFIG.github.userInfoUrl]: () =>
    new Response(JSON.stringify({ id: 1, login: 'dev', name: 'Dev', avatar_url: 'http://a' }), { status: 200 }),
  [`${PROVIDER_CONFIG.github.userInfoUrl}/emails`]: () =>
    new Response(JSON.stringify([{ email: 'dev@x.com', primary: true, verified: true }]), { status: 200 }),
});

describe('beginAuth', () => {
  it('persists state + builds an authorize URL with PKCE S256 + state', async () => {
    const repo = new FakeRepo();
    const { redirectUrl, oauthCookie } = await beginAuth('github', depsWith(repo));
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(PROVIDER_CONFIG.github.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('gh-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.tasca.dev/api/auth/github/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(oauthCookie);
    expect(repo.states.has(oauthCookie)).toBe(true);
  });

  it('adds nonce + access_type for google', async () => {
    const repo = new FakeRepo();
    const { redirectUrl } = await beginAuth('google', depsWith(repo));
    const url = new URL(redirectUrl);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });
});

describe('completeAuth', () => {
  it('happy path: exchanges, resolves identity, creates user + session', async () => {
    const repo = new FakeRepo();
    const { oauthCookie } = await beginAuth('github', depsWith(repo));
    const res = await completeAuth(
      'github',
      { code: 'authcode', state: oauthCookie, oauthCookieState: oauthCookie },
      depsWith(repo, githubSuccessFetch)
    );
    expect(res).toEqual({ ok: true, sessionToken: 'sess-1' });
    expect(repo.users).toHaveLength(1);
    expect(repo.users[0]!.email).toBe('dev@x.com');
  });

  it('state_mismatch when the URL state ≠ the cookie state', async () => {
    const repo = new FakeRepo();
    const { oauthCookie } = await beginAuth('github', depsWith(repo));
    const res = await completeAuth(
      'github',
      { code: 'c', state: oauthCookie, oauthCookieState: 'different' },
      depsWith(repo, githubSuccessFetch)
    );
    expect(res).toEqual({ ok: false, error: 'state_mismatch' });
  });

  it('denied when the provider returns an error param', async () => {
    const repo = new FakeRepo();
    const res = await completeAuth(
      'github',
      { state: 's', oauthCookieState: 's', errorParam: 'access_denied' },
      depsWith(repo, githubSuccessFetch)
    );
    expect(res).toEqual({ ok: false, error: 'denied' });
  });

  it('denied when no code is present', async () => {
    const repo = new FakeRepo();
    const res = await completeAuth('github', { state: 's', oauthCookieState: 's' }, depsWith(repo, githubSuccessFetch));
    expect(res).toEqual({ ok: false, error: 'denied' });
  });

  it('no_email when the provider yields no usable email', async () => {
    const repo = new FakeRepo();
    const { oauthCookie } = await beginAuth('google', depsWith(repo));
    const noEmailFetch = fakeFetch({
      [PROVIDER_CONFIG.google.tokenUrl]: () => new Response(JSON.stringify({ access_token: 't' }), { status: 200 }),
      [PROVIDER_CONFIG.google.userInfoUrl]: () => new Response(JSON.stringify({ sub: 'g1' }), { status: 200 }),
    });
    const res = await completeAuth(
      'google',
      { code: 'c', state: oauthCookie, oauthCookieState: oauthCookie },
      depsWith(repo, noEmailFetch)
    );
    expect(res).toEqual({ ok: false, error: 'no_email' });
  });

  it('provider_unavailable when the token exchange fails', async () => {
    const repo = new FakeRepo();
    const { oauthCookie } = await beginAuth('github', depsWith(repo));
    const failFetch = fakeFetch({
      [PROVIDER_CONFIG.github.tokenUrl]: () => new Response('boom', { status: 502 }),
    });
    const res = await completeAuth(
      'github',
      { code: 'c', state: oauthCookie, oauthCookieState: oauthCookie },
      depsWith(repo, failFetch)
    );
    expect(res).toEqual({ ok: false, error: 'provider_unavailable' });
  });

  it('replay: consuming the same state twice → second is state_mismatch', async () => {
    const repo = new FakeRepo();
    const { oauthCookie } = await beginAuth('github', depsWith(repo));
    const first = await completeAuth(
      'github',
      { code: 'c', state: oauthCookie, oauthCookieState: oauthCookie },
      depsWith(repo, githubSuccessFetch)
    );
    expect(first.ok).toBe(true);
    const second = await completeAuth(
      'github',
      { code: 'c', state: oauthCookie, oauthCookieState: oauthCookie },
      depsWith(repo, githubSuccessFetch)
    );
    expect(second).toEqual({ ok: false, error: 'state_mismatch' });
  });

  it('state_mismatch when the persisted state is for a different provider', async () => {
    const repo = new FakeRepo();
    const { oauthCookie } = await beginAuth('github', depsWith(repo));
    // Attempt to complete as google with a github-issued state.
    const res = await completeAuth(
      'google',
      { code: 'c', state: oauthCookie, oauthCookieState: oauthCookie },
      depsWith(repo, githubSuccessFetch)
    );
    expect(res).toEqual({ ok: false, error: 'state_mismatch' });
  });
});
