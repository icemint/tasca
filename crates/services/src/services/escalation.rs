//! M1 #17: human-gated tier escalation. Bumps a workspace's linked Issue one
//! complexity tier (`tier_source = Manual`) so the next engine pass routes it to a
//! higher band, syncs the local mirror, and clears the needs-attention flag.
//! Allowed even when no agent can take the new tier — it just warns (PRD §5.3:
//! "manual override outside the tier ceiling is allowed, warns, audit-tagged"; the
//! remote records the override via `tier_source = Manual`).

use api_types::issue::{ComplexityTier as ApiTier, TierSource, UpdateIssueRequest};
use db::models::{agent::Agent, task::ComplexityTier, workspace::Workspace};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::remote_client::{RemoteClient, RemoteClientError};

#[derive(Debug, thiserror::Error)]
pub enum EscalateError {
    #[error("workspace has no linked issue to escalate")]
    NoLinkedIssue,
    #[error("workspace is already at the ceiling tier (ultra)")]
    AtCeiling,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Remote(#[from] RemoteClientError),
}

#[derive(Debug, PartialEq, Eq)]
pub struct EscalateOutcome {
    pub new_tier: ComplexityTier,
    /// `true` when no configured agent's band covers the new tier — the override is
    /// allowed, but the workspace will queue with no capable agent until one is
    /// configured. The caller surfaces this as a warning.
    pub beyond_agent_ceiling: bool,
}

/// Map the local tier to the remote Issue's tier enum (identical variants).
fn db_tier_to_api(tier: ComplexityTier) -> ApiTier {
    match tier {
        ComplexityTier::Basic => ApiTier::Basic,
        ComplexityTier::Low => ApiTier::Low,
        ComplexityTier::Medium => ApiTier::Medium,
        ComplexityTier::Hard => ApiTier::Hard,
        ComplexityTier::Ultra => ApiTier::Ultra,
    }
}

/// Whether any agent in the pool can take `tier` (its `[min, max]` band covers it).
fn pool_covers_tier(agents: &[Agent], tier: ComplexityTier) -> bool {
    agents
        .iter()
        .any(|a| a.min_complexity_tier <= tier && tier <= a.max_complexity_tier)
}

/// Escalate the workspace's linked issue one tier (M1 #17). Writes the new tier to
/// the remote Issue with `tier_source = Manual` (the durable manual-override
/// record the remote audits), syncs the local denormalized tier so the next engine
/// pass routes higher, and clears the needs-attention flag.
pub async fn escalate_workspace_tier(
    pool: &SqlitePool,
    client: &RemoteClient,
    workspace_id: Uuid,
) -> Result<EscalateOutcome, EscalateError> {
    let Some(wac) = Workspace::assignment_context(pool, workspace_id).await? else {
        return Err(EscalateError::NoLinkedIssue);
    };
    let Some(issue_id) = wac.remote_issue_id else {
        return Err(EscalateError::NoLinkedIssue);
    };
    let current = wac.complexity_tier.unwrap_or_default();
    let Some(next) = current.next_up() else {
        return Err(EscalateError::AtCeiling);
    };

    // Authoritative write on the remote Issue, manual-tagged.
    client
        .update_issue(
            issue_id,
            &UpdateIssueRequest {
                complexity_tier: Some(db_tier_to_api(next)),
                tier_source: Some(TierSource::Manual),
                ..Default::default()
            },
        )
        .await?;

    // Sync the local mirror + clear attention (the operator handled it).
    Workspace::set_complexity_tier(pool, workspace_id, next).await?;
    Workspace::clear_attention(pool, workspace_id).await?;

    let beyond_agent_ceiling = !pool_covers_tier(&Agent::list(pool).await?, next);
    Ok(EscalateOutcome {
        new_tier: next,
        beyond_agent_ceiling,
    })
}
