use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

use super::workspace_repo::WorkspaceRepo;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Session not found")]
    NotFound,
    #[error("Workspace not found")]
    WorkspaceNotFound,
    #[error("Executor mismatch: session uses {expected} but request specified {actual}")]
    ExecutorMismatch { expected: String, actual: String },
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Session {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: Option<String>,
    pub executor: Option<String>,
    pub agent_working_dir: Option<String>,
    /// The Agent whose concurrency slot this session holds (M1 #16). `Some` only
    /// when the assignment engine routed the workspace; cleared to `None` exactly
    /// once when the run finalizes (see [`Session::take_claimed_agent`]).
    pub claimed_agent_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateSession {
    pub executor: Option<String>,
    pub name: Option<String>,
}

impl Session {
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Session,
            r#"SELECT id AS "id!: Uuid",
                      workspace_id AS "workspace_id!: Uuid",
                      name,
                      executor,
                      agent_working_dir,
                      claimed_agent_id AS "claimed_agent_id: Uuid",
                      created_at AS "created_at!: DateTime<Utc>",
                      updated_at AS "updated_at!: DateTime<Utc>"
               FROM sessions
               WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// Find all sessions for a workspace, ordered by most recently used.
    /// "Most recently used" is defined as the most recent non-dev server execution process.
    /// Sessions with no executions fall back to created_at for ordering.
    pub async fn find_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            Session,
            r#"SELECT s.id AS "id!: Uuid",
                      s.workspace_id AS "workspace_id!: Uuid",
                      s.name,
                      s.executor,
                      s.agent_working_dir,
                      s.claimed_agent_id AS "claimed_agent_id: Uuid",
                      s.created_at AS "created_at!: DateTime<Utc>",
                      s.updated_at AS "updated_at!: DateTime<Utc>"
               FROM sessions s
               LEFT JOIN (
                   SELECT ep.session_id, MAX(ep.created_at) as last_used
                   FROM execution_processes ep
                   WHERE ep.run_reason != 'devserver' AND ep.dropped = FALSE
                   GROUP BY ep.session_id
               ) latest_ep ON s.id = latest_ep.session_id
               WHERE s.workspace_id = $1
               ORDER BY COALESCE(latest_ep.last_used, s.created_at) DESC"#,
            workspace_id
        )
        .fetch_all(pool)
        .await
    }

    /// Find the most recently used session for a workspace.
    /// "Most recently used" is defined as the most recent non-dev server execution process.
    /// Sessions with no executions fall back to created_at for ordering.
    pub async fn find_latest_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Session,
            r#"SELECT s.id AS "id!: Uuid",
                      s.workspace_id AS "workspace_id!: Uuid",
                      s.name,
                      s.executor,
                      s.agent_working_dir,
                      s.claimed_agent_id AS "claimed_agent_id: Uuid",
                      s.created_at AS "created_at!: DateTime<Utc>",
                      s.updated_at AS "updated_at!: DateTime<Utc>"
               FROM sessions s
               LEFT JOIN (
                   SELECT ep.session_id, MAX(ep.created_at) as last_used
                   FROM execution_processes ep
                   WHERE ep.run_reason != 'devserver' AND ep.dropped = FALSE
                   GROUP BY ep.session_id
               ) latest_ep ON s.id = latest_ep.session_id
               WHERE s.workspace_id = $1
               ORDER BY COALESCE(latest_ep.last_used, s.created_at) DESC
               LIMIT 1"#,
            workspace_id
        )
        .fetch_optional(pool)
        .await
    }

    /// Find the first-created session for a workspace.
    /// This is a temporary policy for orchestrator MCP session discovery.
    pub async fn find_first_by_workspace_id(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Session>(
            r#"SELECT id,
                      workspace_id,
                      name,
                      executor,
                      agent_working_dir,
                      claimed_agent_id,
                      created_at,
                      updated_at
               FROM sessions
               WHERE workspace_id = ?
               ORDER BY created_at ASC, id ASC
               LIMIT 1"#,
        )
        .bind(workspace_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateSession,
        id: Uuid,
        workspace_id: Uuid,
    ) -> Result<Self, SessionError> {
        let agent_working_dir = Self::resolve_agent_working_dir(pool, workspace_id).await?;
        let name = data.name.as_deref().filter(|s| !s.is_empty());

        Ok(sqlx::query_as!(
            Session,
            r#"INSERT INTO sessions (id, workspace_id, name, executor, agent_working_dir)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id AS "id!: Uuid",
                         workspace_id AS "workspace_id!: Uuid",
                         name,
                         executor,
                         agent_working_dir,
                         claimed_agent_id AS "claimed_agent_id: Uuid",
                         created_at AS "created_at!: DateTime<Utc>",
                         updated_at AS "updated_at!: DateTime<Utc>""#,
            id,
            workspace_id,
            name,
            data.executor,
            agent_working_dir
        )
        .fetch_one(pool)
        .await?)
    }

    /// Record the Agent whose concurrency slot this session holds (M1 #16).
    /// Called once, right after [`Session::create`], when the assignment engine
    /// routed the workspace to an agent.
    pub async fn set_claimed_agent(
        pool: &SqlitePool,
        id: Uuid,
        agent_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE sessions
               SET claimed_agent_id = $2, updated_at = datetime('now', 'subsec')
               WHERE id = $1"#,
            id,
            agent_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Atomically take (read-and-clear) the claimed agent id, if any (M1 #16).
    /// Returns `Some(agent_id)` to exactly one caller — that caller owns releasing
    /// the slot. Concurrent/later finalizes (e.g. follow-up runs on the same
    /// session, or a start-failure path racing the finalize monitor) get `None`
    /// and must not double-release.
    ///
    /// SQLite's `RETURNING` reports the POST-update row, so a single
    /// `UPDATE ... SET NULL ... RETURNING claimed_agent_id` would always yield the
    /// NULL it just wrote — never the agent id. So we read the value first, then
    /// clear it with a compare-and-clear: among concurrent callers (writes are
    /// serialized in SQLite) exactly one `UPDATE ... WHERE claimed_agent_id = $2`
    /// matches a non-NULL row and reports `rows_affected() == 1`.
    pub async fn take_claimed_agent(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let claimed: Option<Uuid> = sqlx::query_scalar!(
            r#"SELECT claimed_agent_id AS "claimed_agent_id: Uuid" FROM sessions WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await?
        .flatten();

        let Some(agent_id) = claimed else {
            return Ok(None);
        };

        let res = sqlx::query!(
            r#"UPDATE sessions
               SET claimed_agent_id = NULL, updated_at = datetime('now', 'subsec')
               WHERE id = $1 AND claimed_agent_id = $2"#,
            id,
            agent_id
        )
        .execute(pool)
        .await?;

        Ok((res.rows_affected() == 1).then_some(agent_id))
    }

    /// Clear every session's claimed-agent marker (M1 #16 startup recovery). At
    /// process startup no agent run is in flight, so any lingering marker is a
    /// stale claim from a previous run that crashed before finalize. Paired with
    /// [`Agent::reset_active_sessions`] in the orphan-cleanup startup path, this
    /// heals any leaked concurrency slot across a restart.
    pub async fn clear_all_claimed_agents(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
        let res = sqlx::query!(
            r#"UPDATE sessions
               SET claimed_agent_id = NULL, updated_at = datetime('now', 'subsec')
               WHERE claimed_agent_id IS NOT NULL"#
        )
        .execute(pool)
        .await?;
        Ok(res.rows_affected())
    }

    async fn resolve_agent_working_dir(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await?;
        if repos.len() != 1 {
            return Ok(None);
        }

        let repo = &repos[0];
        let path = match repo.default_working_dir.as_deref() {
            Some(subdir) if !subdir.is_empty() => std::path::PathBuf::from(&repo.name).join(subdir),
            _ => std::path::PathBuf::from(&repo.name),
        };

        Ok(Some(path.to_string_lossy().to_string()))
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let name_value = name.filter(|s| !s.is_empty());
        let name_provided = name.is_some();

        sqlx::query!(
            r#"UPDATE sessions SET
                name = CASE WHEN $1 THEN $2 ELSE name END,
                updated_at = datetime('now', 'subsec')
            WHERE id = $3"#,
            name_provided,
            name_value,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_executor(
        pool: &SqlitePool,
        id: Uuid,
        executor: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE sessions SET executor = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2"#,
            executor,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::*;

    /// Insert a bare session row. The FK to `workspaces` is irrelevant to the
    /// claim logic under test, so disable FK enforcement on this connection and
    /// insert directly (created_at/updated_at default).
    async fn insert_session(pool: &SqlitePool, id: Uuid, claimed: Option<Uuid>) {
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id, claimed_agent_id) VALUES (?, ?, ?)")
            .bind(id)
            .bind(Uuid::new_v4())
            .bind(claimed)
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    /// M1 #16 regression: `take_claimed_agent` must return the *claimed* id, then
    /// `None` on a second call (exactly-once). A naive `UPDATE ... SET NULL ...
    /// RETURNING claimed_agent_id` would return the post-clear NULL and leak the
    /// slot on every release — this guards that bug.
    #[sqlx::test]
    async fn take_claimed_agent_returns_id_then_none(pool: SqlitePool) {
        let session_id = Uuid::new_v4();
        let agent_id = Uuid::new_v4();
        insert_session(&pool, session_id, Some(agent_id)).await;

        assert_eq!(
            Session::take_claimed_agent(&pool, session_id)
                .await
                .unwrap(),
            Some(agent_id),
            "first take returns the claimed agent id"
        );
        assert_eq!(
            Session::take_claimed_agent(&pool, session_id)
                .await
                .unwrap(),
            None,
            "second take is a no-op — released exactly once"
        );
    }

    #[sqlx::test]
    async fn take_claimed_agent_none_when_unclaimed(pool: SqlitePool) {
        let session_id = Uuid::new_v4();
        insert_session(&pool, session_id, None).await;
        assert_eq!(
            Session::take_claimed_agent(&pool, session_id)
                .await
                .unwrap(),
            None
        );
    }

    /// M1 #16 startup recovery: clears every lingering claim marker.
    #[sqlx::test]
    async fn clear_all_claimed_agents_clears_markers(pool: SqlitePool) {
        let s1 = Uuid::new_v4();
        let s2 = Uuid::new_v4();
        insert_session(&pool, s1, Some(Uuid::new_v4())).await;
        insert_session(&pool, s2, None).await;

        let cleared = Session::clear_all_claimed_agents(&pool).await.unwrap();
        assert_eq!(cleared, 1, "only the one claimed session was cleared");
        assert_eq!(
            Session::take_claimed_agent(&pool, s1).await.unwrap(),
            None,
            "marker is gone after the startup clear"
        );
    }
}
