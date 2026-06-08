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
);`;

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
  status           text NOT NULL DEFAULT 'queued' CONSTRAINT dispatch_job_status_chk CHECK (status IN ('queued','claimed','done','failed')),
  claimed_by       text,
  attempts         integer NOT NULL DEFAULT 0,
  available_at     timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispatch_job_claimable ON dispatch_job (available_at, created_at) WHERE status = 'queued';`;
