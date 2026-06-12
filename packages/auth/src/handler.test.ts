import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthHandler } from './handler';
import type { PgAuthRepository } from './auth-repo';

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
