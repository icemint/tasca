// Framework-agnostic OAuth flow logic (NO node:http). Pure orchestration over
// the repo + provider functions, both injected. `beginAuth` mints state + PKCE +
// nonce, persists the state, and builds the provider authorize URL.
// `completeAuth` validates the callback, exchanges the code, resolves identity,
// upserts the user, and mints a session — or returns a typed error.

import { createHash, randomBytes } from 'node:crypto';
import type { PgAuthRepository } from './auth-repo';
import {
  exchangeCode,
  fetchIdentity,
  PROVIDER_CONFIG,
  ProviderError,
} from './providers';
import type { Provider } from './contract';

/** State+PKCE TTL (10 min) — long enough for a slow consent screen, short else. */
export const OAUTH_STATE_TTL_SEC = 600;
/** Session TTL (7 days). */
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
/** Sliding-refresh threshold: re-extend a session once it is older than 1 day. */
export const SESSION_REFRESH_AFTER_SEC = 24 * 60 * 60;

/** Structured logger for auth diagnostics (optional — tests omit it). */
export interface AuthLogger {
  info?(message: string, ctx?: Record<string, unknown>): void;
  error?(message: string, ctx?: Record<string, unknown>): void;
}

/** The dependencies the flow needs — repo + provider creds + injectable fetch. */
export interface FlowDeps {
  repo: PgAuthRepository;
  redirectBase: string;
  clientIds: Record<Provider, string>;
  clientSecrets: Record<Provider, string>;
  fetchImpl?: typeof fetch;
  /** Server-side diagnostics for the OAuth callback. Logs the SPECIFIC failure branch (state/cookie
   *  mismatch, provider error, unverified email, …) so a silent `/?error=` redirect is debuggable.
   *  Never logs secrets: no code, client secret, access/session token, cookie value, or email address —
   *  only presence flags, equality, the (non-secret) ProviderError message, and the verified flag. */
  logger?: AuthLogger;
  /**
   * Post-login hook, run after the user is upserted and BEFORE the session is minted (slice 5a).
   * The composition root injects org provisioning here (ensurePersonalOrg), so a logged-in user
   * always has an org by their first request — no no-org window. Opaque to auth: it takes the
   * user id and returns nothing; auth knows nothing about orgs. A throw FAILS the login (the user
   * is never handed a session without an org), surfaced as `provider_unavailable`.
   */
  onLogin?: (userId: string) => Promise<void>;
}

export interface BeginAuthResult {
  redirectUrl: string;
  /** The state token to round-trip in a short-lived host-only cookie. */
  oauthCookie: string;
}

export type CompleteAuthError =
  | 'state_mismatch'
  | 'denied'
  | 'provider_unavailable'
  | 'no_email';

export type CompleteAuthResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: CompleteAuthError };

/** base64url with no padding (PKCE + state want URL-safe tokens). */
function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Build `redirect_uri` from the configured base — never from a Host header. */
function redirectUriFor(base: string, provider: Provider): string {
  return `${base.replace(/\/$/, '')}/api/auth/${provider}/callback`;
}

/**
 * Begin an OAuth login: mint PKCE verifier+challenge, a nonce, and a state token
 * (the persisted state's PK IS the state we send to the provider). Returns the
 * authorize URL to 302 to + the state to set as the OAuth cookie.
 */
export async function beginAuth(provider: Provider, deps: FlowDeps): Promise<BeginAuthResult> {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const nonce = b64url(randomBytes(16));

  const state = await deps.repo.createOAuthState({
    provider,
    codeVerifier,
    nonce,
    ttlSec: OAUTH_STATE_TTL_SEC,
  });

  const cfg = PROVIDER_CONFIG[provider];
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', deps.clientIds[provider]);
  url.searchParams.set('redirect_uri', redirectUriFor(deps.redirectBase, provider));
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'google') {
    url.searchParams.set('nonce', nonce);
    // online access: Google issues NO refresh token (we only need a one-shot
    // identity read at login, never offline/background access on the user's behalf).
    url.searchParams.set('access_type', 'online');
  }

  return { redirectUrl: url.toString(), oauthCookie: state };
}

export interface CompleteAuthInput {
  /** The `code` query param (absent when the user denied consent). */
  code?: string;
  /** The `state` query param from the provider. */
  state?: string;
  /** The state value we stored in the OAuth cookie (CSRF double-submit). */
  oauthCookieState?: string;
  /** Provider error query param (e.g. access_denied). */
  errorParam?: string;
}

/**
 * Complete an OAuth login. Order of checks:
 *   1. provider signalled an error / no code → denied
 *   2. state present, matches the cookie, and consumes a live state row → else state_mismatch
 *   3. exchange code (PKCE) + fetch identity → provider_unavailable on any failure
 *   4. require a usable email → no_email
 *   5. upsert user + mint session → sessionToken
 */
export async function completeAuth(
  provider: Provider,
  input: CompleteAuthInput,
  deps: FlowDeps
): Promise<CompleteAuthResult> {
  const log = deps.logger;
  if (input.errorParam || !input.code) {
    // User cancelled at the consent screen, or the provider sent no code — benign.
    log?.info?.('auth.callback denied', {
      provider,
      reason: input.errorParam ? 'provider_error_param' : 'missing_code',
      errorParam: input.errorParam ?? null,
    });
    return { ok: false, error: 'denied' };
  }
  // CSRF: the state in the URL must equal the state we set in the tasca_oauth cookie. A MISSING
  // cookie here (with the url state present) is the classic "Set-Cookie stripped/cached at the
  // edge, or SameSite/domain dropped it" symptom — distinguished by cookieStatePresent below.
  if (!input.state || !input.oauthCookieState || input.state !== input.oauthCookieState) {
    log?.error?.('auth.callback failed: state/cookie mismatch', {
      provider,
      reason: 'state_cookie_mismatch',
      urlStatePresent: Boolean(input.state),
      cookieStatePresent: Boolean(input.oauthCookieState),
      statesEqual: Boolean(input.state && input.oauthCookieState && input.state === input.oauthCookieState),
    });
    return { ok: false, error: 'state_mismatch' };
  }

  // Consume the persisted state (replay-safe: a second callback finds nothing).
  const stateRow = await deps.repo.consumeOAuthState(input.state);
  if (!stateRow || stateRow.provider !== provider) {
    log?.error?.('auth.callback failed: state row not consumable', {
      provider,
      reason: stateRow ? 'state_provider_mismatch' : 'state_row_not_found',
      // not_found ⇒ the state was never persisted (a CACHED begin response serving a stale token),
      // already consumed (a double callback), or expired (>10 min on the consent screen).
      ...(stateRow ? { rowProvider: stateRow.provider } : {}),
    });
    return { ok: false, error: 'state_mismatch' };
  }

  let identity;
  try {
    const accessToken = await exchangeCode(
      provider,
      {
        code: input.code,
        codeVerifier: stateRow.codeVerifier,
        redirectUri: redirectUriFor(deps.redirectBase, provider),
        clientId: deps.clientIds[provider],
        clientSecret: deps.clientSecrets[provider],
      },
      deps.fetchImpl
    );
    identity = await fetchIdentity(provider, accessToken, deps.fetchImpl);
  } catch (err) {
    if (err instanceof ProviderError) {
      // ProviderError messages are non-secret (e.g. "token exchange github returned 401",
      // "token exchange response missing access_token") and pinpoint exchange vs identity fetch.
      log?.error?.('auth.callback failed: provider error', {
        provider,
        reason: 'provider_error',
        detail: err.message,
        redirectUri: redirectUriFor(deps.redirectBase, provider),
      });
      return { ok: false, error: 'provider_unavailable' };
    }
    log?.error?.('auth.callback threw (non-provider error)', { provider, err: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  // Require a VERIFIED email. email (lower-cased) is unique per app_user, so an
  // unverified address would let a user register / collide on an email they have
  // not proven they own — refuse it rather than admit an unverified identity.
  if (!identity.email || !identity.emailVerified) {
    log?.error?.('auth.callback failed: email unverified or missing', {
      provider,
      reason: 'email_unverified_or_missing',
      hasEmail: Boolean(identity.email),
      emailVerified: identity.emailVerified,
    });
    return { ok: false, error: 'no_email' };
  }

  const user = await deps.repo.upsertUserFromProvider({
    provider,
    providerUserId: identity.providerUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
  });

  // Provision the user's org BEFORE minting the session (slice 5a), so a logged-in user always has
  // an org by their first request. A failure here fails the login rather than handing out a session
  // with no org (which would dead-end at a 403) — the user simply retries; the hook is idempotent.
  if (deps.onLogin) {
    try {
      await deps.onLogin(user.id);
    } catch (err) {
      log?.error?.('auth.callback failed: onLogin (org provisioning) threw', {
        provider,
        reason: 'onlogin_failed',
        userId: user.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'provider_unavailable' };
    }
  }

  const sessionToken = await deps.repo.createSession(user.id, SESSION_TTL_SEC);
  log?.info?.('auth.callback success', { provider, userId: user.id });
  return { ok: true, sessionToken };
}
