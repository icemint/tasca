-- M1 routing core (PRD §4.3, §13.2): sprints as a first-class entity so the
-- assignment engine can restrict pickup to the active sprint. Additive;
-- `sprint_id NULL` means "no sprint" (no-filter) for backward compatibility.
CREATE TABLE sprints (
    id          BLOB PRIMARY KEY,
    project_id  BLOB NOT NULL,
    name        TEXT NOT NULL,
    starts_at   TEXT,
    ends_at     TEXT,
    state       TEXT NOT NULL DEFAULT 'planned'
        CHECK (state IN ('planned', 'active', 'closed')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- The engine looks up the single active sprint per project.
CREATE INDEX idx_sprints_project_state ON sprints (project_id, state);

ALTER TABLE tasks ADD COLUMN sprint_id BLOB;
