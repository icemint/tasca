use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Type;
use ts_rs::TS;
use uuid::Uuid;

use crate::some_if_present;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS)]
#[sqlx(type_name = "issue_priority", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum IssuePriority {
    Urgent,
    High,
    Medium,
    Low,
}

/// Capability tier of an issue (PRD §4.1) — the remote mirror of the local
/// `Task` tier. Drives the board tier badge/filter and the assignment hand-off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS, Default)]
#[sqlx(type_name = "complexity_tier", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum ComplexityTier {
    Basic,
    Low,
    #[default]
    Medium,
    Hard,
    Ultra,
}

/// How an issue's tier was set (PRD §4.1 / §13.4): manual, PM-assistant, or
/// (v2) auto-classifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS, Default)]
#[sqlx(type_name = "tier_source", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum TierSource {
    #[default]
    Manual,
    Assistant,
    Classifier,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, sqlx::FromRow)]
pub struct Issue {
    pub id: Uuid,
    pub project_id: Uuid,
    pub issue_number: i32,
    pub simple_id: String,
    pub status_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<IssuePriority>,
    pub complexity_tier: ComplexityTier,
    pub tier_source: TierSource,
    pub tier_confidence: Option<f64>,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub sort_order: f64,
    pub parent_issue_id: Option<Uuid>,
    pub parent_issue_sort_order: Option<f64>,
    pub extension_metadata: Value,
    pub creator_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueSortField {
    SortOrder,
    Priority,
    CreatedAt,
    UpdatedAt,
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateIssueRequest {
    /// Optional client-generated ID. If not provided, server generates one.
    /// Using client-generated IDs enables stable optimistic updates.
    #[ts(optional)]
    pub id: Option<Uuid>,
    pub project_id: Uuid,
    pub status_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<IssuePriority>,
    #[ts(optional)]
    pub complexity_tier: Option<ComplexityTier>,
    #[ts(optional)]
    pub tier_source: Option<TierSource>,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub sort_order: f64,
    pub parent_issue_id: Option<Uuid>,
    pub parent_issue_sort_order: Option<f64>,
    pub extension_metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpdateIssueRequest {
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub status_id: Option<Uuid>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub priority: Option<Option<IssuePriority>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub complexity_tier: Option<ComplexityTier>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub tier_source: Option<TierSource>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub tier_confidence: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub start_date: Option<Option<DateTime<Utc>>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_date: Option<Option<DateTime<Utc>>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<Option<DateTime<Utc>>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub sort_order: Option<f64>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_issue_id: Option<Option<Uuid>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_issue_sort_order: Option<Option<f64>>,
    #[serde(
        default,
        deserialize_with = "some_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub extension_metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListIssuesQuery {
    pub project_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SearchIssuesRequest {
    pub project_id: Uuid,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_id: Option<Uuid>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_ids: Option<Vec<Uuid>>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<IssuePriority>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_issue_id: Option<Uuid>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simple_id: Option<String>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_user_id: Option<Uuid>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_id: Option<Uuid>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<Uuid>>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_field: Option<IssueSortField>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_direction: Option<SortDirection>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListIssuesResponse {
    pub issues: Vec<Issue>,
    pub total_count: usize,
    pub limit: usize,
    pub offset: usize,
}
