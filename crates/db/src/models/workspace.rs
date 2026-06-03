use chrono::{DateTime, Utc};
use executors::actions::{ExecutorAction, ExecutorActionType};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

/// Maximum length for auto-generated workspace names (derived from first user prompt)
const WORKSPACE_NAME_MAX_LEN: usize = 60;

use super::{
    execution_process::ExecutorActionField,
    session::Session,
    task::ComplexityTier,
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Workspace not found")]
    WorkspaceNotFound,
    #[error("Validation error: {0}")]
    ValidationError(String),
    #[error("Branch not found: {0}")]
    BranchNotFound(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerInfo {
    pub workspace_id: Uuid,
}

#[derive(Debug)]
struct WorkspaceContainerRefRow {
    id: Uuid,
    container_ref: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Workspace {
    pub id: Uuid,
    pub task_id: Option<Uuid>,
    pub container_ref: Option<String>,
    pub branch: String,
    pub setup_completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived: bool,
    pub pinned: bool,
    pub name: Option<String>,
    pub worktree_deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceWithStatus {
    #[serde(flatten)]
    #[ts(flatten)]
    pub workspace: Workspace,
    pub is_running: bool,
    pub is_errored: bool,
}

impl std::ops::Deref for WorkspaceWithStatus {
    type Target = Workspace;
    fn deref(&self) -> &Self::Target {
        &self.workspace
    }
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateFollowUpAttempt {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContext {
    pub workspace: Workspace,
    pub workspace_repos: Vec<RepoWithTargetBranch>,
    pub orchestrator_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkspace {
    pub branch: String,
    pub name: Option<String>,
}

/// The dispatch lifecycle of an engine-routed workspace (M1 #17). `NULL` in the DB
/// (no `DispatchState`) means the engine never fired for this workspace (ad-hoc /
/// manual / upstream) — it is never queued and never re-dispatched.
#[derive(Debug, Clone, Copy, sqlx::Type, Serialize, Deserialize, PartialEq, Eq, TS)]
#[sqlx(type_name = "dispatch_state", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum DispatchState {
    /// Capable agents were all busy at start; the run is deferred and waits for an
    /// agent-release event to be picked up (FIFO).
    Queued,
    /// An agent was claimed and the coding-agent run started.
    Running,
    /// A previously-queued run was claimed by a release event and started. Distinct
    /// from `Running` only to make the race-safe `queued → dispatched` transition
    /// observable; behaves like `Running` thereafter.
    Dispatched,
}

/// Operator-facing reason a workspace needs attention (M1 #17). A free-text tag
/// (the column is TEXT) so new reasons can be added without enum/migration churn
/// as richer exit signals get plumbed. v1 emits `"executor_error"`; `"max_turns"`
/// and a distinct `"interrupted"` are future refinements once the executor exposes
/// a structured exit reason.
pub const ATTENTION_EXECUTOR_ERROR: &str = "executor_error";

/// The head-of-queue projection used to pick the next deferred workspace to
/// re-dispatch on an agent release (M1 #17).
#[derive(Debug, Clone)]
pub struct QueuedWorkspace {
    pub id: Uuid,
    pub complexity_tier: Option<ComplexityTier>,
    pub dispatch_prompt: Option<String>,
    pub dispatch_executor_config: Option<String>,
}

/// The assignment inputs denormalized onto a workspace from its linked remote
/// Issue at create-and-start (M1 #143). Kept off the main [`Workspace`] struct (so
/// the many `Workspace` query sites and the shared TS type are untouched) and read
/// via [`Workspace::assignment_context`] only at the engine seam. A `None`
/// `complexity_tier` means the workspace was not created from a tiered issue, so
/// the engine does not fire (byte-for-byte upstream behavior).
#[derive(Debug, Clone)]
pub struct WorkspaceAssignmentContext {
    pub complexity_tier: Option<ComplexityTier>,
    pub sprint_id: Option<Uuid>,
    pub remote_project_id: Option<Uuid>,
    pub remote_issue_id: Option<Uuid>,
}

impl Workspace {
    /// Read the denormalized assignment context for a workspace (M1 #143). Used at
    /// the `start_workspace` seam to resolve tier/sprint without a remote round-trip.
    pub async fn assignment_context(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<WorkspaceAssignmentContext>, sqlx::Error> {
        sqlx::query_as!(
            WorkspaceAssignmentContext,
            r#"SELECT complexity_tier AS "complexity_tier: ComplexityTier",
                      sprint_id AS "sprint_id: Uuid",
                      remote_project_id AS "remote_project_id: Uuid",
                      remote_issue_id AS "remote_issue_id: Uuid"
               FROM workspaces
               WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// Persist the assignment context denormalized from the linked Issue (M1 #143).
    /// Called at create-and-start when a workspace is linked to a tiered issue.
    pub async fn set_assignment_context(
        pool: &SqlitePool,
        id: Uuid,
        complexity_tier: ComplexityTier,
        sprint_id: Option<Uuid>,
        remote_project_id: Uuid,
        remote_issue_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE workspaces
               SET complexity_tier = $2,
                   sprint_id = $3,
                   remote_project_id = $4,
                   remote_issue_id = $5,
                   updated_at = datetime('now', 'subsec')
               WHERE id = $1"#,
            id,
            complexity_tier,
            sprint_id,
            remote_project_id,
            remote_issue_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Defer a workspace's run because all capable agents were busy (M1 #17):
    /// record `dispatch_state = queued` and capture the coding-agent prompt so the
    /// run can be started later on an agent-release event.
    pub async fn mark_queued(
        pool: &SqlitePool,
        id: Uuid,
        prompt: &str,
        executor_config_json: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE workspaces
               SET dispatch_state = 'queued', dispatch_prompt = $2,
                   dispatch_executor_config = $3, updated_at = datetime('now', 'subsec')
               WHERE id = $1"#,
            id,
            prompt,
            executor_config_json
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Record that an agent was claimed and the run started (M1 #17).
    pub async fn mark_running(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE workspaces
               SET dispatch_state = 'running', updated_at = datetime('now', 'subsec')
               WHERE id = $1"#,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Atomically claim a queued workspace for re-dispatch (M1 #17). The
    /// `WHERE dispatch_state = 'queued'` guard makes this exactly-once: among
    /// concurrent agent-release re-dispatchers, only the one whose UPDATE flips
    /// `queued → dispatched` gets `true` and proceeds to start it; the rest get
    /// `false` and move on — no double-start.
    pub async fn try_claim_for_dispatch(pool: &SqlitePool, id: Uuid) -> Result<bool, sqlx::Error> {
        let res = sqlx::query!(
            r#"UPDATE workspaces
               SET dispatch_state = 'dispatched', updated_at = datetime('now', 'subsec')
               WHERE id = $1 AND dispatch_state = 'queued'"#,
            id
        )
        .execute(pool)
        .await?;
        Ok(res.rows_affected() == 1)
    }

    /// Read a workspace's dispatch state (M1 #17). `None` ⇒ the engine never fired.
    pub async fn dispatch_state(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<DispatchState>, sqlx::Error> {
        sqlx::query_scalar!(
            r#"SELECT dispatch_state AS "dispatch_state: DispatchState"
               FROM workspaces WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
        .map(Option::flatten)
    }

    /// The queued workspaces awaiting an agent, oldest first (FIFO by creation).
    /// The caller filters by the freed agent's tier band in Rust (TEXT tiers don't
    /// sort ordinally in SQL), mirroring `Agent::find_available_for_tier` (M1 #17).
    pub async fn find_queued_ready(pool: &SqlitePool) -> Result<Vec<QueuedWorkspace>, sqlx::Error> {
        sqlx::query_as!(
            QueuedWorkspace,
            r#"SELECT id AS "id!: Uuid",
                      complexity_tier AS "complexity_tier: ComplexityTier",
                      dispatch_prompt,
                      dispatch_executor_config
               FROM workspaces
               WHERE dispatch_state = 'queued'
               ORDER BY created_at ASC"#
        )
        .fetch_all(pool)
        .await
    }

    /// Flag a workspace as needing human attention after a failed/interrupted run
    /// (M1 #17). `interrupted` additionally sets the resumable marker (the worktree
    /// is preserved, so the run can be resumed rather than silently retried).
    pub async fn record_needs_attention(
        pool: &SqlitePool,
        id: Uuid,
        reason: &str,
        interrupted: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE workspaces
               SET needs_attention = 1, attention_reason = $2, interrupted = $3,
                   updated_at = datetime('now', 'subsec')
               WHERE id = $1"#,
            id,
            reason,
            interrupted
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Fetch all workspaces. Newest first.
    pub async fn fetch_all(pool: &SqlitePool) -> Result<Vec<Self>, WorkspaceError> {
        let workspaces = sqlx::query_as!(
            Workspace,
            r#"SELECT id AS "id!: Uuid",
                          task_id AS "task_id: Uuid",
                          container_ref,
                          branch,
                          setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                          created_at AS "created_at!: DateTime<Utc>",
                          updated_at AS "updated_at!: DateTime<Utc>",
                          archived AS "archived!: bool",
                          pinned AS "pinned!: bool",
                          name,
                          worktree_deleted AS "worktree_deleted!: bool"
                   FROM workspaces
                   ORDER BY created_at DESC"#
        )
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)?;

        Ok(workspaces)
    }

    /// Load full workspace context by workspace ID.
    pub async fn load_context(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<WorkspaceContext, WorkspaceError> {
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or(WorkspaceError::WorkspaceNotFound)?;

        let workspace_repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace_id).await?;
        let orchestrator_session_id = Session::find_first_by_workspace_id(pool, workspace_id)
            .await?
            .map(|session| session.id);

        Ok(WorkspaceContext {
            workspace,
            workspace_repos,
            orchestrator_session_id,
        })
    }

    /// Update container reference
    pub async fn update_container_ref(
        pool: &SqlitePool,
        workspace_id: Uuid,
        container_ref: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE workspaces SET container_ref = $1, updated_at = $2 WHERE id = $3",
            container_ref,
            now,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn mark_worktree_deleted(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET worktree_deleted = TRUE, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn clear_worktree_deleted(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET worktree_deleted = FALSE, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update the workspace's updated_at timestamp to prevent cleanup.
    /// Call this when the workspace is accessed (e.g., opened in editor).
    pub async fn touch(pool: &SqlitePool, workspace_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET updated_at = datetime('now', 'subsec') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool"
               FROM    workspaces
               WHERE   id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_rowid(pool: &SqlitePool, rowid: i64) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool"
               FROM    workspaces
               WHERE   rowid = $1"#,
            rowid
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn container_ref_exists(
        pool: &SqlitePool,
        container_ref: &str,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query!(
            r#"SELECT EXISTS(SELECT 1 FROM workspaces WHERE container_ref = ?) as "exists!: bool""#,
            container_ref
        )
        .fetch_one(pool)
        .await?;

        Ok(result.exists)
    }

    /// Find workspaces that are expired and eligible for cleanup.
    /// Uses accelerated cleanup (1 hour) for archived workspaces.
    /// Uses standard cleanup (72 hours) for non-archived workspaces.
    pub async fn find_expired_for_cleanup(
        pool: &SqlitePool,
    ) -> Result<Vec<Workspace>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"
            SELECT
                w.id as "id!: Uuid",
                w.task_id as "task_id: Uuid",
                w.container_ref,
                w.branch as "branch!",
                w.setup_completed_at as "setup_completed_at: DateTime<Utc>",
                w.created_at as "created_at!: DateTime<Utc>",
                w.updated_at as "updated_at!: DateTime<Utc>",
                w.archived as "archived!: bool",
                w.pinned as "pinned!: bool",
                w.name,
                w.worktree_deleted as "worktree_deleted!: bool"
            FROM workspaces w
            LEFT JOIN sessions s ON w.id = s.workspace_id
            LEFT JOIN execution_processes ep ON s.id = ep.session_id AND ep.completed_at IS NOT NULL
            WHERE w.container_ref IS NOT NULL
                AND w.worktree_deleted = FALSE
                AND w.id NOT IN (
                    SELECT DISTINCT s2.workspace_id
                    FROM sessions s2
                    JOIN execution_processes ep2 ON s2.id = ep2.session_id
                    WHERE ep2.completed_at IS NULL
                )
            GROUP BY w.id, w.container_ref, w.updated_at
            HAVING datetime('now', 'localtime',
                CASE
                    WHEN w.archived = 1
                    THEN '-1 hours'
                    ELSE '-72 hours'
                END
            ) > datetime(
                MAX(
                    max(
                        datetime(w.updated_at),
                        datetime(ep.completed_at)
                    )
                )
            )
            ORDER BY MAX(
                CASE
                    WHEN ep.completed_at IS NOT NULL THEN ep.completed_at
                    ELSE w.updated_at
                END
            ) ASC
            "#
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as!(
            Workspace,
            r#"INSERT INTO workspaces (id, task_id, container_ref, branch, setup_completed_at, name)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id as "id!: Uuid", task_id as "task_id: Uuid", container_ref, branch, setup_completed_at as "setup_completed_at: DateTime<Utc>", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>", archived as "archived!: bool", pinned as "pinned!: bool", name, worktree_deleted as "worktree_deleted!: bool""#,
            id,
            Option::<Uuid>::None,
            Option::<String>::None,
            data.branch,
            Option::<DateTime<Utc>>::None,
            data.name
        )
        .fetch_one(pool)
        .await?)
    }

    pub async fn update_branch_name(
        pool: &SqlitePool,
        workspace_id: Uuid,
        new_branch_name: &str,
    ) -> Result<(), WorkspaceError> {
        sqlx::query!(
            "UPDATE workspaces SET branch = $1, updated_at = datetime('now') WHERE id = $2",
            new_branch_name,
            workspace_id,
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Find workspace by path using container-ref path containment.
    /// Used by clients that may open a repo subfolder rather than the workspace root.
    pub async fn resolve_container_ref_by_prefix(
        pool: &SqlitePool,
        path: &str,
    ) -> Result<ContainerInfo, sqlx::Error> {
        let workspaces = sqlx::query_as!(
            WorkspaceContainerRefRow,
            r#"SELECT id as "id!: Uuid",
                      container_ref as "container_ref!"
               FROM workspaces
               WHERE container_ref IS NOT NULL"#,
        )
        .fetch_all(pool)
        .await?;

        Self::best_matching_container_ref(
            path,
            workspaces
                .iter()
                .map(|ws| (ws.id, ws.container_ref.as_str())),
        )
        .map(|workspace_id| ContainerInfo { workspace_id })
        .ok_or(sqlx::Error::RowNotFound)
    }

    fn best_matching_container_ref<'a>(
        path: &str,
        candidates: impl Iterator<Item = (Uuid, &'a str)>,
    ) -> Option<Uuid> {
        let path = std::path::Path::new(path);

        candidates
            .filter(|(_, container_ref)| {
                let container_ref = std::path::Path::new(container_ref);
                path.starts_with(container_ref) || container_ref.starts_with(path)
            })
            .max_by_key(|(_, container_ref)| {
                std::path::Path::new(container_ref).components().count()
            })
            .map(|(workspace_id, _)| workspace_id)
    }

    pub async fn set_archived(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET archived = $1, updated_at = datetime('now', 'subsec') WHERE id = $2",
            archived,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update workspace fields. Only non-None values will be updated.
    /// For `name`, pass `Some("")` to clear the name, `Some("foo")` to set it, or `None` to leave unchanged.
    pub async fn update(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: Option<bool>,
        pinned: Option<bool>,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        // Convert empty string to None for name field (to store as NULL)
        let name_value = name.filter(|s| !s.is_empty());
        let name_provided = name.is_some();

        sqlx::query!(
            r#"UPDATE workspaces SET
                archived = COALESCE($1, archived),
                pinned = COALESCE($2, pinned),
                name = CASE WHEN $3 THEN $4 ELSE name END,
                updated_at = datetime('now', 'subsec')
            WHERE id = $5"#,
            archived,
            pinned,
            name_provided,
            name_value,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_first_user_message(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let actions = sqlx::query_scalar!(
            r#"SELECT ep.executor_action as "executor_action!: sqlx::types::Json<ExecutorActionField>"
               FROM sessions s
               JOIN execution_processes ep ON ep.session_id = s.id
               WHERE s.workspace_id = $1
               ORDER BY s.created_at ASC, ep.created_at ASC"#,
            workspace_id
        )
        .fetch_all(pool)
        .await?;

        for action in actions {
            if let ExecutorActionField::ExecutorAction(action) = action.0
                && let Some(prompt) = Self::extract_first_prompt_from_executor_action(&action)
            {
                return Ok(Some(prompt));
            }
        }

        Ok(None)
    }

    fn extract_first_prompt_from_executor_action(action: &ExecutorAction) -> Option<String> {
        let mut current = Some(action);
        while let Some(action) = current {
            match action.typ() {
                ExecutorActionType::CodingAgentInitialRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::CodingAgentFollowUpRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::ReviewRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::ScriptRequest(_) => {
                    current = action.next_action();
                }
            }
        }
        None
    }

    pub fn truncate_to_name(prompt: &str, max_len: usize) -> String {
        let trimmed = prompt.trim();
        if trimmed.chars().count() <= max_len {
            trimmed.to_string()
        } else {
            let truncated: String = trimmed.chars().take(max_len).collect();
            if let Some(last_space) = truncated.rfind(' ') {
                format!("{}...", &truncated[..last_space])
            } else {
                format!("{}...", truncated)
            }
        }
    }

    pub async fn find_all_with_status(
        pool: &SqlitePool,
        archived: Option<bool>,
        limit: Option<i64>,
    ) -> Result<Vec<WorkspaceWithStatus>, sqlx::Error> {
        // Fetch all workspaces with status (uses cached SQLx query)
        let records = sqlx::query!(
            r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            ORDER BY w.updated_at DESC"#
        )
        .fetch_all(pool)
        .await?;

        let mut workspaces: Vec<WorkspaceWithStatus> = records
            .into_iter()
            .map(|rec| WorkspaceWithStatus {
                workspace: Workspace {
                    id: rec.id,
                    task_id: rec.task_id,
                    container_ref: rec.container_ref,
                    branch: rec.branch,
                    setup_completed_at: rec.setup_completed_at,
                    created_at: rec.created_at,
                    updated_at: rec.updated_at,
                    archived: rec.archived,
                    pinned: rec.pinned,
                    name: rec.name,
                    worktree_deleted: rec.worktree_deleted,
                },
                is_running: rec.is_running != 0,
                is_errored: rec.is_errored != 0,
            })
            // Apply archived filter if provided
            .filter(|ws| archived.is_none_or(|a| ws.workspace.archived == a))
            .collect();

        // Apply limit if provided (already sorted by updated_at DESC from query)
        if let Some(lim) = limit {
            workspaces.truncate(lim as usize);
        }

        for ws in &mut workspaces {
            if ws.workspace.name.is_none()
                && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
            {
                let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
                Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
                ws.workspace.name = Some(name);
            }
        }

        Ok(workspaces)
    }

    /// Delete a workspace by ID
    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM workspaces WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Count total workspaces across all projects
    pub async fn find_by_id_with_status(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<WorkspaceWithStatus>, sqlx::Error> {
        let rec = sqlx::query!(
            r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            WHERE w.id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await?;

        let Some(rec) = rec else {
            return Ok(None);
        };

        let mut ws = WorkspaceWithStatus {
            workspace: Workspace {
                id: rec.id,
                task_id: rec.task_id,
                container_ref: rec.container_ref,
                branch: rec.branch,
                setup_completed_at: rec.setup_completed_at,
                created_at: rec.created_at,
                updated_at: rec.updated_at,
                archived: rec.archived,
                pinned: rec.pinned,
                name: rec.name,
                worktree_deleted: rec.worktree_deleted,
            },
            is_running: rec.is_running != 0,
            is_errored: rec.is_errored != 0,
        };

        if ws.workspace.name.is_none()
            && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
        {
            let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
            Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
            ws.workspace.name = Some(name);
        }

        Ok(Some(ws))
    }
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::{DispatchState, Workspace};

    async fn insert_ws(pool: &SqlitePool) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'ws')")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        id
    }

    /// M1 #17: a deferred workspace records `queued` + its prompt/config, surfaces
    /// in the FIFO ready-list, and `dispatch_state` reads back.
    #[sqlx::test]
    async fn mark_queued_then_found_ready(pool: SqlitePool) {
        let id = insert_ws(&pool).await;
        // Ad-hoc until queued.
        assert!(
            Workspace::dispatch_state(&pool, id)
                .await
                .unwrap()
                .is_none()
        );

        // Needs a tier to be re-dispatchable.
        sqlx::query("UPDATE workspaces SET complexity_tier = 'medium' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        Workspace::mark_queued(&pool, id, "the prompt", "{\"cfg\":1}")
            .await
            .unwrap();

        assert_eq!(
            Workspace::dispatch_state(&pool, id).await.unwrap(),
            Some(DispatchState::Queued)
        );
        let ready = Workspace::find_queued_ready(&pool).await.unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, id);
        assert_eq!(ready[0].dispatch_prompt.as_deref(), Some("the prompt"));
        assert_eq!(
            ready[0].dispatch_executor_config.as_deref(),
            Some("{\"cfg\":1}")
        );
    }

    /// M1 #17: claiming a queued workspace for dispatch is exactly-once — the first
    /// caller flips queued→dispatched and wins; a second caller loses (no double-start).
    #[sqlx::test]
    async fn try_claim_for_dispatch_is_exactly_once(pool: SqlitePool) {
        let id = insert_ws(&pool).await;
        Workspace::mark_queued(&pool, id, "p", "{}").await.unwrap();

        assert!(Workspace::try_claim_for_dispatch(&pool, id).await.unwrap());
        assert_eq!(
            Workspace::dispatch_state(&pool, id).await.unwrap(),
            Some(DispatchState::Dispatched)
        );
        assert!(
            !Workspace::try_claim_for_dispatch(&pool, id).await.unwrap(),
            "a second claim must lose — no double-start"
        );
        // A dispatched workspace is no longer in the ready queue.
        assert!(
            Workspace::find_queued_ready(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// M1 #17: a failed/interrupted run flags the workspace for attention with a
    /// reason and the resumable marker.
    #[sqlx::test]
    async fn record_needs_attention_sets_flag_reason_interrupted(pool: SqlitePool) {
        let id = insert_ws(&pool).await;
        Workspace::record_needs_attention(&pool, id, super::ATTENTION_EXECUTOR_ERROR, true)
            .await
            .unwrap();

        let row: (bool, Option<String>, bool) = sqlx::query_as(
            "SELECT needs_attention, attention_reason, interrupted FROM workspaces WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(row.0, "needs_attention set");
        assert_eq!(row.1.as_deref(), Some("executor_error"));
        assert!(row.2, "interrupted (resumable) marker set");
    }

    #[test]
    fn best_matching_container_ref_prefers_deepest_match() {
        let broad_id = Uuid::new_v4();
        let exact_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/ws/repo/packages/app",
            [(broad_id, "/tmp"), (exact_id, "/tmp/ws")].into_iter(),
        );

        assert_eq!(selected, Some(exact_id));
    }

    #[test]
    fn best_matching_container_ref_supports_parent_request_path() {
        let workspace_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/ws/repo",
            [(workspace_id, "/tmp/ws/repo/packages/app")].into_iter(),
        );

        assert_eq!(selected, Some(workspace_id));
    }

    #[test]
    fn best_matching_container_ref_ignores_unrelated_paths() {
        let workspace_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/other/path",
            [(workspace_id, "/tmp/ws")].into_iter(),
        );

        assert_eq!(selected, None);
    }
}
