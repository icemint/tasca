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
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A task is identified by its source story: (platform, external_story_id) is
-- unique so ingest is get-or-create. Re-delivery / re-assignment of the same
-- story re-drives the SAME task row, which is what makes the failure_count the
-- breaker reads accumulate across attempts (auto-recover-on-re-assign, §6.14).
-- A unique INDEX (not a named ADD CONSTRAINT) keeps this DDL re-appliable —
-- IF NOT EXISTS is natively idempotent — and ON CONFLICT infers it all the same.
CREATE UNIQUE INDEX IF NOT EXISTS task_platform_story_uniq ON task (platform, external_story_id);`;

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
  installation_id    text,
  health             text NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','degraded','revoked')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, workspace_id)
);
-- The GitHub App installation id the write-back acts under (one per workspace).
-- Added on the upgrade path too so a table created before write-back gains it.
ALTER TABLE platform_connection ADD COLUMN IF NOT EXISTS installation_id text;`;

/**
 * Raw inbound webhook log keyed by the platform's event id — the idempotency
 * anchor (scaffold §7). It is a *processing ledger*, not a bare seen-set: a row
 * starts `received` and is flipped to `processed` only once orchestration has
 * durably run. The UNIQUE on (platform, external_event_id) makes a re-delivered
 * event a no-op insert, but only a `processed` row short-circuits delivery — a
 * row still `received` (orchestration crashed or never completed between the
 * record and the run) is re-driven on redelivery, so a post-record crash cannot
 * silently consume an event and yield zero tasks.
 */
export const WEBHOOK_EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS webhook_event (
  id                text PRIMARY KEY,
  platform          text NOT NULL CHECK (platform IN ('shortcut','github','linear')),
  external_event_id text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed')),
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (platform, external_event_id)
);
ALTER TABLE webhook_event ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'received';
ALTER TABLE webhook_event ADD COLUMN IF NOT EXISTS processed_at timestamptz;
-- The status CHECK lives in the CREATE for a fresh DB; add it on the upgrade path
-- too so a table created before the ledger column still enforces the enum.
DO $$ BEGIN
  ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_status_chk CHECK (status IN ('received','processed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;

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
CREATE INDEX IF NOT EXISTS pull_request_task_idx ON pull_request (task_id);
-- Makes recordPullRequest idempotent at the storage layer (ON CONFLICT DO NOTHING):
-- the reaper's at-least-once finalize, or two reapers in a lease-overrun window, can
-- re-record the SAME (task, url) without inserting a duplicate PR row.
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_task_url_uidx ON pull_request (task_id, url);`;

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
