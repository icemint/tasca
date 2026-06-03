-- M1 routing core (PRD §4.1): mirror the local task complexity tier onto remote
-- issues so the board UI and the assignment hand-off (LinkedIssueInfo, #16) carry
-- the tier. Additive; DEFAULTs keep existing rows valid.
CREATE TYPE complexity_tier AS ENUM ('basic', 'low', 'medium', 'hard', 'ultra');
CREATE TYPE tier_source AS ENUM ('manual', 'assistant', 'classifier');

ALTER TABLE issues ADD COLUMN complexity_tier complexity_tier NOT NULL DEFAULT 'medium';
ALTER TABLE issues ADD COLUMN tier_source tier_source NOT NULL DEFAULT 'manual';
ALTER TABLE issues ADD COLUMN tier_confidence DOUBLE PRECISION;

-- NOTE: `issues` is already in electric_publication_default (20260114000000), and
-- the table has REPLICA IDENTITY FULL, so the new columns stream automatically.
-- Do NOT re-run electric_sync_table('public','issues') — that ALTER PUBLICATION …
-- ADD TABLE would error on the already-published table.
