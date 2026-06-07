// The orchestration loop — the heart of @tasca/coordination (scaffold §6).
//
// Given an AdapterEvent{task.assigned}, run the forward path against injected
// ports/services, realizing the §6 step→package mapping:
//
//   ingest + persist task (routable, v0)        [store]                 §6.4
//     → estimateTier (heuristics + classifier)  [@tasca/routing]        §6.5
//     → persist routing decision                [store]                 §6.5
//     → matchCapability over eligible agents    [@tasca/routing]        §6.6
//     → canDispatch concurrency gate            [@tasca/routing]        §6.7
//     → atomicClaim (CAS)                        [@tasca/routing + db]   §6.8
//     → on win: dispatch reserveWorktree+spawn  [@tasca/execution]      §6.9-10
//     → openPr                                   [@tasca/execution]      §6.11
//     → status-back                              [StatusReporter port]   §6.12
//     → persist pull_request + audit_event       [store + identity]      §6.11-13
//   On execution failure: failure_count++ → breaker(n) → at N → needs_attention §6.14
//
// Everything I/O is a port; this module is pure composition. Tests inject fakes;
// the composition root (createCoordination) injects the real Postgres/exec impls.

import {
  estimateTier,
  matchCapability,
  canDispatch,
  atomicClaim,
  breaker,
  type MatchCandidate,
  type TaskInput,
  type ClaimPort,
  type LlmClassifierPort,
} from '@tasca/routing';
import type { AdapterEvent } from '@tasca/contracts';
import type { Task, TaskStatus } from '@tasca/domain';
import type { ExecutionPort } from '@tasca/execution';
import type { CoordinationStore } from './store';
import type { StatusReporter, Logger } from './ports';

/**
 * Supplies the routing candidates (capability profile + live state + active
 * count) for an event. The composition root implements this over
 * @tasca/identity (profiles) + the store (active counts); tests fake it.
 */
export interface AgentDirectory {
  /** Eligible agents for a task, as routing MatchCandidates. */
  listCandidates(task: Task): Promise<MatchCandidate[]>;
  /** The agent's stable audit principal id (for audit_event attribution). */
  principalIdFor(agentId: string): Promise<string | null>;
}

/** Append-only audit seam (the @tasca/identity audit trail). */
export interface AuditSink {
  record(input: {
    principalId: string;
    agentId: string;
    action: string;
    target?: string;
    platform?: 'shortcut' | 'github' | 'linear';
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

/** Resolves the task's title/body/labels for tier estimation from the event. */
export interface TaskContentSource {
  fetch(event: AdapterEvent): Promise<TaskInput>;
}

export interface OrchestrationDeps {
  store: CoordinationStore;
  claim: ClaimPort;
  execution: ExecutionPort;
  status: StatusReporter;
  directory: AgentDirectory;
  audit: AuditSink;
  content: TaskContentSource;
  classifier?: LlmClassifierPort;
  /** Breaker threshold; defaults to 2 (scaffold §3.2). */
  breakerThreshold?: number;
  /** Per-project concurrency limit for the dispatch gate. */
  perProjectLimit?: number;
  /** Structured logger; used to surface best-effort finalize failures (never throws). */
  logger?: Logger;
}

export type OrchestrationOutcome =
  | { kind: 'dispatched'; taskId: string; agentId: string; prUrl: string }
  | { kind: 'lost_claim'; taskId: string; agentId: string }
  | { kind: 'no_candidate'; taskId: string }
  | { kind: 'not_routable'; taskId: string; status: TaskStatus }
  | { kind: 'needs_attention'; taskId: string; failureCount: number }
  | { kind: 'failed'; taskId: string; failureCount: number };

/**
 * Run the forward path for one task.assigned event. Returns a structured
 * outcome so the caller (HTTP entry / tests) can assert on what happened.
 */
export async function orchestrateTaskAssigned(
  event: AdapterEvent,
  deps: OrchestrationDeps
): Promise<OrchestrationOutcome> {
  const breakerThreshold = deps.breakerThreshold ?? 2;
  const perProjectLimit = deps.perProjectLimit ?? 1;

  // §6.4 — ingest: get-or-create the task for this story (routable, v0 on first
  // delivery; the existing row on re-delivery / re-assignment). Re-driving the
  // same row is what lets failure_count accumulate toward the breaker (§6.14).
  const repoRef = event.repoHint ?? null;
  const task = await deps.store.getOrCreateTask({
    externalStoryId: event.externalStoryId,
    platform: event.platform,
    repoRef,
  });

  // Only a `routable` task is drivable. A re-delivery of a story that is already
  // in-flight (claimed/executing/in_review), resolved (done), or escalated
  // (needs_attention) must NOT be re-driven — return its current state before
  // doing any tier estimation or writing a spurious routing_decision. Auto-recover
  // re-drives go through `resetForRetry`, which puts the task back to `routable`.
  if (task.status !== 'routable') {
    return { kind: 'not_routable', taskId: task.id, status: task.status };
  }

  // The whole forward path is guarded so a failure of ANY phase — routing/content
  // (pre-claim) as well as execution (post-claim) — feeds the breaker (§6.14).
  // Without this, a persistent pre-claim failure (e.g. a broken content source or
  // a throwing classifier) would strand the task at `routable` forever, never
  // counted and never escalated. `no_candidate`/`lost_claim` are normal outcomes,
  // not errors, so they `return` and bypass the catch.
  let winnerAgentId: string | null = null;
  let principalId: string | null = null;
  try {
    // §6.5 — estimate tier (heuristics + one budgeted/cached classifier call),
    // then persist it (inspectable).
    const content = await deps.content.fetch(event);
    const estimate = await estimateTier(
      content,
      deps.classifier ? { classifier: deps.classifier } : {}
    );
    await deps.store.setTierEstimate(task.id, estimate);

    // §6.6 — match capability over eligible agents.
    const taskForMatch: Task = { ...task, tierEstimate: estimate };
    const candidates = await deps.directory.listCandidates(taskForMatch);
    const ranked = matchCapability(estimate, candidates);
    const winner = ranked.find((m) => m.eligible) ?? null;

    await deps.store.recordRoutingDecision({
      taskId: task.id,
      tierEstimate: estimate,
      candidates: ranked,
      winnerAgentId: winner?.agentId ?? null,
    });

    if (!winner) {
      return { kind: 'no_candidate', taskId: task.id };
    }

    const winningCandidate = candidates.find((c) => c.profile.agentId === winner.agentId)!;

    // §6.7 — concurrency + same-repo gate (advisory pre-claim early-out).
    const gate = canDispatch(
      winningCandidate.profile,
      {
        perAgentActive: winningCandidate.activeCount,
        perProjectActive: winningCandidate.activeCount,
        repoBusy: false,
      },
      { perProjectLimit }
    );
    if (!gate.ok) {
      return { kind: 'no_candidate', taskId: task.id };
    }

    // §6.8 — atomic claim (CAS). The conditional write is the hard exactly-one
    // guarantee; on loss another worker already owns the task.
    const claim = await atomicClaim(deps.claim, task.id, winner.agentId, task.version);
    if (!claim.won) {
      return { kind: 'lost_claim', taskId: task.id, agentId: winner.agentId };
    }

    // Past the claim: this worker owns the task — record who, for failure audit.
    winnerAgentId = winner.agentId;
    principalId = await deps.directory.principalIdFor(winner.agentId);
    await audit(deps, principalId, winner.agentId, event, {
      action: 'task.claim',
      target: task.id,
      payload: { tier: estimate.tier },
    });

    // Idempotency guard: a prior attempt may have opened + recorded a PR, then
    // failed a later (finalize) step before the loop returned, leaving the task
    // re-drivable. Re-running the agent + opening a SECOND PR on a real customer
    // repo is the worst outcome — so if a PR is already recorded, skip dispatch
    // entirely and re-finalize (best-effort) against the existing PR.
    const existingPrs = await deps.store.listPullRequestsForTask(task.id);
    if (existingPrs.length > 0) {
      const prUrl = existingPrs[0]!.url;
      await finalizeDispatch(deps, task.id, event, winner.agentId, principalId, prUrl);
      return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl };
    }

    // §6.9-13 — dispatch → worktree + agent → PR → status-back.
    await deps.store.setStatus(task.id, 'executing');

    const worktree = await deps.execution.reserveWorktree({
      repoPath: repoRef ?? '.',
      taskLabel: event.externalStoryId,
      projectId: event.externalStoryId,
    });

    // §6.10 — spawn the agent over a PTY; await its exit before opening the PR.
    await runAgentToCompletion(deps.execution, {
      id: task.id,
      command: 'claude',
      cwd: worktree.path,
    });

    // §6.11 — open the PR, then record it. recordPullRequest is the durable proof
    // the deliverable exists; everything after it is best-effort finalize that must
    // NOT throw (a throw here would drive resetForRetry → re-drive → duplicate PR).
    const pr = await deps.execution.openPr({
      cwd: worktree.path,
      branch: worktree.branch,
      title: `Tasca: ${event.externalStoryId}`,
    });
    await deps.store.recordPullRequest({ taskId: task.id, url: pr.url });

    // §6.12 — finalize (audit + status-back + in_review): best-effort, never throws.
    await finalizeDispatch(deps, task.id, event, winner.agentId, principalId, pr.url);

    return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: pr.url };
  } catch (err) {
    // §6.14 — failure path (any phase): counter++ → breaker(n). At/over the
    // threshold the task trips to needs_attention (human-gated). Below it, the
    // task is RESET to routable (claim cleared, version bumped) so a re-delivery /
    // re-assignment re-claims the SAME row and the next failure increments the
    // same counter — the breaker trips because the row is re-driven, not replaced.
    const failureCount = await deps.store.incrementFailureCount(task.id);
    const outcome = breaker(failureCount, breakerThreshold);

    if (outcome === 'needs_attention') {
      await deps.store.setStatus(task.id, 'needs_attention');
    } else {
      await deps.store.resetForRetry(task.id);
    }

    // Best-effort audit: a pre-claim failure has no claimed agent/principal, so
    // `audit` is skipped (principalId null); a post-claim failure attributes to
    // the owning agent. The server boundary logs every failure regardless.
    await audit(deps, principalId, winnerAgentId ?? '(unassigned)', event, {
      action: 'task.failed',
      target: task.id,
      payload: {
        failureCount,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      },
    });

    if (outcome === 'needs_attention') {
      return { kind: 'needs_attention', taskId: task.id, failureCount };
    }
    return { kind: 'failed', taskId: task.id, failureCount };
  }
}

/**
 * Spawn the agent over the PTY and resolve when it exits cleanly; reject on a
 * non-zero exit or a transport error. This is what turns the streaming
 * ExecutionPort.spawnAgent into an awaitable run step.
 */
function runAgentToCompletion(
  execution: ExecutionPort,
  input: { id: string; command: string; cwd: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = execution.spawnAgent(input);
    handle.onError((err) => reject(err));
    handle.onExit((code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent exited with code ${code}`));
    });
  });
}

/**
 * Finalize a dispatched task: status-back, mark in_review, and audit — all AFTER
 * the PR is recorded. Every step is best-effort and CANNOT throw: the PR is the
 * deliverable, and propagating a finalize failure would drive resetForRetry →
 * re-drive → a second agent run and a duplicate PR. A failed step is logged; a
 * left-behind status (e.g. still 'executing') is cosmetic and reconciles on a
 * later delivery, never a duplicated customer PR.
 */
async function finalizeDispatch(
  deps: OrchestrationDeps,
  taskId: string,
  event: AdapterEvent,
  agentId: string,
  principalId: string | null,
  prUrl: string
): Promise<void> {
  const safe = async (step: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      deps.logger?.error('finalize step failed (best-effort; PR already open)', {
        taskId,
        step,
        prUrl,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await safe('audit.pr.create', () =>
    audit(deps, principalId, agentId, event, { action: 'pr.create', target: taskId, payload: { url: prUrl } })
  );
  await safe('status.post', () =>
    deps.status.postStatus({
      platform: event.platform,
      externalStoryId: event.externalStoryId,
      agentId,
      state: 'in_review',
      comment: 'PR opened',
      prUrl,
    })
  );
  await safe('set.in_review', () => deps.store.setStatus(taskId, 'in_review'));
  await safe('audit.status.post', () =>
    audit(deps, principalId, agentId, event, {
      action: 'status.post',
      target: taskId,
      payload: { state: 'in_review', prUrl },
    })
  );
}

/** Best-effort audit append — skipped (not failed) when no principal resolves. */
async function audit(
  deps: OrchestrationDeps,
  principalId: string | null,
  agentId: string,
  event: AdapterEvent,
  entry: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!principalId) return;
  await deps.audit.record({
    principalId,
    agentId,
    platform: event.platform,
    ...entry,
  });
}
