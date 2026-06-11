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
-- Human-readable reason a task is in needs_attention (e.g. "no execution capacity").
-- Nullable; set on the no-runner-capacity path, surfaced in the inspector so the state
-- is actionable rather than a silent stall.
ALTER TABLE task ADD COLUMN IF NOT EXISTS last_error text;
-- A Tasca-side ROUTING PREFERENCE (slice W3-S1): the agent a human picked (today via an
-- accepted PM-assistant routing proposal). Nullable + no FK by design -- it is advisory: the
-- routing path resolves it WITHIN the org hired candidate set (fail-closed exactly like the
-- 5d agent-name label), so a stale/unhired id is simply not a candidate, never a dangling
-- reference. It is a PREFERENCE, never a binding assignment -- the engine + atomic claim still
-- decide. Cleared on a plain reassign (clean slate).
ALTER TABLE task ADD COLUMN IF NOT EXISTS preferred_agent_id text;
-- Decomposition children (slice W3-S1c): a Tasca-INTERNAL subtask created by accepting a
-- decomposition proposal carries its content here (it has no platform story to fetch from) and
-- points at its parent. content (jsonb {title,body}) is the routing/execution input for a
-- synthetic child; NULL for a normal task (which fetches content from its platform adapter).
-- parent_task_id (the originating task) is where the child's status posts back (the child has
-- no native story of its own), self-referencing the org-scoped task table -- no cross-org child.
ALTER TABLE task ADD COLUMN IF NOT EXISTS content jsonb;
ALTER TABLE task ADD COLUMN IF NOT EXISTS parent_task_id text REFERENCES task(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS task_parent_idx ON task (parent_task_id);
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
 * Multi-tenancy (Wave 2, slice 3a): the `organization` table + an `org_id` column on the
 * six task-side tenant tables (task, dispatch_job, routing_decision, pull_request,
 * platform_connection, webhook_event). Identity/agent/auth tables stay GLOBAL this slice.
 *
 * This DDL is applied LAST (after all six tables exist), fully idempotent + safe to re-run
 * on a populated DB, and PURELY ADDITIVE — it breaks no existing query (this is the expand
 * half of an expand/contract migration):
 *   1. add `org_id` NULLABLE so the ALTER never fails on existing rows;
 *   2. backfill every existing row to a single default org — top-level tables directly,
 *      children (dispatch_job/routing_decision/pull_request) from their task's org via the
 *      FK chain, with a default-org fallback for any orphan, so NO row is left null and no
 *      row crosses tenants (each maps to exactly one org);
 *   3. set a TRANSITIONAL column DEFAULT 'org_default' so the EXISTING inserts (which don't
 *      set org_id until slice 3b) keep working, then flip to NOT NULL + add the FK;
 *   4. add a plain index on org_id (the query filters land in 3b).
 *
 * DELIBERATELY NOT done here (deferred to 3b, where the queries change with them):
 *   - re-prefixing the tenant uniques with org_id — dropping the old (platform, …) uniques
 *     would break the existing ON CONFLICT queries that still reference them; the swap is
 *     coupled with the ON CONFLICT change in 3b.
 *   - removing the transitional DEFAULT — dropped in 3b once every writer sets org_id
 *     explicitly (the required-orgId signatures), so the data-layer fallback never outlives
 *     the type-layer enforcement.
 *
 * dispatch_job lives in @tasca/db and isn't present in every test context, so its ops are
 * guarded by to_regclass; the five coordination/task tables are always present here.
 */
export const ORG_SCOPING_DDL = `
CREATE TABLE IF NOT EXISTS organization (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The default org every existing row backfills onto (real org membership arrives with
-- RBAC/onboarding in slices 4/5; until then the platform is single-org on this org).
INSERT INTO organization (id, name) VALUES ('org_default', 'Default Organization')
  ON CONFLICT (id) DO NOTHING;

-- 1. org_id NULLABLE on the always-present tables.
ALTER TABLE task ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE routing_decision ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE pull_request ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE platform_connection ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE webhook_event ADD COLUMN IF NOT EXISTS org_id text;

-- 2. backfill (idempotent — only NULLs). Top-level → default; children → their task's org.
UPDATE task SET org_id = 'org_default' WHERE org_id IS NULL;
UPDATE platform_connection SET org_id = 'org_default' WHERE org_id IS NULL;
UPDATE webhook_event SET org_id = 'org_default' WHERE org_id IS NULL;
UPDATE routing_decision r SET org_id = t.org_id FROM task t WHERE r.task_id = t.id AND r.org_id IS NULL;
UPDATE pull_request p SET org_id = t.org_id FROM task t WHERE p.task_id = t.id AND p.org_id IS NULL;
-- Orphan fallback (a child whose task is gone — shouldn't happen under the FK CASCADE):
UPDATE routing_decision SET org_id = 'org_default' WHERE org_id IS NULL;
UPDATE pull_request SET org_id = 'org_default' WHERE org_id IS NULL;

-- 3. transitional DEFAULT (keeps existing inserts working) + NOT NULL + FK.
ALTER TABLE task ALTER COLUMN org_id SET DEFAULT 'org_default';
ALTER TABLE routing_decision ALTER COLUMN org_id SET DEFAULT 'org_default';
ALTER TABLE pull_request ALTER COLUMN org_id SET DEFAULT 'org_default';
ALTER TABLE platform_connection ALTER COLUMN org_id SET DEFAULT 'org_default';
ALTER TABLE webhook_event ALTER COLUMN org_id SET DEFAULT 'org_default';
ALTER TABLE task ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE routing_decision ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE pull_request ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE platform_connection ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE webhook_event ALTER COLUMN org_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE task ADD CONSTRAINT task_org_fk FOREIGN KEY (org_id) REFERENCES organization(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE routing_decision ADD CONSTRAINT routing_decision_org_fk FOREIGN KEY (org_id) REFERENCES organization(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE pull_request ADD CONSTRAINT pull_request_org_fk FOREIGN KEY (org_id) REFERENCES organization(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE platform_connection ADD CONSTRAINT platform_connection_org_fk FOREIGN KEY (org_id) REFERENCES organization(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_org_fk FOREIGN KEY (org_id) REFERENCES organization(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4. a plain (non-unique) index on org_id for the 3b query filters. The unique re-prefix is 3b.
CREATE INDEX IF NOT EXISTS task_org_idx ON task (org_id);
CREATE INDEX IF NOT EXISTS routing_decision_org_idx ON routing_decision (org_id);
CREATE INDEX IF NOT EXISTS pull_request_org_idx ON pull_request (org_id);
CREATE INDEX IF NOT EXISTS platform_connection_org_idx ON platform_connection (org_id);
CREATE INDEX IF NOT EXISTS webhook_event_org_idx ON webhook_event (org_id);

-- dispatch_job (lives in @tasca/db; guarded — not present in every test context).
DO $$ BEGIN
  IF to_regclass('dispatch_job') IS NOT NULL THEN
    ALTER TABLE dispatch_job ADD COLUMN IF NOT EXISTS org_id text;
    UPDATE dispatch_job d SET org_id = t.org_id FROM task t WHERE d.task_id = t.id AND d.org_id IS NULL;
    UPDATE dispatch_job SET org_id = 'org_default' WHERE org_id IS NULL;
    ALTER TABLE dispatch_job ALTER COLUMN org_id SET DEFAULT 'org_default';
    ALTER TABLE dispatch_job ALTER COLUMN org_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS dispatch_job_org_idx ON dispatch_job (org_id);
    BEGIN
      ALTER TABLE dispatch_job ADD CONSTRAINT dispatch_job_org_fk FOREIGN KEY (org_id) REFERENCES organization(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;`;

/**
 * The CONTRACT half of the org-scoping migration (slice 3b-2), applied after ORG_SCOPING_DDL
 * (the expand half, 3a). It is COUPLED with the store's query change in the SAME slice — the
 * store's ON CONFLICT clauses now reference the org-prefixed uniques created here, and every
 * store writer now sets org_id explicitly, so the transitional default is dropped:
 *   1. re-prefix the tenant uniques with org_id (drop the un-prefixed, create org-scoped).
 *      SAFE on backfilled data: every row is on the SAME default org, and the OLD uniques
 *      guaranteed the sub-key (e.g. (platform, external_story_id)) unique, so
 *      (org_id, platform, external_story_id) is still unique — no collision possible.
 *   2. drop the transitional column DEFAULT 'org_default' on the FIVE store-written tenant
 *      tables — now that the store sets org_id explicitly (required-orgId signatures), the
 *      data-layer fallback must not outlive the type-layer enforcement (a forgotten org would
 *      otherwise silently default).
 *
 * dispatch_job is DELIBERATELY EXCLUDED from the default drop: it is written by the QUEUE
 * (PgDispatchQueue.enqueue), NOT the store, and the queue does not set org_id until slice 3c.
 * Dropping its default here would break every enqueue between 3b-2 and 3c. Its default is
 * dropped in 3c, in lockstep with enqueue starting to set org_id — the same expand/contract
 * discipline, applied per writer: a table's default goes only when ITS writer is updated.
 * Idempotent: DROP ... IF EXISTS, CREATE ... IF NOT EXISTS, DROP DEFAULT is a no-op when absent.
 */
export const ORG_CONTRACT_DDL = `
-- 1. org-prefix the tenant uniques (drop the un-prefixed; the store's ON CONFLICT now targets
--    the new ones, in lockstep — see PgCoordinationStore getOrCreateTask / recordWebhookEvent /
--    upsertGitHubInstallation).
DROP INDEX IF EXISTS task_platform_story_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS task_org_platform_story_uniq ON task (org_id, platform, external_story_id);
ALTER TABLE platform_connection DROP CONSTRAINT IF EXISTS platform_connection_platform_workspace_id_key;
DROP INDEX IF EXISTS platform_connection_platform_workspace_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS platform_connection_org_platform_workspace_uniq ON platform_connection (org_id, platform, workspace_id);
ALTER TABLE webhook_event DROP CONSTRAINT IF EXISTS webhook_event_platform_external_event_id_key;
DROP INDEX IF EXISTS webhook_event_platform_external_event_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_event_org_platform_event_uniq ON webhook_event (org_id, platform, external_event_id);

-- 2. drop the transitional default on the FIVE store-written tables (the store now sets
--    org_id explicitly). dispatch_job is EXCLUDED — its writer (the queue) doesn't set org_id
--    until 3c, so its default drop lives there, in lockstep with that change.
ALTER TABLE task ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE routing_decision ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE pull_request ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE platform_connection ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE webhook_event ALTER COLUMN org_id DROP DEFAULT;`;

/**
 * The CONTRACT step for dispatch_job (slice 3c), the per-writer counterpart of ORG_CONTRACT_DDL.
 * dispatch_job is written by the QUEUE (`PgDispatchQueue.enqueue`), not the store, so its
 * transitional `DEFAULT 'org_default'` was deliberately KEPT through 3b-2 (dropping it then would
 * have broken every enqueue, which didn't yet set org_id). Now that enqueue sets org_id explicitly
 * (3c), the data-layer fallback must not outlive the type-layer enforcement — drop it, in lockstep.
 *
 * The cross-org worker paths (runner `claimNext`, reaper `claimFinished`, `sweepExpired`) are
 * UNCHANGED and deliberately do NOT filter on org_id — a runner serves every tenant; org_id rides
 * the job as DATA. That is the one explicit cross-org path (watch item 3).
 *
 * Guarded by to_regclass — dispatch_job lives in @tasca/db and isn't present in every test context.
 * Idempotent: DROP DEFAULT is a no-op when the default is already absent.
 */
export const ORG_DISPATCH_CONTRACT_DDL = `
DO $$ BEGIN
  IF to_regclass('dispatch_job') IS NOT NULL THEN
    ALTER TABLE dispatch_job ALTER COLUMN org_id DROP DEFAULT;
  END IF;
END $$;`;

/**
 * All coordination DDL in dependency order. `task` must exist first (it is the
 * @tasca/db base table — apply TASK_TABLE_DDL before this), then the columns are
 * layered on, then the dependent tables (routing_decision / pull_request FK the
 * task). platform_connection and webhook_event are independent. The org migration is LAST —
 * it ALTERs all of the above once they exist: ORG_SCOPING_DDL (3a expand) → ORG_CONTRACT_DDL
 * (3b-2 store contract) → ORG_DISPATCH_CONTRACT_DDL (3c queue contract: drops dispatch_job's
 * transitional default now that enqueue sets org_id).
 *
 * Apply order to a clean Postgres:  TASK_TABLE_DDL + DISPATCH_JOB_DDL (from @tasca/db) → these.
 */
/**
 * PM-assistant proposals (slice W3-S1) — the advisory layer's only storage. Org-scoped from
 * birth (post-3b; born NOT NULL + FK, no transitional default / expand-contract). A proposal
 * is a SUGGESTION: accepting it routes through an existing org-scoped CAS-guarded binding
 * method (reassign+preference / overrideTier / getOrCreateTask) — there is no proposal-side
 * write to task status / claim / routing_decision. `target_version` fences a stale accept
 * (the task moved since the proposal was generated). ON DELETE CASCADE on both FKs: dropping
 * an org or a task drops its proposals (no orphans). NOTE: this is the only file with raw
 * `proposal` SQL outside the scoped layer — `proposal` is in the org-scoping CI guard's
 * TENANT_TABLES, and every store method that touches it is required-orgId.
 */
export const PROPOSAL_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS proposal (
  id             text PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('triage','decomposition','routing','standup')),
  target_task_id text REFERENCES task(id) ON DELETE CASCADE,
  target_version integer,
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  version        integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposal_org_status_kind_idx ON proposal (org_id, status, kind);
CREATE INDEX IF NOT EXISTS proposal_org_task_idx ON proposal (org_id, target_task_id);`;

/**
 * Per-task / per-org LLM usage ledger (slice W3-S4a) — the metering surface. One row per LLM call
 * (the coordination classifier/triage/decomposition now; the agent-execution path in S4b). Org-scoped
 * tenant data (org_id NOT NULL FK; in the org-scoping CI guard's TENANT_TABLES; every store method
 * required-orgId). idempotency_key (the Anthropic response id) is UNIQUE so a retried report is a
 * no-op INSERT (CAS-grade — no double-count). task_id is a PLAIN nullable column (no FK): usage is
 * BILLING HISTORY and must survive its task being deleted. ON DELETE CASCADE on org_id only.
 */
export const USAGE_EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS usage_event (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  task_id         text,
  source          text NOT NULL CHECK (source IN ('classifier','triage','decomposition','agent')),
  model           text NOT NULL,
  input_tokens    integer NOT NULL,
  output_tokens   integer NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_event_org_created_idx ON usage_event (org_id, created_at);
CREATE INDEX IF NOT EXISTS usage_event_org_task_idx ON usage_event (org_id, task_id);`;

export const COORDINATION_SCHEMA_DDL: readonly string[] = [
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
  ORG_SCOPING_DDL,
  ORG_CONTRACT_DDL,
  ORG_DISPATCH_CONTRACT_DDL,
  PROPOSAL_TABLE_DDL, // slice W3-S1: PM-assistant proposals (after organization + task exist)
  USAGE_EVENT_TABLE_DDL, // slice W3-S4a: per-task/per-org LLM usage ledger
];
