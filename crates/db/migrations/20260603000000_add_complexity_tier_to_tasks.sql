-- M1 routing core (PRD §4.1): per-task complexity tier for capability-aware
-- assignment. Additive; DEFAULT keeps every existing task row valid.
ALTER TABLE tasks ADD COLUMN complexity_tier TEXT NOT NULL DEFAULT 'medium'
    CHECK (complexity_tier IN ('basic', 'low', 'medium', 'hard', 'ultra'));

-- How the tier was set: manual override, PM-assistant suggestion, or (v2)
-- auto-classifier. v1 is manual + assistant per §13.4.
ALTER TABLE tasks ADD COLUMN tier_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (tier_source IN ('manual', 'assistant', 'classifier'));

-- Optional classifier/assistant confidence (0..1); NULL for manual.
ALTER TABLE tasks ADD COLUMN tier_confidence REAL;
