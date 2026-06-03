-- M1 #17 v1: operational/dispatch state for the assignment engine, denormalized
-- onto the workspace (the live local execution entity). Follows the #143
-- off-struct pattern: these columns are read via dedicated accessors, not the
-- main Workspace struct/projection.
--
--  dispatch_state   NULL = engine never fired (ad-hoc / upstream); else the
--                   lifecycle of an engine-routed workspace.
--  dispatch_prompt  the coding-agent prompt captured when a run is deferred
--                   (queued), so it can be started on a later agent release.
--  dispatch_executor_config
--                   the caller's executor config (JSON) captured at defer time so
--                   the exact original request replays on re-dispatch (the engine
--                   overrides it when it assigns an agent).
--  needs_attention  operator-facing flag: a run failed/was interrupted and
--                   needs a human (no auto tier-bump in v1).
--  attention_reason why it needs attention.
--  interrupted      machine-facing resumable marker (agent went away mid-run);
--                   the worktree is preserved so the run is resumable.
ALTER TABLE workspaces ADD COLUMN dispatch_state TEXT;
ALTER TABLE workspaces ADD COLUMN dispatch_prompt TEXT;
ALTER TABLE workspaces ADD COLUMN dispatch_executor_config TEXT;
ALTER TABLE workspaces ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN attention_reason TEXT;
ALTER TABLE workspaces ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;
