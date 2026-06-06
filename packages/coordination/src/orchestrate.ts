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
import type { Task } from '@tasca/domain';
import type { ExecutionPort } from '@tasca/execution';
import type { CoordinationStore } from './store';
import type { StatusReporter } from './ports';

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
}

export type OrchestrationOutcome =
  | { kind: 'dispatched'; taskId: string; agentId: string; prUrl: string }
  | { kind: 'lost_claim'; taskId: string; agentId: string }
  | { kind: 'no_candidate'; taskId: string }
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

  // §6.4 — ingest + persist as a task (routable, version 0).
  const repoRef = event.repoHint ?? null;
  const task = await deps.store.createTask({
    externalStoryId: event.externalStoryId,
    platform: event.platform,
    repoRef,
  });

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

  const principalId = await deps.directory.principalIdFor(winner.agentId);
  await audit(deps, principalId, winner.agentId, event, {
    action: 'task.claim',
    target: task.id,
    payload: { tier: estimate.tier },
  });

  // §6.9-13 — dispatch → worktree + agent → PR → status-back. A failure anywhere
  // in here feeds the breaker (§6.14).
  try {
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

    // §6.11 — open the PR.
    const pr = await deps.execution.openPr({
      cwd: worktree.path,
      branch: worktree.branch,
      title: `Tasca: ${event.externalStoryId}`,
    });
    await deps.store.recordPullRequest({ taskId: task.id, url: pr.url });
    await audit(deps, principalId, winner.agentId, event, {
      action: 'pr.create',
      target: task.id,
      payload: { url: pr.url },
    });

    // §6.12 — status-back as the agent: comment + state → in_review + PR link.
    await deps.status.postStatus({
      externalStoryId: event.externalStoryId,
      agentId: winner.agentId,
      state: 'in_review',
      comment: 'PR opened',
      prUrl: pr.url,
    });
    await deps.store.setStatus(task.id, 'in_review');
    await audit(deps, principalId, winner.agentId, event, {
      action: 'status.post',
      target: task.id,
      payload: { state: 'in_review', prUrl: pr.url },
    });

    return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: pr.url };
  } catch (err) {
    // §6.14 — failure path: counter++ → breaker(n) → at N → needs_attention.
    await deps.store.setStatus(task.id, 'failed');
    const failureCount = await deps.store.incrementFailureCount(task.id);
    await audit(deps, principalId, winner.agentId, event, {
      action: 'task.failed',
      target: task.id,
      payload: { failureCount, error: err instanceof Error ? err.message : String(err) },
    });

    if (breaker(failureCount, breakerThreshold) === 'needs_attention') {
      await deps.store.setStatus(task.id, 'needs_attention');
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
