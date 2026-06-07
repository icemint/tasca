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
