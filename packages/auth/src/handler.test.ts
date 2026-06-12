import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthHandler } from './handler';
import { beginAuth } from './flow';
import { PROVIDER_CONFIG } from './providers';
import type { PgAuthRepository, OAuthStateRecord, AppUserRecord } from './auth-repo';

// Capture what the handler writes to the response (status + headers), without a real socket.
function fakeRes() {
  const captured = { status: 0, headers: {} as Record<string, string | string[]>, ended: false };
  const res = {
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      captured.status = status;
      if (headers) captured.headers = headers;
      return res;
    },
    end() {
      captured.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

// Minimal repo: begin only calls createOAuthState.
const repo = {
  createOAuthState: async () => 'state-xyz',
} as unknown as PgAuthRepository;

function handler() {
  return createAuthHandler({
    repo,
    redirectBase: 'https://app.tasca.dev',
    clientIds: { github: 'gh-id', google: 'goog-id' },
    clientSecrets: { github: 'gh-sec', google: 'goog-sec' },
  });
}

// A fuller in-memory repo for the callback success path (begin seeds state; callback consumes it,
// upserts the user, and mints a session). Real state, no mocking framework.
class FakeRepo {
  states = new Map<string, OAuthStateRecord>();
  private n = 0;
  async createOAuthState(input: { provider: 'github' | 'google'; codeVerifier: string; nonce: string; ttlSec: number }) {
    const state = `state-${++this.n}`;
    this.states.set(state, { state, provider: input.provider, codeVerifier: input.codeVerifier, nonce: input.nonce });
    return state;
  }
  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const row = this.states.get(state);
    if (!row) return null;
    this.states.delete(state);
    return row;
  }
  async upsertUserFromProvider(input: { email: string; displayName: string | null; avatarUrl: string | null }): Promise<AppUserRecord> {
    return { id: 'usr_1', email: input.email, emailVerified: true, displayName: input.displayName, avatarUrl: input.avatarUrl };
  }
  async createSession(): Promise<string> {
    return 'sess-abc';
  }
}

const githubSuccessFetch = ((url: string | URL | Request) => {
  const u = String(url);
  if (u === PROVIDER_CONFIG.github.tokenUrl) return Promise.resolve(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }));
  if (u === PROVIDER_CONFIG.github.userInfoUrl) return Promise.resolve(new Response(JSON.stringify({ id: 1, login: 'dev', name: 'Dev', avatar_url: 'http://a' }), { status: 200 }));
  if (u === `${PROVIDER_CONFIG.github.userInfoUrl}/emails`) return Promise.resolve(new Response(JSON.stringify([{ email: 'dev@x.com', primary: true, verified: true }]), { status: 200 }));
  throw new Error(`unexpected fetch ${u}`);
}) as unknown as typeof fetch;

describe('auth handler — a successful callback lands in the app, not back on the login page', () => {
  it('GET /api/auth/github/callback (valid) → 302 /roster with tasca_session + Cache-Control: no-store', async () => {
    const repo = new FakeRepo();
    const flowDeps = {
      repo: repo as unknown as PgAuthRepository,
      redirectBase: 'https://app.tasca.dev',
      clientIds: { github: 'gh-id', google: 'goog-id' },
      clientSecrets: { github: 'gh-sec', google: 'goog-sec' },
    };
    const { oauthCookie } = await beginAuth('github', flowDeps);
    const h = createAuthHandler({ ...flowDeps, fetchImpl: githubSuccessFetch });

    const { res, captured } = fakeRes();
    const req = {
      url: `/api/auth/github/callback?code=c&state=${oauthCookie}`,
      method: 'GET',
      headers: { cookie: `tasca_oauth=${oauthCookie}` },
    } as unknown as IncomingMessage;
    const owned = await h(req, res);

    expect(owned).toBe(true);
    expect(captured.status).toBe(302);
    expect(captured.headers['location']).toBe('/roster'); // the app home — NOT `/` (the login page → the loop)
    expect(captured.headers['cache-control']).toBe('no-store'); // the session Set-Cookie is never cacheable
    const setCookie = captured.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    expect(cookieStr).toContain('tasca_session=sess-abc');
  });

  it('a FAILED callback still returns to `/?error=…` (the login page shows the reason)', async () => {
    const repo = new FakeRepo();
    const flowDeps = {
      repo: repo as unknown as PgAuthRepository,
      redirectBase: 'https://app.tasca.dev',
      clientIds: { github: 'gh-id', google: 'goog-id' },
      clientSecrets: { github: 'gh-sec', google: 'goog-sec' },
    };
    const h = createAuthHandler({ ...flowDeps, fetchImpl: githubSuccessFetch });
    const { res, captured } = fakeRes();
    // No oauth cookie → state mismatch → failure path.
    const req = { url: `/api/auth/github/callback?code=c&state=s`, method: 'GET', headers: {} } as unknown as IncomingMessage;
    await h(req, res);
    expect(captured.status).toBe(302);
    expect(String(captured.headers['location'])).toMatch(/^\/\?error=/);
  });
});

describe('auth handler — the begin redirect must be non-cacheable (no edge may cache the Set-Cookie)', () => {
  for (const provider of ['github', 'google'] as const) {
    it(`GET /api/auth/${provider} → 302 with Cache-Control: no-store AND the tasca_oauth cookie`, async () => {
      const { res, captured } = fakeRes();
      const req = { url: `/api/auth/${provider}`, method: 'GET', headers: {} } as unknown as IncomingMessage;
      const owned = await handler()(req, res);

      expect(owned).toBe(true);
      expect(captured.status).toBe(302);
      // The origin asserts non-cacheability — so a cookie-setting 302 can never be cached at the edge.
      expect(captured.headers['cache-control']).toBe('no-store');
      const setCookie = captured.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
      expect(cookieStr).toContain('tasca_oauth=');
      // And it 302s to the provider's real authorize endpoint.
      expect(String(captured.headers['location'])).toContain(provider === 'github' ? 'github.com/login/oauth/authorize' : 'accounts.google.com');
    });
  }
});
