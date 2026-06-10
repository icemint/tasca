// Minimal `task` schema for the Stage-1 routing CAS proof. The full coordination
// schema (org/user/agent/identity/routing_decision/…) lands with @tasca/db proper;
// this is the slice the atomic-claim guarantee operates on.
//
// `status` carries a CHECK built from the domain's TASK_STATUSES (the single
// source of truth for the state machine) so storage rejects an illegal status —
// an out-of-band writer can't park a row in a state the CAS can't reason about.
// Named `task_status_chk` to match @tasca/coordination's ALTER, whose idempotent
// add then skips on a DB where this CREATE already applied the constraint.

import { TASK_STATUSES } from '@tasca/domain';

const STATUS_IN = TASK_STATUSES.map((s) => `'${s}'`).join(', ');

export const TASK_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS task (
  id               text PRIMARY KEY,
  external_story_id text NOT NULL,
  platform         text NOT NULL DEFAULT 'shortcut',
  status           text NOT NULL DEFAULT 'ingested' CONSTRAINT task_status_chk CHECK (status IN (${STATUS_IN})),
  version          integer NOT NULL DEFAULT 0,
  claimed_by       text,
  failure_count    integer NOT NULL DEFAULT 0,
  repo_ref         text
);
-- org_id: the db-layer claim CAS (PgClaimRepository.tryClaim) is org-scoped (slice 3c), so the
-- column must exist wherever the base task table does. Declared nullable here; the coordination
-- migration (ORG_SCOPING_DDL → ORG_CONTRACT_DDL) layers the tenancy semantics — backfill, NOT
-- NULL, FK to organization, org-prefixed uniques, and the transitional-default lifecycle.
ALTER TABLE task ADD COLUMN IF NOT EXISTS org_id text;`;

// The dispatch queue: the coordination↔execution seam. Coordination ENQUEUES a job
// per dispatch; an agent-runner CLAIMS one atomically via FOR UPDATE SKIP LOCKED, so
// under concurrent runners a job is delivered to EXACTLY ONE runner (no two ever pull
// the same row). `lease_expires_at` gives crash recovery: a claimed job whose lease
// lapses is reclaimable (the runner died mid-run). `available_at` supports delayed
// (re)enqueue for backoff. Statuses constrained so an out-of-band writer can't park a
// job in a state the claim loop can't reason about.
export const DISPATCH_JOB_DDL = `
CREATE TABLE IF NOT EXISTS dispatch_job (
  id               uuid PRIMARY KEY,
  task_id          text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CONSTRAINT dispatch_job_status_chk CHECK (status IN ('queued','claimed','publishing','done','failed','cancelled')),
  claimed_by       text,
  attempts         integer NOT NULL DEFAULT 0,
  claim_epoch      bigint NOT NULL DEFAULT 0,
  available_at     timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error       text,
  result           jsonb,
  reaping_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dispatch_job ADD COLUMN IF NOT EXISTS claim_epoch bigint NOT NULL DEFAULT 0;
-- org_id rides the job as DATA (slice 3c): the queue writer (enqueue) sets it from the task's
-- org. Declared here (nullable) so the column exists wherever dispatch_job does — the @tasca/db
-- layer now writes it. The tenancy semantics (backfill, NOT NULL, FK to organization, and the
-- transitional-default lifecycle) are layered on by the coordination migration
-- (ORG_SCOPING_DDL → ORG_DISPATCH_CONTRACT_DDL). The cross-org workers (claimNext/claimFinished/
-- sweepExpired) deliberately do NOT filter on it — a runner serves every tenant.
ALTER TABLE dispatch_job ADD COLUMN IF NOT EXISTS org_id text;
-- The runner writes its result (e.g. the PR url) back to the QUEUE only; the reaper
-- reads it to finalize. reaping_at leases a finished row to one reaper WITHOUT changing
-- its terminal status, so a reaper crash just lets the lease lapse and the row is
-- re-selected — the status stays the source of truth, never lost to a 'reaping' limbo.
ALTER TABLE dispatch_job ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE dispatch_job ADD COLUMN IF NOT EXISTS reaping_at timestamptz;
ALTER TABLE dispatch_job ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
-- Widen the status CHECK on an EXISTING table for the cancel-in-flight states
-- ('publishing' = the runner's point-of-no-return; 'cancelled' = operator interrupt).
-- DROP-then-ADD makes the migration idempotent across boots.
ALTER TABLE dispatch_job DROP CONSTRAINT IF EXISTS dispatch_job_status_chk;
ALTER TABLE dispatch_job ADD CONSTRAINT dispatch_job_status_chk
  CHECK (status IN ('queued','claimed','publishing','done','failed','cancelled'));
CREATE INDEX IF NOT EXISTS dispatch_job_claimable ON dispatch_job (available_at, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS dispatch_job_finished ON dispatch_job (updated_at) WHERE status IN ('done','failed');`;
