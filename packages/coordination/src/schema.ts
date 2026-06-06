// Postgres DDL for the coordination store (scaffold §7) — the tables the
// orchestration loop persists into beyond the minimal `task` slice that already
// ships in @tasca/db. DDL-string pattern, FK-ordered, with CHECK constraints on
// enum columns (mirrors the @tasca/identity hardening style).
//
// What lives where:
//   - @tasca/db owns the base `task` table (the CAS target).
//   - @tasca/identity owns the agent/identity primitive tables.
//   - this module owns the *coordination* tables: routing_decision,
//     pull_request, platform_connection, webhook_event — plus the extra `task`
//     columns the loop reads/writes (tier_estimate, claimed_by, failure_count,
//     repo_ref, platform, external_story_id, timestamps).
//
// Boundary: coordination is the composition root (§1.3) and may compose all the
// inner schemas; nothing inner depends on this.

/**
 * Additive columns the orchestration loop needs on `task`, layered over the
 * @tasca/db base table with `ADD COLUMN IF NOT EXISTS` so applying both DDLs to
 * one database is order-independent and idempotent. The base table already
 * carries id/external_story_id/platform/status/version/claimed_by/failure_count/
 * repo_ref; here we add the inspectable tier estimate + timestamps and harden
 * the enum columns with CHECK constraints.
 */
export const TASK_COORDINATION_COLUMNS_DDL = `
ALTER TABLE task ADD COLUMN IF NOT EXISTS tier_estimate jsonb;
ALTER TABLE task ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE task ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  ALTER TABLE task ADD CONSTRAINT task_status_chk CHECK (
    status IN ('ingested','routable','claimed','executing','in_review','done','failed','needs_attention')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE task ADD CONSTRAINT task_platform_chk CHECK (
    platform IN ('shortcut','github','linear')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;

/**
 * Workspace-level connection to a platform (Shortcut in Stage 1). Holds the
 * webhook secret REF (a pointer into the secret store — never the secret) used
 * to verify inbound signatures, plus a coarse health flag.
 */
export const PLATFORM_CONNECTION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS platform_connection (
  id                 text PRIMARY KEY,
  platform           text NOT NULL CHECK (platform IN ('shortcut','github','linear')),
  workspace_id       text NOT NULL,
  webhook_secret_ref text,
  health             text NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','degraded','revoked')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, workspace_id)
);`;

/**
 * Raw inbound webhook log keyed by the platform's event id — the idempotency
 * anchor (scaffold §7). The UNIQUE on (platform, external_event_id) makes a
 * re-delivered event a no-op insert, so the same event id processed twice yields
 * exactly one task.
 */
export const WEBHOOK_EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS webhook_event (
  id                text PRIMARY KEY,
  platform          text NOT NULL CHECK (platform IN ('shortcut','github','linear')),
  external_event_id text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_event_id)
);`;

/**
 * The persisted routing decision — the routing inspector's data (design brief
 * C5): the full TierEstimate, the ranked candidates, and the winning agent. One
 * row per (winning) routing attempt, linked back to its task.
 */
export const ROUTING_DECISION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS routing_decision (
  id            text PRIMARY KEY,
  task_id       text NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tier_estimate jsonb NOT NULL,
  candidates    jsonb NOT NULL DEFAULT '[]'::jsonb,
  winner_agent_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routing_decision_task_idx ON routing_decision (task_id, created_at);`;

/**
 * The pull request a run opened — links task ↔ PR and mirrors the PR URL/state
 * the execution layer reports back into the coordination store (§7).
 */
export const PULL_REQUEST_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS pull_request (
  id         text PRIMARY KEY,
  task_id    text NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  url        text NOT NULL,
  state      text NOT NULL DEFAULT 'open' CHECK (state IN ('open','merged','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pull_request_task_idx ON pull_request (task_id);`;

/**
 * All coordination DDL in dependency order. `task` must exist first (it is the
 * @tasca/db base table — apply TASK_TABLE_DDL before this), then the columns are
 * layered on, then the dependent tables (routing_decision / pull_request FK the
 * task). platform_connection and webhook_event are independent.
 *
 * Apply order to a clean Postgres:  TASK_TABLE_DDL (from @tasca/db) → these.
 */
export const COORDINATION_SCHEMA_DDL: readonly string[] = [
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
];
