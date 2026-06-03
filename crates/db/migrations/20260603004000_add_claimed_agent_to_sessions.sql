-- M1 #16: when the assignment engine routes a workspace to an Agent, the seam
-- atomically claims a concurrency slot (Agent::claim) and records the claimed
-- agent here. The slot is released exactly once when the initial coding-agent
-- run finalizes (Session::take_claimed_agent clears it). NULL ⇒ no engine
-- assignment (manual-override / upstream path), so existing rows are unaffected.
ALTER TABLE sessions ADD COLUMN claimed_agent_id BLOB REFERENCES agents (id) ON DELETE SET NULL;
