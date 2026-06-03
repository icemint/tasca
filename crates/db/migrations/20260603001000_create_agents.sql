-- M1 routing core (PRD §4.2): the local agent pool the assignment engine
-- selects from. `concurrency_limit` is UI-settable (default 1 for single-GPU
-- local agents, §13.3); `claim`/`release` mutate `active_sessions` atomically.
CREATE TABLE agents (
    id                  BLOB PRIMARY KEY,
    org_id              BLOB,                       -- remote org; NULL for a purely local agent
    name                TEXT NOT NULL,
    executor_profile    TEXT NOT NULL,              -- maps to ExecutorConfig (executor+variant+model)
    base_url            TEXT,                       -- e.g. an Ollama endpoint
    credential_ref      BLOB,                       -- FK to the (Phase-2) secret store; NULL for local
    max_complexity_tier TEXT NOT NULL
        CHECK (max_complexity_tier IN ('basic', 'low', 'medium', 'hard', 'ultra')),
    min_complexity_tier TEXT NOT NULL DEFAULT 'basic'
        CHECK (min_complexity_tier IN ('basic', 'low', 'medium', 'hard', 'ultra')),
    availability        TEXT NOT NULL DEFAULT 'free'
        CHECK (availability IN ('free', 'busy', 'offline', 'paused')),
    concurrency_limit   INTEGER NOT NULL DEFAULT 1,
    active_sessions     INTEGER NOT NULL DEFAULT 0,
    sandbox_profile     TEXT,                       -- §10 sandbox; unused until Phase 5
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

-- The engine queries free agents with spare capacity; tier-band filtering is
-- ordinal and done in Rust after this prefilter.
CREATE INDEX idx_agents_availability ON agents (availability, active_sessions);
