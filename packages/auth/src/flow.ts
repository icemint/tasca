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

/** The dependencies the flow needs — repo + provider creds + injectable fetch. */
export interface FlowDeps {
  repo: PgAuthRepository;
  redirectBase: string;
  clientIds: Record<Provider, string>;
  clientSecrets: Record<Provider, string>;
  fetchImpl?: typeof fetch;
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
    // Always return a refreshable consent so a revoked grant re-prompts cleanly.
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
  if (input.errorParam || !input.code) {
    return { ok: false, error: 'denied' };
  }
  // CSRF: the state in the URL must equal the state we set in the cookie.
  if (!input.state || !input.oauthCookieState || input.state !== input.oauthCookieState) {
    return { ok: false, error: 'state_mismatch' };
  }

  // Consume the persisted state (replay-safe: a second callback finds nothing).
  const stateRow = await deps.repo.consumeOAuthState(input.state);
  if (!stateRow || stateRow.provider !== provider) {
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
    if (err instanceof ProviderError) return { ok: false, error: 'provider_unavailable' };
    throw err;
  }

  if (!identity.email) {
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

  const sessionToken = await deps.repo.createSession(user.id, SESSION_TTL_SEC);
  return { ok: true, sessionToken };
}
