use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Type;
use ts_rs::TS;
use uuid::Uuid;

use crate::MemberRole;

/// Canonical feature-flag names accepted by the per-org flags API (#156). Mirrors
/// `FLAG_NAMES` in `packages/web-core/src/shared/flags/flags.ts` — keep in sync;
/// the PATCH endpoint rejects any key not in this list so typos fail loudly
/// instead of accumulating junk in the `organizations.feature_flags` JSONB.
pub const FEATURE_FLAG_NAMES: &[&str] = &[
    "tiers",
    "agents",
    "sprints",
    "run_view",
    "audit_timeline",
    "github_pr",
    "sandbox",
    "pm_assistant",
    "roles",
    "guest",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[sqlx(type_name = "invitation_status", rename_all = "lowercase")]
#[ts(use_ts_enum)]
#[ts(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InvitationStatus {
    Pending,
    Accepted,
    Declined,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub is_personal: bool,
    pub issue_prefix: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Per-org feature flags (#156): a `{ flag_name: bool }` JSONB map. `{}` means
    /// "unset" — the client falls through to env/default-off. Stored loosely;
    /// the client narrows to known flags.
    pub feature_flags: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, TS)]
pub struct OrganizationWithRole {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub is_personal: bool,
    pub issue_prefix: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub user_role: MemberRole,
    /// Per-org feature flags (#156); see `Organization::feature_flags`.
    pub feature_flags: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListOrganizationsResponse {
    pub organizations: Vec<OrganizationWithRole>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GetOrganizationResponse {
    pub organization: Organization,
    pub user_role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateOrganizationRequest {
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateOrganizationResponse {
    pub organization: OrganizationWithRole,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpdateOrganizationRequest {
    pub name: String,
}

/// Replace an org's feature flags (#156). Admin-only. Keys are validated against
/// [`FEATURE_FLAG_NAMES`]; unknown keys are rejected.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpdateOrganizationFlagsRequest {
    pub feature_flags: HashMap<String, bool>,
}

// Invitation types

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Invitation {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub invited_by_user_id: Option<Uuid>,
    pub email: String,
    pub role: MemberRole,
    pub status: InvitationStatus,
    pub token: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateInvitationRequest {
    pub email: String,
    pub role: MemberRole,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateInvitationResponse {
    pub invitation: Invitation,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListInvitationsResponse {
    pub invitations: Vec<Invitation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GetInvitationResponse {
    pub id: Uuid,
    pub organization_slug: String,
    pub role: MemberRole,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AcceptInvitationResponse {
    pub organization_id: String,
    pub organization_slug: String,
    pub role: MemberRole,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RevokeInvitationRequest {
    pub invitation_id: Uuid,
}

// Member types

/// Organization member info for API responses (without organization_id).
/// See also `OrganizationMember` in organization_member.rs for the full DB row type.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct OrganizationMemberInfo {
    pub user_id: Uuid,
    pub role: MemberRole,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct OrganizationMemberWithProfile {
    pub user_id: Uuid,
    pub role: MemberRole,
    pub joined_at: DateTime<Utc>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListMembersResponse {
    pub members: Vec<OrganizationMemberWithProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpdateMemberRoleRequest {
    pub role: MemberRole,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct UpdateMemberRoleResponse {
    pub user_id: Uuid,
    pub role: MemberRole,
}
