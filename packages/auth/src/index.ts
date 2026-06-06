// @tasca/auth — human OAuth-only sign-in (GitHub + Google) with server-side
// opaque sessions. The browser reaches these routes same-origin at
// app.tasca.dev/api/auth/* (nginx proxies /api/ to the worker) — no CORS.
//
// Boundary: imports ONLY @tasca/domain (+ pg + zod) and node stdlib. The worker
// (@tasca/coordination) is the single composition root that wires the handler.

export {
  APP_USER_TABLE_DDL,
  AUTH_IDENTITY_TABLE_DDL,
  AUTH_OAUTH_STATE_TABLE_DDL,
  AUTH_SESSION_TABLE_DDL,
  AUTH_SCHEMA_DDL,
} from './schema';

export { PgAuthRepository } from './auth-repo';
export type {
  Queryable,
  UpsertUserInput,
  AppUserRecord,
  SessionRecord,
  CreateOAuthStateInput,
  OAuthStateRecord,
} from './auth-repo';

export {
  OAUTH_PROVIDERS,
  ProviderSchema,
  SessionUserSchema,
  MeResponseSchema,
  AuthEnvSchema,
  parseAuthEnv,
} from './contract';
export type {
  Provider,
  SessionUser,
  MeResponse,
  AuthEnv,
  TokenResponse,
  GitHubUser,
  GitHubEmail,
  GoogleUserInfo,
} from './contract';

export { createAuthHandler, SESSION_COOKIE, OAUTH_COOKIE } from './handler';
export type { AuthHandlerDeps } from './handler';

export {
  beginAuth,
  completeAuth,
  SESSION_TTL_SEC,
  OAUTH_STATE_TTL_SEC,
  SESSION_REFRESH_AFTER_SEC,
} from './flow';
export type { FlowDeps, BeginAuthResult, CompleteAuthResult, CompleteAuthError } from './flow';

export {
  exchangeCode,
  fetchIdentity,
  PROVIDER_CONFIG,
  ProviderError,
} from './providers';
export type { ProviderIdentity, ProviderConfig, ExchangeInput } from './providers';

export { parseCookies, serializeCookie, clearCookie } from './cookies';
export type { CookieOptions } from './cookies';
