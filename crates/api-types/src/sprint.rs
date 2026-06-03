use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Type;
use ts_rs::TS;
use uuid::Uuid;

/// Lifecycle of a sprint (PRD §4.3). The board UI scopes by the active sprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS, Default)]
#[sqlx(type_name = "sprint_state", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum SprintState {
    #[default]
    Planned,
    Active,
    Closed,
}

/// A sprint — a first-class, time-boxed scope (PRD §4.3 / §13.2), streamed to the
/// board UI via Electric and used by the assignment engine for pickup scoping.
#[derive(Debug, Clone, Serialize, Deserialize, TS, sqlx::FromRow)]
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
