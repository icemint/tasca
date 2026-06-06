import { z } from 'zod';

// @tasca/auth contracts — Zod schemas at every trust boundary (provider HTTP
// responses, the /api/auth/me wire shape, the worker's OAuth env). TS types are
// inferred from the schemas (schema is the source of truth). Mirrors the
// @tasca/contracts "Zod-at-the-boundary" convention.

/** The two supported OAuth providers. */
export const OAUTH_PROVIDERS = ['github', 'google'] as const;
export const ProviderSchema = z.enum(OAUTH_PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

// ── /api/auth/me wire shapes ──────────────────────────────────────────────────

/** The authenticated user as surfaced to the app shell (never leaks tokens). */
export const SessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  provider: ProviderSchema,
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/** GET /api/auth/me — discriminated on `authenticated`. */
export const MeResponseSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(true), user: SessionUserSchema }),
  z.object({ authenticated: z.literal(false) }),
]);
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ── Provider HTTP response boundary guards (.passthrough — providers add fields) ─

/** OAuth token endpoint response (GitHub + Google share the core shape). */
export const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional(),
    expires_in: z.number().optional(),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/** GitHub GET /user. */
export const GitHubUserSchema = z
  .object({
    id: z.number(),
    login: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    avatar_url: z.string().optional(),
  })
  .passthrough();
export type GitHubUser = z.infer<typeof GitHubUserSchema>;

/** GitHub GET /user/emails (used to find a primary, verified address). */
export const GitHubEmailSchema = z
  .object({
    email: z.string(),
    primary: z.boolean(),
    verified: z.boolean(),
  })
  .passthrough();
export const GitHubEmailsSchema = z.array(GitHubEmailSchema);
export type GitHubEmail = z.infer<typeof GitHubEmailSchema>;

/** Google OIDC userinfo (validated over TLS — we do NOT verify the id_token JWT). */
export const GoogleUserInfoSchema = z
  .object({
    sub: z.string(),
    email: z.string().optional(),
    email_verified: z.union([z.boolean(), z.string()]).optional(),
    name: z.string().optional(),
    picture: z.string().optional(),
  })
  .passthrough();
export type GoogleUserInfo = z.infer<typeof GoogleUserInfoSchema>;

// ── Worker OAuth env ──────────────────────────────────────────────────────────

/**
 * The 5 OAuth env vars. ALL must be present (and non-empty) for auth to enable;
 * if any is missing the worker leaves the /api/auth/* routes disabled (404) and
 * logs "auth disabled (OAuth env unset)" — feature flag OFF by default.
 */
export const AuthEnvSchema = z.object({
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  OAUTH_REDIRECT_BASE: z.string().url(),
});
export type AuthEnv = z.infer<typeof AuthEnvSchema>;

/**
 * Parse the OAuth env from a record (defaults to process.env). Returns the
 * validated config, or null if any var is missing/invalid — the caller treats
 * null as "auth disabled" (never throws, never half-enables).
 */
export function parseAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv | null {
  const parsed = AuthEnvSchema.safeParse(env);
  return parsed.success ? parsed.data : null;
}
