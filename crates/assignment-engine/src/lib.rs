//! Capability-aware assignment engine (PRD §5). A **pure** decision over a task's
//! routing context and the agent pool — no DB side effects. The caller (the
//! `start_workspace` seam, #16) resolves the context from the task/issue state,
//! calls [`decide`], then performs the `Agent::claim`/session writes itself.
//!
//! Every path returns an explicit [`AssignmentDecision`] — never a silent no-op
//! (PRD §5.5).

pub mod validation;

use db::models::{
    agent::{Agent, Availability},
    task::ComplexityTier,
};
use executors::{
    agent_env::resolve_agent_executor, command::CmdOverrides, profile::ExecutorConfig,
};
use uuid::Uuid;

/// The routing context for one task, resolved by the caller from the task/issue
/// state (tier + sprint via the linked issue per the #13 seam decision; assignee
/// and blocked-by from the issue). Kept as inputs so [`decide`] stays pure.
#[derive(Debug, Clone)]
pub struct AssignmentContext {
    /// The task's complexity tier.
    pub tier: ComplexityTier,
    /// The task's sprint, if any.
    pub sprint_id: Option<Uuid>,
    /// The project's active sprint, if any. `None` ⇒ no sprint filter
    /// (backward-compatible: every task is in scope).
    pub active_sprint_id: Option<Uuid>,
    /// Whether the task currently has no assignee (human or agent).
    pub is_unassigned: bool,
    /// Whether the task is blocked by an open `blocking` relationship.
    pub is_blocked: bool,
}

/// The selected agent + how to run it. The caller must atomically
/// [`Agent::claim`] the agent, then start the session with `executor_config` +
/// `env`. `env` carries `ANTHROPIC_BASE_URL`; the caller injects
/// `ANTHROPIC_API_KEY` from the host env (Phase-1 stopgap, #18).
#[derive(Debug)]
pub struct Assignment {
    pub agent: Agent,
    pub executor_config: ExecutorConfig,
    pub env: CmdOverrides,
}

/// The outcome of an assignment decision (PRD §5.1/§5.4). Exhaustive — the caller
/// must handle every variant; there is no silent fall-through.
#[derive(Debug)]
pub enum AssignmentDecision {
    /// A capable, free agent was selected (boxed — it dwarfs the unit variants).
    Assigned(Box<Assignment>),
    /// Capable agents exist but all are busy/at capacity — queue the task `ready`
    /// (FIFO), picked up on an agent-release event (#17).
    Queued,
    /// No agent's `[min, max]` tier band covers the task's tier — flag
    /// `no_capable_agent`; never silently drop (PRD §5.4).
    NoCapableAgent,
    /// The task is blocked by an open blocking relationship — do not dispatch.
    Blocked,
    /// Not eligible for auto-assignment (no agent pool configured, the task is
    /// already assigned, or it is outside the active sprint). The caller falls
    /// through to its explicit `executor_config` — byte-for-byte upstream
    /// behavior (PRD §5.1 backward-compat).
    ManualOverride,
}

/// Whether an agent's tier band contains `tier` (ordinal — `ComplexityTier`
/// derives `Ord` from its ascending variant order).
fn covers_tier(agent: &Agent, tier: ComplexityTier) -> bool {
    agent.min_complexity_tier <= tier && tier <= agent.max_complexity_tier
}

/// Whether an agent can take work right now: free and below its concurrency cap.
fn has_capacity(agent: &Agent) -> bool {
    agent.availability == Availability::Free && agent.active_sessions < agent.concurrency_limit
}

/// Decide how to route a task (PRD §5.1). Pure over `(ctx, agents)`. Selection is
/// least-loaded-first among eligible agents. `claim`/`release` and session writes
/// happen in the caller.
pub fn decide(ctx: &AssignmentContext, agents: &[Agent]) -> AssignmentDecision {
    // No agent pool ⇒ upstream behavior (use the client's explicit config).
    if agents.is_empty() {
        return AssignmentDecision::ManualOverride;
    }
    if ctx.is_blocked {
        return AssignmentDecision::Blocked;
    }
    // Already assigned, or outside the active sprint ⇒ not for auto-dispatch.
    if !ctx.is_unassigned {
        return AssignmentDecision::ManualOverride;
    }
    if let Some(active) = ctx.active_sprint_id
        && ctx.sprint_id != Some(active)
    {
        return AssignmentDecision::ManualOverride;
    }

    // Agents whose tier band covers the task tier.
    let capable: Vec<&Agent> = agents.iter().filter(|a| covers_tier(a, ctx.tier)).collect();
    if capable.is_empty() {
        return AssignmentDecision::NoCapableAgent;
    }

    // Among capable, those that are free + have capacity + a resolvable profile,
    // least-loaded first. (An unresolvable executor_profile makes an agent
    // undispatchable, so it is not eligible.)
    let selected = capable
        .iter()
        .filter(|a| has_capacity(a))
        .filter_map(|a| {
            resolve_agent_executor(&a.executor_profile, a.base_url.as_deref(), None)
                .ok()
                .map(|(config, env)| (*a, config, env))
        })
        .min_by_key(|(a, _, _)| a.active_sessions);

    match selected {
        Some((agent, executor_config, env)) => AssignmentDecision::Assigned(Box::new(Assignment {
            agent: agent.clone(),
            executor_config,
            env,
        })),
        // Capable agents exist but none is free with capacity (and a valid
        // profile) ⇒ queue; picked up on the next agent release.
        None => AssignmentDecision::Queued,
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    /// A free agent with the given tier band, capacity, and availability.
    fn agent(
        min: ComplexityTier,
        max: ComplexityTier,
        availability: Availability,
        active: i64,
        limit: i64,
    ) -> Agent {
        Agent {
            id: Uuid::new_v4(),
            org_id: None,
            name: "test".into(),
            executor_profile: "CLAUDE_CODE".into(),
            base_url: Some("http://ollama.local:11434".into()),
            credential_ref: None,
            max_complexity_tier: max,
            min_complexity_tier: min,
            availability,
            concurrency_limit: limit,
            active_sessions: active,
            sandbox_profile: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn ctx(tier: ComplexityTier) -> AssignmentContext {
        AssignmentContext {
            tier,
            sprint_id: None,
            active_sprint_id: None,
            is_unassigned: true,
            is_blocked: false,
        }
    }

    fn is_assigned(d: &AssignmentDecision) -> bool {
        matches!(d, AssignmentDecision::Assigned(_))
    }

    #[test]
    fn empty_pool_is_manual_override() {
        assert!(matches!(
            decide(&ctx(ComplexityTier::Medium), &[]),
            AssignmentDecision::ManualOverride
        ));
    }

    #[test]
    fn blocked_task_is_blocked() {
        let mut c = ctx(ComplexityTier::Low);
        c.is_blocked = true;
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            0,
            1,
        )];
        assert!(matches!(decide(&c, &agents), AssignmentDecision::Blocked));
    }

    #[test]
    fn already_assigned_falls_through_to_manual() {
        let mut c = ctx(ComplexityTier::Low);
        c.is_unassigned = false;
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            0,
            1,
        )];
        assert!(matches!(
            decide(&c, &agents),
            AssignmentDecision::ManualOverride
        ));
    }

    #[test]
    fn tier_above_every_band_is_no_capable_agent() {
        // Agent caps at `low`; an `ultra` task has no capable agent.
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Low,
            Availability::Free,
            0,
            1,
        )];
        assert!(matches!(
            decide(&ctx(ComplexityTier::Ultra), &agents),
            AssignmentDecision::NoCapableAgent
        ));
    }

    #[test]
    fn capable_but_all_busy_is_queued() {
        // Capable agent, but at capacity (active == limit).
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            1,
            1,
        )];
        assert!(matches!(
            decide(&ctx(ComplexityTier::Medium), &agents),
            AssignmentDecision::Queued
        ));
    }

    #[test]
    fn free_capable_agent_is_assigned_with_base_url_env() {
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            0,
            1,
        )];
        let d = decide(&ctx(ComplexityTier::Medium), &agents);
        let AssignmentDecision::Assigned(a) = d else {
            panic!("expected Assigned, got {d:?}");
        };
        let vars = a.env.env.expect("env present (agent has base_url)");
        assert_eq!(
            vars.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("http://ollama.local:11434")
        );
    }

    /// PRD §5.5: across all 5 tiers × {free,busy,offline,paused}, a started task
    /// either gets a capable agent or an explicit non-assign state — never a
    /// silent no-op. Here a single full-band agent covers every tier; only the
    /// `free` state (with capacity) yields Assigned.
    #[test]
    fn tier_x_availability_matrix_never_silently_drops() {
        let tiers = [
            ComplexityTier::Basic,
            ComplexityTier::Low,
            ComplexityTier::Medium,
            ComplexityTier::Hard,
            ComplexityTier::Ultra,
        ];
        let states = [
            Availability::Free,
            Availability::Busy,
            Availability::Offline,
            Availability::Paused,
        ];
        for tier in tiers {
            for state in states {
                let agents = [agent(
                    ComplexityTier::Basic,
                    ComplexityTier::Ultra,
                    state,
                    0,
                    1,
                )];
                let d = decide(&ctx(tier), &agents);
                match state {
                    Availability::Free => assert!(
                        is_assigned(&d),
                        "free full-band agent should take tier {tier:?}, got {d:?}"
                    ),
                    // Not free ⇒ no capacity ⇒ capable-but-unavailable ⇒ Queued.
                    _ => assert!(
                        matches!(d, AssignmentDecision::Queued),
                        "tier {tier:?} state {state:?} should queue, got {d:?}"
                    ),
                }
            }
        }
    }

    #[test]
    fn task_outside_active_sprint_is_skipped() {
        let active = Uuid::new_v4();
        let mut c = ctx(ComplexityTier::Low);
        c.active_sprint_id = Some(active);
        c.sprint_id = Some(Uuid::new_v4()); // a different sprint
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            0,
            1,
        )];
        assert!(matches!(
            decide(&c, &agents),
            AssignmentDecision::ManualOverride
        ));
    }

    #[test]
    fn task_in_active_sprint_is_assigned() {
        let active = Uuid::new_v4();
        let mut c = ctx(ComplexityTier::Low);
        c.active_sprint_id = Some(active);
        c.sprint_id = Some(active); // same sprint
        let agents = [agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            0,
            1,
        )];
        assert!(is_assigned(&decide(&c, &agents)));
    }

    #[test]
    fn least_loaded_eligible_agent_is_preferred() {
        let busy = agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            2,
            5,
        );
        let idle = agent(
            ComplexityTier::Basic,
            ComplexityTier::Ultra,
            Availability::Free,
            0,
            5,
        );
        let idle_id = idle.id;
        let agents = [busy, idle];
        let AssignmentDecision::Assigned(a) = decide(&ctx(ComplexityTier::Medium), &agents) else {
            panic!("expected Assigned");
        };
        assert_eq!(a.agent.id, idle_id, "should pick the least-loaded agent");
    }
}
