// Postgres DDL for the human-login primitive (OAuth-only sign-in). DDL-string
// pattern, mirroring @tasca/identity's schema.ts. These tables back the
// server-side opaque-session model: the first real OAuth login creates the first
// app_user — tables ship EMPTY, never seeded.
//
// Note: the principal table is `app_user`, NOT `user` — `user` is a reserved
// word in Postgres and would force quoting at every reference.

/** A human end-user of the Tasca app. Created on first successful OAuth login. */
export const APP_USER_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS app_user (
  id             text PRIMARY KEY,
  email          text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  avatar_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
-- One account per email regardless of case (GitHub/Google may differ in casing).
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_lower_idx ON app_user (lower(email));`;

/**
 * A provider-account binding (1:N with app_user — a user may link GitHub AND
 * Google). `(provider, provider_user_id)` is unique: a given provider account
 * maps to exactly one app_user.
 */
export const AUTH_IDENTITY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS auth_identity (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('github','google')),
  provider_user_id text NOT NULL,
  provider_email   text,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);`;

/**
 * Short-lived OAuth-flow state. One row per begin-auth call; consumed (deleted)
 * exactly once at callback. Carries the PKCE code_verifier + nonce so the
 * callback can complete the exchange. Swept hourly + on expiry.
 */
export const AUTH_OAUTH_STATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS auth_oauth_state (
  state         text PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('github','google')),
  code_verifier text NOT NULL,
  nonce         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);`;

/**
 * A server-side opaque session. `id` IS the cookie value (a crypto.randomBytes(32)
 * base64url token) — there is no JWT. 7-day TTL with sliding refresh; logout
 * deletes the row; expired rows are swept.
 */
export const AUTH_SESSION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS auth_session (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
-- Logout-all / "my sessions" read path filters by user_id.
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth_session (user_id);`;

/**
 * All auth DDL in dependency order (app_user → dependents). Apply to a clean
 * Postgres to materialize the primitive. FK order matters: app_user must exist
 * before the tables that reference it.
 */
export const AUTH_SCHEMA_DDL: readonly string[] = [
  APP_USER_TABLE_DDL,
  AUTH_IDENTITY_TABLE_DDL,
  AUTH_OAUTH_STATE_TABLE_DDL,
  AUTH_SESSION_TABLE_DDL,
];
