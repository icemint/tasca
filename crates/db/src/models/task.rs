use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool, Type};
use strum_macros::{Display, EnumString};
use ts_rs::TS;
use uuid::Uuid;

#[derive(
    Debug, Clone, Type, Serialize, Deserialize, PartialEq, TS, EnumString, Display, Default,
)]
#[sqlx(type_name = "task_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum TaskStatus {
    #[default]
    Todo,
    InProgress,
    InReview,
    Done,
    Cancelled,
}

/// Capability tier of a task (PRD §4.1). Lower tiers demand more up-front
/// decomposition; the assignment engine matches a task's tier to an agent's
/// `[min, max]` tier band. Variants are declared in ascending tier order, so the
/// derived `Ord` yields the ordinal band comparison the engine relies on.
#[derive(
    Debug,
    Clone,
    Copy,
    Type,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    TS,
    EnumString,
    Display,
    Default,
)]
#[sqlx(type_name = "complexity_tier", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum ComplexityTier {
    Basic,
    Low,
    #[default]
    Medium,
    Hard,
    Ultra,
}

/// How a task's tier was set (PRD §4.1 / §13.4). v1 is `manual` + PM-assistant
/// `assistant`; the dedicated `classifier` is deferred to v2.
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
#[sqlx(type_name = "tier_source", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum TierSource {
    #[default]
    Manual,
    Assistant,
    Classifier,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Task {
    pub id: Uuid,
    pub project_id: Uuid, // Foreign key to Project
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub complexity_tier: ComplexityTier,
    pub tier_source: TierSource,
    pub tier_confidence: Option<f64>,
    pub sprint_id: Option<Uuid>, // Active-sprint scoping for assignment (PRD §4.3)
    pub parent_workspace_id: Option<Uuid>, // Foreign key to parent Workspace
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Task {
    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            Task,
            r#"SELECT id as "id!: Uuid", project_id as "project_id!: Uuid", title, description, status as "status!: TaskStatus", complexity_tier as "complexity_tier!: ComplexityTier", tier_source as "tier_source!: TierSource", tier_confidence, sprint_id as "sprint_id: Uuid", parent_workspace_id as "parent_workspace_id: Uuid", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>"
               FROM tasks
               ORDER BY created_at ASC"#
        )
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Task,
            r#"SELECT id as "id!: Uuid", project_id as "project_id!: Uuid", title, description, status as "status!: TaskStatus", complexity_tier as "complexity_tier!: ComplexityTier", tier_source as "tier_source!: TierSource", tier_confidence, sprint_id as "sprint_id: Uuid", parent_workspace_id as "parent_workspace_id: Uuid", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>"
               FROM tasks
               WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// Persist a manual (or assistant-suggested) tier override for a task.
    /// `confidence` is `NULL` for manual edits.
    pub async fn set_tier(
        pool: &SqlitePool,
        id: Uuid,
        tier: ComplexityTier,
        source: TierSource,
        confidence: Option<f64>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE tasks
               SET complexity_tier = $1, tier_source = $2, tier_confidence = $3,
                   updated_at = datetime('now', 'subsec')
               WHERE id = $4"#,
            tier,
            source,
            confidence,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }
}
