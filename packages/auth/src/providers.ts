// Per-provider OAuth wiring (GitHub + Google). Authorization-code + PKCE (S256)
// for both. All external calls go through an injected `fetchImpl` (defaults to
// the global `fetch`) so tests pass a fake, and every call carries an 8s
// AbortSignal.timeout so a hung provider can't wedge the worker.
//
// Google identity is validated via the userinfo endpoint over TLS — we do NOT
// verify the id_token JWT locally (keeps us off a JWT lib / `jose`).

import {
  GitHubEmailsSchema,
  GitHubUserSchema,
  GoogleUserInfoSchema,
  TokenResponseSchema,
  type Provider,
} from './contract';

const TIMEOUT_MS = 8000;

export interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

/** Static endpoint + scope config per provider. */
export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
  },
};

/** The normalized identity every provider resolves to. */
export interface ProviderIdentity {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}

/** A thrown exchange/identity failure — surfaced to the flow as provider_unavailable. */
export class ProviderError extends Error {}

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/**
 * Exchange an authorization code (+ PKCE verifier) for an access token. Both
 * providers accept form-encoded bodies; we force JSON responses via Accept.
 * Returns the bearer access token.
 */
export async function exchangeCode(
  provider: Provider,
  input: ExchangeInput,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const cfg = PROVIDER_CONFIG[provider];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });

  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: withTimeout(),
    });
  } catch (err) {
    throw new ProviderError(`token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new ProviderError(`token exchange ${provider} returned ${res.status}`);

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ProviderError('token exchange returned non-JSON');
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('token exchange response missing access_token');
  return parsed.data.access_token;
}

/** Resolve the normalized provider identity from a bearer access token. */
export async function fetchIdentity(
  provider: Provider,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProviderIdentity> {
  return provider === 'github'
    ? fetchGitHubIdentity(accessToken, fetchImpl)
    : fetchGoogleIdentity(accessToken, fetchImpl);
}

async function getJson(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'user-agent': 'tasca-auth',
      },
      signal: withTimeout(),
    });
  } catch (err) {
    throw new ProviderError(`identity fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new ProviderError(`identity fetch ${url} returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ProviderError('identity fetch returned non-JSON');
  }
}

async function fetchGitHubIdentity(accessToken: string, fetchImpl: typeof fetch): Promise<ProviderIdentity> {
  const userJson = await getJson(PROVIDER_CONFIG.github.userInfoUrl, accessToken, fetchImpl);
  const user = GitHubUserSchema.safeParse(userJson);
  if (!user.success) throw new ProviderError('github /user response malformed');

  // The /user payload's `email` is often null (private). Resolve the primary,
  // verified address from /user/emails.
  let email = user.data.email ?? null;
  let emailVerified = false;
  const emailsJson = await getJson(`${PROVIDER_CONFIG.github.userInfoUrl}/emails`, accessToken, fetchImpl);
  const emails = GitHubEmailsSchema.safeParse(emailsJson);
  if (emails.success) {
    const primary = emails.data.find((e) => e.primary && e.verified)
      ?? emails.data.find((e) => e.verified);
    if (primary) {
      email = primary.email;
      emailVerified = primary.verified;
    }
  }

  return {
    providerUserId: String(user.data.id),
    email,
    emailVerified,
    displayName: user.data.name ?? user.data.login,
    avatarUrl: user.data.avatar_url ?? null,
  };
}

async function fetchGoogleIdentity(accessToken: string, fetchImpl: typeof fetch): Promise<ProviderIdentity> {
  const json = await getJson(PROVIDER_CONFIG.google.userInfoUrl, accessToken, fetchImpl);
  const info = GoogleUserInfoSchema.safeParse(json);
  if (!info.success) throw new ProviderError('google userinfo response malformed');

  // Google returns email_verified as either a boolean or the string "true".
  const verified = info.data.email_verified === true || info.data.email_verified === 'true';
  return {
    providerUserId: info.data.sub,
    email: info.data.email ?? null,
    emailVerified: verified,
    displayName: info.data.name ?? null,
    avatarUrl: info.data.picture ?? null,
  };
}
