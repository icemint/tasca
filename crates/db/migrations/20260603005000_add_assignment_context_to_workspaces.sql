-- M1 #143: denormalize the assignment context from a workspace's linked remote
-- Issue onto the workspace at create-and-start, so the engine seam
-- (context_for_workspace, before Session::create) can resolve tier/sprint
-- locally without a remote round-trip. All nullable: a NULL complexity_tier
-- means an ad-hoc workspace not created from a tiered issue, for which the
-- engine does not fire (byte-for-byte upstream behavior).
ALTER TABLE workspaces ADD COLUMN complexity_tier TEXT;
ALTER TABLE workspaces ADD COLUMN sprint_id BLOB;
ALTER TABLE workspaces ADD COLUMN remote_project_id BLOB;
ALTER TABLE workspaces ADD COLUMN remote_issue_id BLOB;
