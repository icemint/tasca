// Minimal `task` schema for the Stage-1 routing CAS proof. The full coordination
// schema (org/user/agent/identity/routing_decision/…) lands with @tasca/db proper;
// this is the slice the atomic-claim guarantee operates on.
export const TASK_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS task (
  id               text PRIMARY KEY,
  external_story_id text NOT NULL,
  platform         text NOT NULL DEFAULT 'shortcut',
  status           text NOT NULL DEFAULT 'ingested',
  version          integer NOT NULL DEFAULT 0,
  claimed_by       text,
  failure_count    integer NOT NULL DEFAULT 0,
  repo_ref         text
);`;
