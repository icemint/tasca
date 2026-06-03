# M1 #13 Spike — Task/tier linkage at the `start_workspace` seam

> Doc-only (ticket #13). Resolves M1-PLAN risk #1 before the engine-wiring tickets (#15/#16). **Status: findings verified; the seam-resolution decision is pending product confirmation.**

## Verified findings

1. **Seam:** `ContainerService::start_workspace` at `crates/services/src/services/container.rs:1003`; `Session::create` at `:1019`. Confirmed (M1-PLAN §1.6). The drafted `:1063` is the wrong (too-late) seam.

2. **`workspace.task_id` is LIVE, not orphaned.** Migration `20260217120312` dropped the FK *constraint*, but the column remains, is written by the workspaces INSERT (`workspace.rs:318`), and is selected throughout (`workspace.rs:96,198,263,507,601`). So the local-Task path `workspace.task_id → Task.complexity_tier` (the field #9 just added) **is reachable at the seam** for VK's local/desktop flow.

3. **The host already fetches the full remote Issue at start.** When a workspace is started from a remote issue, the host calls `GET /api/remote/issues/{issue_id}` into `api_types::Issue` (`crates/mcp/src/task_server/tools/task_attempts.rs:152`) to build the prompt. **Once #10 adds `complexity_tier`/`sprint_id` to `api_types::Issue`, the tier arrives in this existing fetch — no new round-trip.**

4. **The gap:** `LinkedIssueInfo` (`crates/db/src/models/requests.rs:26`) carries only `remote_project_id` + `issue_id`. It does **not** forward the fetched issue's tier/sprint to the seam, so the engine can't see them through the workspace-start payload today.

5. **Branch-per-attempt:** post-`20251216142123`, a workspace has 1:many sessions; `branch` lives on `workspace` (`workspace.rs:50`), shared across that workspace's sessions. "Unassigned" should be evaluated against the issue/task assignee state at dispatch; "in-flight" = an active (non-terminal) session on the workspace. No schema change required for M1 if the engine claims at session-create time.

## Conclusion (corrects the over-stated "architectural stop")

The M1-PLAN's literal "read tier from a local Task at the seam" is **too narrow**, but the fix is a **buildable refinement, not a redesign**: the host has the tier either on the local `Task` (`workspace.task_id`) or in the **already-fetched** remote `Issue`. The engine does **not** need a new cross-boundary call. The decision is *how to thread the tier/sprint to the seam* (see question).

## Decision (CONFIRMED)

**Extend `LinkedIssueInfo` to carry `complexity_tier` + `sprint_id`**, populated from the issue the host already fetches (`task_attempts.rs:152`); at the seam, resolve tier as: `workspace.task_id → Task.complexity_tier` if present (local/desktop flow), else the linked-issue metadata (cloud flow). **No new round-trip, no signature change to `start_workspace`** (the tier reaches it via the workspace + its linked-issue metadata). Smallest change; engine stays a local reader.

### Impact on the M1 tickets
- **#10** (remote issues tier): also surfaces `complexity_tier`/`sprint_id` on `api_types::Issue` — already the host's fetch shape, so the data is available to populate `LinkedIssueInfo`.
- **#16** (wire engine): at the seam, resolve tier via `workspace.task_id → Task` else `linked_issue` metadata; extend `LinkedIssueInfo` + the `task_attempts.rs:152` population site + `CreateAndStartWorkspaceRequest`. No `start_workspace` signature change.
- **#11 (Agent), #12 (sprints)** are unaffected by this decision.
