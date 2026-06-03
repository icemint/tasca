//! M1 #16: the impure half of the assignment engine. The pure decision —
//! "given this routing context and agent pool, which agent (if any)?" — lives in
//! the `assignment-engine` crate ([`decide`]). This module does the DB-touching
//! work around it: resolve a started workspace's routing context, list the agent
//! pool, and atomically claim the selected agent's concurrency slot, re-querying
//! on a lost race (PRD §5.4). It is kept out of `assignment-engine` so that crate
//! stays a pure, side-effect-free leaf.

use assignment_engine::{Assignment, AssignmentContext, AssignmentDecision, decide};
use db::models::{agent::Agent, sprint::Sprint, workspace::Workspace};
use sqlx::SqlitePool;

/// Resolve the routing context for a started workspace, or `None` when there is
/// nothing to route. The tier/sprint are denormalized onto the workspace from its
/// linked remote Issue at create-and-start (M1 #143); a workspace with no linked
/// tiered issue has no `complexity_tier`, so this returns `None` and the caller
/// uses its explicit executor config — byte-for-byte upstream behavior.
pub async fn context_for_workspace(
    pool: &SqlitePool,
    workspace: &Workspace,
) -> Result<Option<AssignmentContext>, sqlx::Error> {
    let Some(wac) = Workspace::assignment_context(pool, workspace.id).await? else {
        return Ok(None);
    };
    let Some(tier) = wac.complexity_tier else {
        return Ok(None);
    };
    let active_sprint = match wac.remote_project_id {
        Some(project_id) => Sprint::active_for_project(pool, project_id).await?,
        None => None,
    };
    Ok(Some(AssignmentContext {
        tier,
        sprint_id: wac.sprint_id,
        active_sprint_id: active_sprint.map(|s| s.id),
        // v1: the issue's assignee / blocked-by inputs are not yet wired through
        // (they arrive with #17 escalation), so a started workspace is treated as
        // unassigned and unblocked — `decide()` never returns Blocked/already-
        // assigned here until then.
        is_unassigned: true,
        is_blocked: false,
    }))
}

/// List the agent pool, ask [`decide`], and atomically claim the selected agent —
/// re-querying on a lost race so the loser never over-claims (PRD §5.4).
///
/// - `Ok(Some(assignment))` — an agent was selected *and* its slot claimed. The
///   caller starts the session with `assignment.executor_config` + `assignment.env`
///   and must release the slot when the run finalizes.
/// - `Ok(None)` — no engine assignment (empty pool / already-assigned / outside
///   the active sprint / no capable agent / all capable agents busy, or we lost
///   every claim race). The caller uses its explicit executor config — byte-for-byte
///   upstream behavior (PRD §5.1).
pub async fn claim_assignment(
    pool: &SqlitePool,
    ctx: &AssignmentContext,
) -> Result<Option<Assignment>, sqlx::Error> {
    // Bound the retry loop: each lost race means another dispatcher consumed an
    // agent's free slot, so after at most `pool_len + 1` attempts the pool is
    // exhausted and `decide()` yields a non-Assigned outcome. The cap is a
    // belt-and-suspenders guard against an unexpected non-converging spin.
    let mut attempts = 0usize;
    let mut cap = usize::MAX;
    loop {
        let agents = Agent::list(pool).await?;
        if attempts == 0 {
            cap = agents.len().saturating_add(1);
        }
        attempts += 1;

        match decide(ctx, &agents) {
            AssignmentDecision::Assigned(assignment) => {
                // Atomic conditional claim. `Some` ⇒ we own the slot. `None` ⇒ a
                // concurrent dispatcher claimed it first; re-query and let decide()
                // pick again from a fresh snapshot.
                if Agent::claim(pool, assignment.agent.id).await?.is_some() {
                    return Ok(Some(*assignment));
                }
                if attempts >= cap {
                    return Ok(None);
                }
            }
            // Every non-Assigned outcome means "use the explicit config".
            AssignmentDecision::Queued
            | AssignmentDecision::NoCapableAgent
            | AssignmentDecision::Blocked
            | AssignmentDecision::ManualOverride => return Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use db::models::task::ComplexityTier;
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::*;

    /// Insert a free, full-band agent with the given concurrency limit. Runtime
    /// query (not the compile-time macro) so this test-only insert needs no entry
    /// in the offline .sqlx cache.
    async fn insert_free_agent(pool: &SqlitePool, concurrency_limit: i64) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agents (id, name, executor_profile, base_url, max_complexity_tier, min_complexity_tier, availability, concurrency_limit, active_sessions)
             VALUES (?, 'race-agent', 'CLAUDE_CODE', 'http://ollama.local:11434', 'ultra', 'basic', 'free', ?, 0)",
        )
        .bind(id)
        .bind(concurrency_limit)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    fn ctx() -> AssignmentContext {
        AssignmentContext {
            tier: ComplexityTier::Medium,
            sprint_id: None,
            active_sprint_id: None,
            is_unassigned: true,
            is_blocked: false,
        }
    }

    /// Backward-compat path A (user mandate): zero agents ⇒ no engine assignment ⇒
    /// the caller uses its explicit executor config — byte-for-byte upstream.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn no_agents_yields_no_assignment(pool: SqlitePool) {
        assert!(
            claim_assignment(&pool, &ctx()).await.unwrap().is_none(),
            "empty pool must fall through to the caller's executor config"
        );
    }

    /// Backward-compat path B (user mandate): one free capable agent ⇒ the engine
    /// assigns it, atomically claims a slot, and surfaces the endpoint env override.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn free_agent_is_claimed_and_carries_env(pool: SqlitePool) {
        let id = insert_free_agent(&pool, 1).await;

        let assignment = claim_assignment(&pool, &ctx())
            .await
            .unwrap()
            .expect("a free capable agent must be assigned");
        assert_eq!(assignment.agent.id, id);
        let env = assignment
            .env
            .env
            .expect("endpoint env present (agent has base_url)");
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("http://ollama.local:11434")
        );

        // The claim is persisted: the agent now holds one active session.
        let agent = Agent::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(agent.active_sessions, 1, "the slot was atomically claimed");
    }

    /// PRD §5.4 + user mandate: two dispatchers race for a single
    /// `concurrency_limit = 1` agent against a real DB. Exactly one wins the atomic
    /// claim; the loser re-queries, finds no free capacity, and returns `None` —
    /// the agent is never over-claimed.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn two_dispatchers_race_for_one_slot(pool: SqlitePool) {
        let id = insert_free_agent(&pool, 1).await;

        let p1 = pool.clone();
        let p2 = pool.clone();
        let h1 = tokio::spawn(async move { claim_assignment(&p1, &ctx()).await.unwrap() });
        let h2 = tokio::spawn(async move { claim_assignment(&p2, &ctx()).await.unwrap() });
        let r1 = h1.await.unwrap();
        let r2 = h2.await.unwrap();

        let winners = [&r1, &r2].iter().filter(|r| r.is_some()).count();
        assert_eq!(winners, 1, "exactly one dispatcher may win the only slot");

        let winner = r1.or(r2).expect("one dispatcher won");
        assert_eq!(winner.agent.id, id);

        // The DB shows exactly one claimed slot — the loser backed off, no over-claim.
        let agent = Agent::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(agent.active_sessions, 1, "agent was never over-claimed");
    }

    /// M1 #143 END-TO-END: a workspace carrying a tiered issue's tier (as
    /// persisted onto the workspace at create-and-start) resolves a real
    /// assignment context and routes to a capable free agent — proving the engine
    /// actually FIRES from a workspace, not just that the pure predicate works.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn workspace_with_issue_tier_routes_to_capable_agent(pool: SqlitePool) {
        let ws_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO workspaces (id, branch, complexity_tier) VALUES (?, 'ws', 'medium')",
        )
        .bind(ws_id)
        .execute(&pool)
        .await
        .unwrap();
        insert_free_agent(&pool, 1).await; // full-band free agent — covers medium

        let workspace = Workspace::find_by_id(&pool, ws_id).await.unwrap().unwrap();
        let ctx = context_for_workspace(&pool, &workspace)
            .await
            .unwrap()
            .expect("a workspace from a tiered issue must yield an assignment context");
        assert_eq!(ctx.tier, ComplexityTier::Medium);

        let assignment = claim_assignment(&pool, &ctx)
            .await
            .unwrap()
            .expect("engine must route to a capable agent, NOT fall through to ManualOverride");

        // `assignment.agent` is the pre-claim snapshot; the claim increment lands in
        // the DB. Assert against the DB to prove the slot was claimed end-to-end.
        let agent = Agent::find_by_id(&pool, assignment.agent.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            agent.active_sessions, 1,
            "the agent slot was claimed end-to-end"
        );
    }

    /// M1 #143: an ad-hoc workspace (no linked tiered issue) yields no context, so
    /// the engine does not fire — byte-for-byte upstream behavior.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn ad_hoc_workspace_yields_no_context(pool: SqlitePool) {
        let ws_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch) VALUES (?, 'ws')")
            .bind(ws_id)
            .execute(&pool)
            .await
            .unwrap();
        let workspace = Workspace::find_by_id(&pool, ws_id).await.unwrap().unwrap();
        assert!(
            context_for_workspace(&pool, &workspace)
                .await
                .unwrap()
                .is_none()
        );
    }
}
