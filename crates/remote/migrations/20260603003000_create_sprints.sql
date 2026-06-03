-- M1 routing core (PRD §4.3, §13.2): remote sprints mirror so the board UI
-- (Sprint selector, #107) and the assignment hand-off carry sprint scoping.
CREATE TYPE sprint_state AS ENUM ('planned', 'active', 'closed');

CREATE TABLE sprints (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    starts_at   TIMESTAMPTZ,
    ends_at     TIMESTAMPTZ,
    state       sprint_state NOT NULL DEFAULT 'planned',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sprints_project_state ON sprints (project_id, state);

-- Additive; NULL = no sprint (no-filter), backward compatible.
ALTER TABLE issues ADD COLUMN sprint_id UUID REFERENCES sprints (id) ON DELETE SET NULL;

-- Publish the NEW sprints table so the UI can stream it via Electric. (issues is
-- already published; its new sprint_id column auto-streams — see the tier migration.)
SELECT electric_sync_table('public', 'sprints');
