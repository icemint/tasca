// The node:http auth handler. Returns `true` when it handled the request so the
// coordination server can delegate before its 404. Same-origin only (the app is
// served behind nginx that proxies /api/ to this worker) — NO CORS headers.
//
// Routes:
//   GET  /api/auth/:provider            → 302 to the provider authorize URL
//   GET  /api/auth/:provider/callback   → 302 to / (or /?error=...) + session cookie
//   GET  /api/auth/me                   → 200 MeResponse JSON
//   POST /api/auth/logout               → 204, clears the session cookie

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PgAuthRepository } from './auth-repo';
import {
  beginAuth,
  completeAuth,
  SESSION_REFRESH_AFTER_SEC,
  SESSION_TTL_SEC,
  type CompleteAuthError,
  type FlowDeps,
} from './flow';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import { OAUTH_PROVIDERS, type MeResponse, type Provider } from './contract';

/** The session cookie name (host-only on app.tasca.dev). */
export const SESSION_COOKIE = 'tasca_session';
/** The short-lived OAuth-state cookie name (cleared at callback). */
export const OAUTH_COOKIE = 'tasca_oauth';

export interface AuthHandlerDeps extends FlowDeps {
  /**
   * Whether to set the `Secure` cookie attribute. Defaults to true (prod is
   * HTTPS behind nginx). Tests may pass false; never disable in prod.
   */
  secureCookies?: boolean;
}

function isProvider(value: string): value is Provider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

function sessionCookie(value: string, secure: boolean, maxAge: number): string {
  // Host-only: NO Domain= attribute. HttpOnly + SameSite=Lax + Secure.
  return serializeCookie(SESSION_COOKIE, value, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge,
  });
}

function oauthStateCookie(value: string, secure: boolean): string {
  return serializeCookie(OAUTH_COOKIE, value, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    maxAge: 600,
  });
}

function redirectTo(res: ServerResponse, location: string, setCookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { location };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(302, headers);
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

/**
 * Build the auth request handler. Returns an async predicate: `true` if it
 * owned the path (the server stops), `false` to fall through to the next router.
 */
export function createAuthHandler(deps: AuthHandlerDeps) {
  const secure = deps.secureCookies ?? true;

  return async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith('/api/auth/')) return false;

    // Parse path + query (host is irrelevant — same-origin behind nginx).
    const url = new URL(rawUrl, 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const cookies = parseCookies(req.headers.cookie);

    // GET /api/auth/me
    if (method === 'GET' && path === '/api/auth/me') {
      await handleMe(req, res, deps, cookies, secure);
      return true;
    }

    // POST /api/auth/logout
    if (method === 'POST' && path === '/api/auth/logout') {
      const sid = cookies[SESSION_COOKIE];
      if (sid) await deps.repo.deleteSession(sid);
      res.writeHead(204, {
        'set-cookie': [clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'Lax' })],
      });
      res.end();
      return true;
    }

    // GET /api/auth/:provider/callback
    const cbMatch = /^\/api\/auth\/([^/]+)\/callback$/.exec(path);
    if (method === 'GET' && cbMatch) {
      const provider = cbMatch[1]!;
      if (!isProvider(provider)) return false;
      await handleCallback(res, deps, provider, url, cookies, secure);
      return true;
    }

    // GET /api/auth/:provider
    const startMatch = /^\/api\/auth\/([^/]+)$/.exec(path);
    if (method === 'GET' && startMatch) {
      const provider = startMatch[1]!;
      if (!isProvider(provider)) return false;
      const { redirectUrl, oauthCookie } = await beginAuth(provider, deps);
      redirectTo(res, redirectUrl, [oauthStateCookie(oauthCookie, secure)]);
      return true;
    }

    return false;
  };
}

async function handleMe(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AuthHandlerDeps,
  cookies: Record<string, string>,
  secure: boolean
): Promise<void> {
  const sid = cookies[SESSION_COOKIE];
  if (!sid) {
    json(res, 200, { authenticated: false } satisfies MeResponse);
    return;
  }
  const session = await deps.repo.getSession(sid);
  if (!session) {
    // Stale/expired cookie — clear it so the browser stops sending it.
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': [clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'Lax' })],
    });
    res.end(JSON.stringify({ authenticated: false } satisfies MeResponse));
    return;
  }

  // Sliding refresh: if the session is older than the threshold, extend it and
  // re-issue the cookie so an active user stays signed in.
  const ageSec = (Date.now() - session.lastSeenAt.getTime()) / 1000;
  const setCookies: string[] = [];
  if (ageSec > SESSION_REFRESH_AFTER_SEC) {
    await deps.repo.touchSession(sid, SESSION_TTL_SEC);
    setCookies.push(sessionCookie(sid, secure, SESSION_TTL_SEC));
  }

  const body: MeResponse = {
    authenticated: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      avatarUrl: session.user.avatarUrl,
      provider: session.provider,
    },
  };
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
}

async function handleCallback(
  res: ServerResponse,
  deps: AuthHandlerDeps,
  provider: Provider,
  url: URL,
  cookies: Record<string, string>,
  secure: boolean
): Promise<void> {
  // HTTP-layer diagnostic: does the tasca_oauth cookie round-trip back from the browser? If
  // oauthCookiePresent is false while the url carries code+state, the Set-Cookie from /api/auth/:provider
  // never reached the browser (begin response cached at the edge so Set-Cookie was stripped) or was
  // dropped (SameSite/domain/Secure) — the prime suspect behind a state_mismatch. Cookie NAMES only,
  // never values (the value is the single-use state/CSRF token).
  deps.logger?.info?.('auth.callback received', {
    provider,
    hasCode: url.searchParams.has('code'),
    hasState: url.searchParams.has('state'),
    hasErrorParam: url.searchParams.has('error'),
    oauthCookiePresent: Boolean(cookies[OAUTH_COOKIE]),
    cookieNames: Object.keys(cookies),
  });

  const result = await completeAuth(
    provider,
    {
      ...(url.searchParams.get('code') ? { code: url.searchParams.get('code')! } : {}),
      ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}),
      ...(cookies[OAUTH_COOKIE] ? { oauthCookieState: cookies[OAUTH_COOKIE] } : {}),
      ...(url.searchParams.get('error') ? { errorParam: url.searchParams.get('error')! } : {}),
    },
    deps
  );

  // Always clear the short-lived OAuth-state cookie regardless of outcome.
  const clearOauth = clearCookie(OAUTH_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'Lax' });

  if (!result.ok) {
    // The specific branch was already logged inside completeAuth; this records the user-visible
    // mapping (typed error → the `?error=` code the SPA banner reads) so the two correlate in logs.
    deps.logger?.error?.('auth.callback redirecting with error', {
      provider,
      error: result.error,
      redirectCode: errorReason(result.error),
    });
    redirectTo(res, `/?error=${errorReason(result.error)}`, [clearOauth]);
    return;
  }

  redirectTo(res, '/', [
    clearOauth,
    sessionCookie(result.sessionToken, secure, SESSION_TTL_SEC),
  ]);
}

/** Map a typed completeAuth error to the `?error=` code the app banner reads. */
function errorReason(error: CompleteAuthError): string {
  switch (error) {
    case 'denied':
      return 'denied';
    case 'no_email':
      return 'no_email';
    case 'provider_unavailable':
      return 'provider_unavailable';
    case 'state_mismatch':
    default:
      return 'auth';
  }
}
