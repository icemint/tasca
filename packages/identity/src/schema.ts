// Postgres DDL for the agent-identity primitive (scaffold §2.2). DDL-string
// pattern, mirroring @tasca/db's schema.ts. These are the coordination-store
// tables that anchor every agent as a service-user with a stable principal,
// an RBAC role, a capability profile, per-platform identity bindings,
// delegation/attribution, and an append-only audit trail.

/** Reusable least-privilege roles. Agents reference a role; roles are shared. */
export const RBAC_ROLE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS rbac_role (
  id                text PRIMARY KEY,
  name              text NOT NULL UNIQUE,
  permissions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  downstream_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);`;

/** The roster entity. One row per agent ("Elvis"). */
export const AGENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS agent (
  id                      text PRIMARY KEY,
  name                    text NOT NULL,
  avatar_url              text,
  vendor                  text NOT NULL DEFAULT 'claude' CHECK (vendor IN ('claude','openai','local')),
  model                   text NOT NULL,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
  rbac_role_id            text REFERENCES rbac_role(id),
  human_of_record_user_id text,
  version                 integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);`;

/**
 * The agent's internal credential-bearing principal (1:1 with agent).
 *
 * `principal_id` is the stable "who did this" anchor for audit attribution. It
 * is generated once at agent creation and NEVER changes — it does not depend on
 * any external platform credential, so it survives Shortcut-token rotation /
 * re-provisioning (mirrors the Shortcut warning that a `Shortcut-Token` dies if
 * the creating user is removed: the internal principal must not).
 */
export const SERVICE_USER_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS service_user (
  id           text PRIMARY KEY,
  agent_id     text NOT NULL UNIQUE REFERENCES agent(id) ON DELETE CASCADE,
  principal_id text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);`;

/** Vendor/model capability envelope used by the routing engine (1:1 with agent). */
export const CAPABILITY_PROFILE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS capability_profile (
  agent_id              text PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE,
  max_tier              text NOT NULL CHECK (max_tier IN ('basic','low','medium','hard','ultra')),
  tiers_covered         jsonb NOT NULL DEFAULT '[]'::jsonb,
  language_specialties  jsonb NOT NULL DEFAULT '[]'::jsonb,
  framework_specialties jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_window        integer,
  concurrency_limit     integer NOT NULL DEFAULT 1,
  cost_ceiling          numeric,
  avg_latency_ms        integer,
  success_rate          numeric,
  updated_at            timestamptz NOT NULL DEFAULT now()
);`;

/**
 * One row per platform an agent is deployed into. Maps the internal principal to
 * the agent's NATIVE identity on that platform.
 *
 * `credential_ref` is a POINTER into the secret store (never the secret) and is
 * **per-binding** — see bindShortcutIdentity() for why this is the seam that
 * absorbs the single-token-vs-per-agent-identity question. `(agent_id, platform)`
 * is unique: an agent has at most one binding per platform.
 */
export const IDENTITY_BINDING_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS identity_binding (
  id              text PRIMARY KEY,
  agent_id        text NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('shortcut','github','linear')),
  external_id     text NOT NULL,
  external_handle text,
  credential_ref  text,
  state           text NOT NULL DEFAULT 'provisioned' CHECK (state IN ('provisioned','active','revoked')),
  provisioned_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, platform)
);`;

/** Human-of-record / attribution for "agent acted on behalf of" (1:1 with agent). */
export const DELEGATION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS delegation (
  agent_id           text PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE,
  on_behalf_of_user_id text NOT NULL,
  attribution_label  text NOT NULL
);`;

/** Append-only audit trail. Every privileged action attributes to principal_id. */
export const AUDIT_EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS audit_event (
  id           text PRIMARY KEY,
  principal_id text NOT NULL,
  agent_id     text NOT NULL,
  action       text NOT NULL,
  target       text,
  platform     text CHECK (platform IS NULL OR platform IN ('shortcut','github','linear')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
-- Audit read path filters by principal_id, ordered by (at, id) — index it.
CREATE INDEX IF NOT EXISTS audit_event_principal_at_idx ON audit_event (principal_id, at, id);`;

/**
 * All identity DDL in dependency order (roles → agent → dependents). Apply this
 * to a clean Postgres to materialize the primitive. FK order matters: rbac_role
 * and agent must exist before the tables that reference them.
 */
export const IDENTITY_SCHEMA_DDL: readonly string[] = [
  RBAC_ROLE_TABLE_DDL,
  AGENT_TABLE_DDL,
  SERVICE_USER_TABLE_DDL,
  CAPABILITY_PROFILE_TABLE_DDL,
  IDENTITY_BINDING_TABLE_DDL,
  DELEGATION_TABLE_DDL,
  AUDIT_EVENT_TABLE_DDL,
];
