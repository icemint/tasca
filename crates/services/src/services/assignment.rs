//! M1 #16: the impure half of the assignment engine. The pure decision —
//! "given this routing context and agent pool, which agent (if any)?" — lives in
//! the `assignment-engine` crate ([`decide`]). This module does the DB-touching
//! work around it: resolve a started workspace's routing context, list the agent
//! pool, and atomically claim the selected agent's concurrency slot, re-querying
//! on a lost race (PRD §5.4). It is kept out of `assignment-engine` so that crate
//! stays a pure, side-effect-free leaf.

use assignment_engine::{Assignment, AssignmentContext, AssignmentDecision, decide};
use db::models::{
    agent::Agent,
    sprint::Sprint,
    workspace::{QueuedWorkspace, Workspace},
};
use sqlx::SqlitePool;

/// Pick the next queued workspace a just-freed agent should re-dispatch (M1 #17):
/// the first (oldest — `queued` is FIFO by creation) whose tier the agent's
/// `[min, max]` band covers. Pure over `(agent, queued)` so the FIFO + tier
/// eligibility is unit-testable; the claim/start happen in the caller.
pub fn select_for_dispatch(agent: &Agent, queued: Vec<QueuedWorkspace>) -> Option<QueuedWorkspace> {
    queued.into_iter().find(|w| {
        w.complexity_tier
            .is_some_and(|t| agent.min_complexity_tier <= t && t <= agent.max_complexity_tier)
    })
}

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
    // `remote_project_id` is the REMOTE issue's project id, queried against the
    // LOCAL `sprints` table. Today that table has no sync/insert path, so this
    // always returns `None` (⇒ no sprint filter ⇒ every task in scope), which is
    // correct for now. COHERENCE NOTE for whoever wires sprint sync: populate
    // local `sprints.project_id` with the REMOTE project id to match this read
    // site, or active-sprint scoping will silently never match.
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

/// What the seam should do with a started workspace (M1 #17). Surfaces the
/// `decide()` distinction that matters at the seam: route now, defer-and-queue, or
/// fall through to the caller's config.
pub enum ClaimOutcome {
    /// An agent was selected *and* its slot claimed — start now with the agent's
    /// `executor_config` + `env`; release the slot when the run finalizes. Boxed —
    /// it dwarfs the unit variants.
    Assigned(Box<Assignment>),
    /// Capable agents exist but all are busy — the run is deferred: record it
    /// `queued` and start it on a later agent-release event (FIFO).
    Queue,
    /// No engine routing applies (no pool / already-assigned / outside the active
    /// sprint / no capable agent will ever free, or we lost every claim race).
    /// Start now with the caller's explicit config — byte-for-byte upstream (§5.1).
    Upstream,
}

/// List the agent pool, ask [`decide`], and atomically claim the selected agent —
/// re-querying on a lost race so the loser never over-claims (PRD §5.4). Returns a
/// [`ClaimOutcome`]: only `Queued` (capable-but-busy) defers; `NoCapableAgent`
/// (nothing will ever free to take it) and `Blocked`/`ManualOverride` all fall
/// through to `Upstream` so the run still starts (never a silent no-op, PRD §5.5).
pub async fn claim_assignment(
    pool: &SqlitePool,
    ctx: &AssignmentContext,
) -> Result<ClaimOutcome, sqlx::Error> {
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
                    // `assignment` is already boxed by `decide` — pass it through.
                    return Ok(ClaimOutcome::Assigned(assignment));
                }
                if attempts >= cap {
                    // Lost every race ⇒ all capable agents are now busy ⇒ defer.
                    return Ok(ClaimOutcome::Queue);
                }
            }
            // Capable agents exist but all are busy ⇒ defer-and-queue.
            AssignmentDecision::Queued => return Ok(ClaimOutcome::Queue),
            // Nothing the engine can route now or later ⇒ start with caller config.
            AssignmentDecision::NoCapableAgent
            | AssignmentDecision::Blocked
            | AssignmentDecision::ManualOverride => return Ok(ClaimOutcome::Upstream),
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

    /// Extract the claimed assignment, or `None` for Queue/Upstream.
    fn assigned(outcome: ClaimOutcome) -> Option<Assignment> {
        match outcome {
            ClaimOutcome::Assigned(a) => Some(*a),
            ClaimOutcome::Queue | ClaimOutcome::Upstream => None,
        }
    }

    /// Backward-compat path A (user mandate): zero agents ⇒ no engine assignment ⇒
    /// the caller uses its explicit executor config — byte-for-byte upstream.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn no_agents_yields_no_assignment(pool: SqlitePool) {
        assert!(
            matches!(
                claim_assignment(&pool, &ctx()).await.unwrap(),
                ClaimOutcome::Upstream
            ),
            "empty pool must fall through to the caller's executor config"
        );
    }

    /// Backward-compat path B (user mandate): one free capable agent ⇒ the engine
    /// assigns it, atomically claims a slot, and surfaces the endpoint env override.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn free_agent_is_claimed_and_carries_env(pool: SqlitePool) {
        let id = insert_free_agent(&pool, 1).await;

        let assignment = assigned(claim_assignment(&pool, &ctx()).await.unwrap())
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
        let h1 =
            tokio::spawn(async move { assigned(claim_assignment(&p1, &ctx()).await.unwrap()) });
        let h2 =
            tokio::spawn(async move { assigned(claim_assignment(&p2, &ctx()).await.unwrap()) });
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

        let assignment = assigned(claim_assignment(&pool, &ctx).await.unwrap())
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

    async fn insert_agent_state(
        pool: &SqlitePool,
        availability: &str,
        min: &str,
        max: &str,
        limit: i64,
        active: i64,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agents (id, name, executor_profile, base_url, max_complexity_tier, min_complexity_tier, availability, concurrency_limit, active_sessions)
             VALUES (?, 'a', 'CLAUDE_CODE', 'http://x', ?, ?, ?, ?, ?)",
        )
        .bind(id).bind(max).bind(min).bind(availability).bind(limit).bind(active)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    fn ctx_tier(tier: ComplexityTier) -> AssignmentContext {
        AssignmentContext {
            tier,
            sprint_id: None,
            active_sprint_id: None,
            is_unassigned: true,
            is_blocked: false,
        }
    }

    /// PRD §5.5 at the impure seam: across every tier × availability cell, the
    /// `ClaimOutcome` is an explicit Assigned / Queue / Upstream — never a silent
    /// drop. A free full-band agent ⇒ Assigned; busy/offline/paused (capable but
    /// unavailable) ⇒ Queue (deferred, picked up on release); no agents ⇒ Upstream;
    /// tier above every band (no capable agent) ⇒ Upstream.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn seam_outcome_matrix_never_silently_drops(pool: SqlitePool) {
        let tiers = [
            ComplexityTier::Basic,
            ComplexityTier::Low,
            ComplexityTier::Medium,
            ComplexityTier::Hard,
            ComplexityTier::Ultra,
        ];
        let states = ["free", "busy", "offline", "paused"];
        for tier in tiers {
            for state in states {
                sqlx::query("DELETE FROM agents")
                    .execute(&pool)
                    .await
                    .unwrap();
                insert_agent_state(&pool, state, "basic", "ultra", 1, 0).await;
                let outcome = claim_assignment(&pool, &ctx_tier(tier)).await.unwrap();
                match state {
                    "free" => assert!(
                        matches!(outcome, ClaimOutcome::Assigned(_)),
                        "free full-band agent should take tier {tier:?}"
                    ),
                    _ => assert!(
                        matches!(outcome, ClaimOutcome::Queue),
                        "tier {tier:?} state {state} should defer (Queue)"
                    ),
                }
            }
        }

        // No agents ⇒ Upstream (start with caller config).
        sqlx::query("DELETE FROM agents")
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            claim_assignment(&pool, &ctx_tier(ComplexityTier::Medium))
                .await
                .unwrap(),
            ClaimOutcome::Upstream
        ));

        // A capped-low agent + an ultra task ⇒ no capable agent ⇒ Upstream.
        insert_agent_state(&pool, "free", "basic", "low", 1, 0).await;
        assert!(matches!(
            claim_assignment(&pool, &ctx_tier(ComplexityTier::Ultra))
                .await
                .unwrap(),
            ClaimOutcome::Upstream
        ));
    }

    fn redispatch_agent(min: ComplexityTier, max: ComplexityTier) -> Agent {
        use db::models::agent::Availability;
        Agent {
            id: Uuid::new_v4(),
            org_id: None,
            name: "a".into(),
            executor_profile: "CLAUDE_CODE".into(),
            base_url: None,
            credential_ref: None,
            max_complexity_tier: max,
            min_complexity_tier: min,
            availability: Availability::Free,
            concurrency_limit: 1,
            active_sessions: 0,
            sandbox_profile: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn queued(tier: ComplexityTier) -> QueuedWorkspace {
        QueuedWorkspace {
            id: Uuid::new_v4(),
            complexity_tier: Some(tier),
            dispatch_prompt: Some("p".into()),
            dispatch_executor_config: Some("{}".into()),
        }
    }

    /// M1 #17 re-dispatch selection is FIFO and tier-eligible: the freed agent
    /// takes the oldest queued workspace whose tier its band covers, skipping ones
    /// it can't run.
    #[test]
    fn select_for_dispatch_is_fifo_and_tier_eligible() {
        // A low-capped agent skips an ultra at the head and takes the next low.
        let agent = redispatch_agent(ComplexityTier::Basic, ComplexityTier::Low);
        let ultra = queued(ComplexityTier::Ultra);
        let low = queued(ComplexityTier::Low);
        let low_id = low.id;
        let picked = select_for_dispatch(&agent, vec![ultra, low]).expect("a low is eligible");
        assert_eq!(
            picked.id, low_id,
            "skips the un-runnable ultra, takes the low"
        );

        // FIFO among eligible: oldest (first in the FIFO-ordered input) wins.
        let full = redispatch_agent(ComplexityTier::Basic, ComplexityTier::Ultra);
        let first = queued(ComplexityTier::Medium);
        let first_id = first.id;
        let second = queued(ComplexityTier::Medium);
        assert_eq!(
            select_for_dispatch(&full, vec![first, second]).unwrap().id,
            first_id
        );

        // Nothing eligible ⇒ None (the agent waits for a compatible release).
        let low_agent = redispatch_agent(ComplexityTier::Basic, ComplexityTier::Basic);
        assert!(select_for_dispatch(&low_agent, vec![queued(ComplexityTier::Ultra)]).is_none());
    }
}
