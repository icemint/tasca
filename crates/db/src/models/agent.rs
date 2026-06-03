use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool, Type};
use strum_macros::{Display, EnumString};
use ts_rs::TS;
use uuid::Uuid;

use super::task::ComplexityTier;

/// Runtime availability of an agent (PRD §4.2). Only `free` agents are eligible
/// for assignment; `busy`/`offline`/`paused` are skipped.
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
#[sqlx(type_name = "availability", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum Availability {
    #[default]
    Free,
    Busy,
    Offline,
    Paused,
}

/// A coding agent the assignment engine can dispatch work to (PRD §4.2). Local
/// (SQLite) pool; `org_id` links a cloud-managed agent. `active_sessions` is
/// mutated only through the atomic [`Agent::claim`]/[`Agent::release`] helpers.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Agent {
    pub id: Uuid,
    pub org_id: Option<Uuid>,
    pub name: String,
    pub executor_profile: String,
    pub base_url: Option<String>,
    pub credential_ref: Option<Uuid>,
    pub max_complexity_tier: ComplexityTier,
    pub min_complexity_tier: ComplexityTier,
    pub availability: Availability,
    pub concurrency_limit: i64,
    pub active_sessions: i64,
    pub sandbox_profile: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Agent {
    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Agent,
            r#"SELECT id as "id!: Uuid", org_id as "org_id: Uuid", name, executor_profile, base_url, credential_ref as "credential_ref: Uuid", max_complexity_tier as "max_complexity_tier!: ComplexityTier", min_complexity_tier as "min_complexity_tier!: ComplexityTier", availability as "availability!: Availability", concurrency_limit as "concurrency_limit!: i64", active_sessions as "active_sessions!: i64", sandbox_profile, created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>"
               FROM agents WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// Agents that could take a task of `tier`: `free`, with spare capacity, and
    /// whose `[min, max]` band contains `tier`. SQL prefilters availability +
    /// capacity; the ordinal tier band is checked in Rust (TEXT tiers don't sort
    /// ordinally in SQL).
    pub async fn find_available_for_tier(
        pool: &SqlitePool,
        tier: ComplexityTier,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let candidates = sqlx::query_as!(
            Agent,
            r#"SELECT id as "id!: Uuid", org_id as "org_id: Uuid", name, executor_profile, base_url, credential_ref as "credential_ref: Uuid", max_complexity_tier as "max_complexity_tier!: ComplexityTier", min_complexity_tier as "min_complexity_tier!: ComplexityTier", availability as "availability!: Availability", concurrency_limit as "concurrency_limit!: i64", active_sessions as "active_sessions!: i64", sandbox_profile, created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>"
               FROM agents
               WHERE availability = 'free' AND active_sessions < concurrency_limit
               ORDER BY active_sessions ASC, created_at ASC"#
        )
        .fetch_all(pool)
        .await?;

        Ok(candidates
            .into_iter()
            .filter(|a| a.min_complexity_tier <= tier && tier <= a.max_complexity_tier)
            .collect())
    }

    /// Atomically claim one slot. The conditional `UPDATE … WHERE active_sessions
    /// < concurrency_limit AND availability='free'` makes concurrent dispatchers
    /// safe: the winner gets `Some(agent)`, every loser gets `None` and re-queries
    /// (PRD §5.4). No over-claiming the single-GPU local agent.
    pub async fn claim(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Agent,
            r#"UPDATE agents
               SET active_sessions = active_sessions + 1, updated_at = datetime('now', 'subsec')
               WHERE id = $1 AND active_sessions < concurrency_limit AND availability = 'free'
               RETURNING id as "id!: Uuid", org_id as "org_id: Uuid", name, executor_profile, base_url, credential_ref as "credential_ref: Uuid", max_complexity_tier as "max_complexity_tier!: ComplexityTier", min_complexity_tier as "min_complexity_tier!: ComplexityTier", availability as "availability!: Availability", concurrency_limit as "concurrency_limit!: i64", active_sessions as "active_sessions!: i64", sandbox_profile, created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>""#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    /// Release a previously-claimed slot. Floored at 0 so a double-release can't
    /// drive `active_sessions` negative.
    pub async fn release(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE agents
               SET active_sessions = max(active_sessions - 1, 0), updated_at = datetime('now', 'subsec')
               WHERE id = $1"#,
            id
        )
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Runtime query (not the compile-time macro) so this test-only insert needs
    // no entry in the offline .sqlx cache.
    async fn insert_agent(pool: &SqlitePool, id: Uuid, concurrency_limit: i64, max_tier: &str) {
        sqlx::query(
            "INSERT INTO agents (id, name, executor_profile, max_complexity_tier, min_complexity_tier, availability, concurrency_limit, active_sessions)
             VALUES (?, 'test-agent', 'CLAUDE_CODE', ?, 'basic', 'free', ?, 0)",
        )
        .bind(id)
        .bind(max_tier)
        .bind(concurrency_limit)
        .execute(pool)
        .await
        .unwrap();
    }

    /// PRD §5.4: dispatchers must never over-claim a `concurrency_limit=1` agent.
    /// SQLite serializes writes, so the conditional `UPDATE … WHERE active_sessions
    /// < concurrency_limit` guard is exactly what makes a claim race-safe: the
    /// first claim wins, every subsequent claim is refused until a slot frees.
    #[sqlx::test]
    async fn claim_respects_concurrency_limit(pool: SqlitePool) {
        let id = Uuid::new_v4();
        insert_agent(&pool, id, 1, "ultra").await;

        let first = Agent::claim(&pool, id).await.unwrap();
        let second = Agent::claim(&pool, id).await.unwrap();
        assert!(first.is_some(), "first claim wins the only slot");
        assert!(
            second.is_none(),
            "second claim is refused (would over-claim)"
        );
        assert_eq!(first.unwrap().active_sessions, 1);

        // Releasing the slot lets the next claim succeed.
        Agent::release(&pool, id).await.unwrap();
        assert!(Agent::claim(&pool, id).await.unwrap().is_some());
    }

    #[sqlx::test]
    async fn find_available_respects_tier_band(pool: SqlitePool) {
        let id = Uuid::new_v4();
        insert_agent(&pool, id, 1, "medium").await; // band = [basic, medium]

        // In band.
        assert_eq!(
            Agent::find_available_for_tier(&pool, ComplexityTier::Low)
                .await
                .unwrap()
                .len(),
            1
        );
        // Above the agent's max tier.
        assert_eq!(
            Agent::find_available_for_tier(&pool, ComplexityTier::Hard)
                .await
                .unwrap()
                .len(),
            0
        );
    }

    #[sqlx::test]
    async fn release_floors_at_zero(pool: SqlitePool) {
        let id = Uuid::new_v4();
        insert_agent(&pool, id, 2, "ultra").await;
        // Releasing an idle agent must not drive active_sessions negative.
        Agent::release(&pool, id).await.unwrap();
        let agent = Agent::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(agent.active_sessions, 0);
    }
}
