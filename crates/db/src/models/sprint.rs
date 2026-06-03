use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool, Type};
use strum_macros::{Display, EnumString};
use ts_rs::TS;
use uuid::Uuid;

/// Lifecycle of a sprint (PRD §4.3). The assignment engine only scopes pickup to
/// the single `active` sprint per project.
#[derive(
    Debug,
    Clone,
    Copy,
    Type,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    TS,
    EnumString,
    Display,
    Default,
)]
#[sqlx(type_name = "sprint_state", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum SprintState {
    #[default]
    Planned,
    Active,
    Closed,
}

/// A sprint — a time-boxed scope used by the assignment engine to decide which
/// tasks are eligible for pickup (PRD §4.3 / §13.2).
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Sprint {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub state: SprintState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Sprint {
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Sprint,
            r#"SELECT id as "id!: Uuid", project_id as "project_id!: Uuid", name, starts_at as "starts_at: DateTime<Utc>", ends_at as "ends_at: DateTime<Utc>", state as "state!: SprintState", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>"
               FROM sprints WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// The single active sprint for a project, if any. `NULL` (None) means the
    /// project has no active sprint, which the engine treats as "no sprint
    /// filter" for backward compatibility.
    pub async fn active_for_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Sprint,
            r#"SELECT id as "id!: Uuid", project_id as "project_id!: Uuid", name, starts_at as "starts_at: DateTime<Utc>", ends_at as "ends_at: DateTime<Utc>", state as "state!: SprintState", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>"
               FROM sprints
               WHERE project_id = $1 AND state = 'active'
               ORDER BY starts_at DESC
               LIMIT 1"#,
            project_id
        )
        .fetch_optional(pool)
        .await
    }
}
