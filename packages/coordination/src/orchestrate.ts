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

import { createHash } from 'node:crypto';
import {
  estimateTier,
  matchCapability,
  canDispatch,
  atomicClaim,
  type MatchCandidate,
  type TaskInput,
  type ClaimPort,
  type LlmClassifierPort,
} from '@tasca/routing';
import type { AdapterEvent } from '@tasca/contracts';
import type { Task, TaskStatus } from '@tasca/domain';
import { ExecutionError, type ExecutionPort } from '@tasca/execution';
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

/** A provisioned local checkout: the filesystem path + the repo's default branch. */
export interface ProvisionedRepo {
  /** Local clone path, for reserveWorktree's repoPath. */
  path: string;
  /** The clone's default branch (e.g. `main`) — passed as the worktree base ref so
   *  reserveWorktree branches off `origin/<defaultBranch>` instead of looking up
   *  per-project settings the headless flow never created. */
  defaultBranch: string;
}

/**
 * Ensures a local checkout of a repo (identified by an `owner/repo` ref) exists
 * with an authenticated `origin`, returning its path + default branch so
 * reserveWorktree can take a worktree from it. Throws on failure (no installation,
 * clone error) — the forward-path catch treats that like any dispatch failure.
 */
export interface RepoProvisioner {
  ensureLocalRepo(repoRef: string): Promise<ProvisionedRepo>;
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
  /** Resolves a GitHub `owner/repo` slug to a local clone path before dispatch.
   *  Absent → repoRef is used as-is (Stage-1 single-checkout / test behavior). */
  provisioner?: RepoProvisioner;
  /** Breaker threshold; defaults to 2 (scaffold §3.2). */
  breakerThreshold?: number;
  /** Per-project concurrency limit for the dispatch gate. */
  perProjectLimit?: number;
  /** Max wall-clock for one agent run before it's killed + the task fails; default 600000ms. */
  agentTimeoutMs?: number;
  /** Structured logger; used to surface best-effort finalize failures (never throws). */
  logger?: Logger;
}

/** Default agent-run timeout (10 min) — a hung agent is killed so the breaker fires. */
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
/** Above this prompt length the issue body is capped (see buildClaudeCommand); we log it. */
const PROMPT_TRUNCATE_THRESHOLD = 60_000;

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
  const agentTimeoutMs = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

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
  // re-drives go through the failure path, which resets the task to `routable`.
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
      // Surface WHY the CAS missed (lost race vs stale version vs gone) for ops.
      deps.logger?.info?.('coordination: claim lost', {
        taskId: task.id,
        agentId: winner.agentId,
        found: claim.found,
        currentStatus: claim.currentStatus ?? null,
        currentVersion: claim.currentVersion ?? null,
      });
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
      // The row was just re-claimed (claimed). Mirror the normal path's
      // claimed→executing move before finalizing — finalize advances
      // executing→in_review, and the write-path guard rejects claimed→in_review,
      // which would otherwise (silently, via finalize's best-effort wrapper) strand
      // the task in `claimed` with an open PR.
      await deps.store.setStatus(task.id, 'executing');
      await finalizeDispatch(deps, task.id, event, winner.agentId, principalId, prUrl);
      return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl };
    }

    // §6.9-13 — dispatch → worktree + agent → PR → status-back.
    await deps.store.setStatus(task.id, 'executing');

    // Provision a local checkout for the worktree. A GitHub event's repoHint is an
    // `owner/repo` slug, not a local path; the provisioner clones/fetches it (auth'd)
    // and returns the path + default branch. We pass `origin/<defaultBranch>` as the
    // worktree base ref so reserveWorktree branches off the freshly-fetched remote
    // default — NOT via Emdash's per-project settings lookup, which the headless
    // clone-on-dispatch flow never populates ("Project settings not found").
    // No provisioner (or no repoRef) → use repoRef as-is, no base ref override.
    let repoPath = '.';
    let baseRef: string | undefined;
    if (repoRef) {
      if (deps.provisioner) {
        const provisioned = await deps.provisioner.ensureLocalRepo(repoRef);
        repoPath = provisioned.path;
        baseRef = `origin/${provisioned.defaultBranch}`;
      } else {
        repoPath = repoRef;
      }
    }
    const worktree = await deps.execution.reserveWorktree({
      repoPath,
      taskLabel: event.externalStoryId,
      projectId: event.externalStoryId,
      ...(baseRef ? { baseRef } : {}),
    });

    // §6.10 — spawn the agent over a PTY; await its exit before opening the PR.
    // The prompt is the REAL story content fetched above (content.fetch), so the
    // agent has the actual task — not just the id. The body is attacker-controlled;
    // it reaches the shell only through the POSIX-quoted claude command the factory
    // builds from `prompt`.
    const prompt =
      'You are an autonomous software engineer working in a fresh checkout of this repository. ' +
      'Implement the task below: make the necessary code changes and commit them with a clear message. ' +
      'Make only the changes the task requires.\n\n' +
      `Task: ${content.title}\n\n${content.body}`;
    // buildClaudeCommand caps the prompt to fit the OS arg limit; surface it so an
    // operator knows a long issue's tail (often the acceptance criteria) was cut.
    if (prompt.length > PROMPT_TRUNCATE_THRESHOLD) {
      deps.logger?.info?.('coordination: agent prompt truncated to fit', {
        taskId: task.id,
        promptChars: prompt.length,
        capChars: PROMPT_TRUNCATE_THRESHOLD,
      });
    }
    await runAgentToCompletion(
      deps.execution,
      { id: task.id, cwd: worktree.path, prompt },
      agentTimeoutMs
    );

    // Verify a real change landed BEFORE opening a PR — never open an empty PR.
    // Stage + commit whatever the agent left, then check the worktree HEAD is
    // ahead of the base. `baseRef` is only set on the provisioner path; on the
    // no-provisioner path it's undefined, so pass '' (commitAgentWork then bases
    // `changed` on whether this call committed, not a rev-list count).
    const work = await deps.execution.commitAgentWork({
      cwd: worktree.path,
      message: `Tasca: ${event.externalStoryId}`,
      baseRef: baseRef ?? '',
    });
    if (!work.changed) {
      throw new ExecutionError(
        'no-changes',
        `agent run produced no committed changes for ${event.externalStoryId}`
      );
    }

    // §6.11 — open the PR, then record it. recordPullRequest is the durable proof
    // the deliverable exists; everything after it is best-effort finalize that must
    // NOT throw (a throw here would drive the failure reset → re-drive → duplicate PR).
    //
    // The PR head is a DETERMINISTIC branch derived from the story, NOT the
    // worktree's local branch (which carries a random per-attempt suffix). So if a
    // re-drive ever reaches openPr again (e.g. recordPullRequest failed to commit
    // before the row landed), it pushes to the SAME head and `gh pr create` returns
    // the existing PR instead of opening a second one on the customer repo.
    const pr = await deps.execution.openPr({
      cwd: worktree.path,
      branch: worktree.branch,
      headBranch: deterministicHeadBranch(event.externalStoryId),
      title: `Tasca: ${event.externalStoryId}`,
    });
    await deps.store.recordPullRequest({ taskId: task.id, url: pr.url });

    // §6.12 — finalize (audit + status-back + in_review): best-effort, never throws.
    await finalizeDispatch(deps, task.id, event, winner.agentId, principalId, pr.url);

    return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: pr.url };
  } catch (err) {
    // §6.14 — failure path (any phase): record the failure and transition in ONE
    // atomic UPDATE. At/over the threshold the task trips to needs_attention
    // (human-gated); below it the SAME row is reset to routable (claim cleared,
    // version bumped) so a re-delivery / re-assignment re-claims it and the next
    // failure increments the same counter — the breaker trips because the row is
    // re-driven, not replaced. Folding the increment + transition into one write
    // removes the crash window that could strand the task between them.
    const { failureCount, tripped } = await deps.store.recordFailureAndTransition(
      task.id,
      breakerThreshold
    );
    const outcome = tripped ? 'needs_attention' : 'retry';

    // Surface WHY at the boundary (stdout), not only in the audit row: the error
    // message carries the failing stage (provisioner / reserveWorktree / spawn /
    // openPr), and an ExecutionError adds a typed `stage`. Without this a "failed"
    // outcome is undiagnosable from logs.
    deps.logger?.error('coordination: dispatch failed', {
      taskId: task.id,
      agentId: winnerAgentId ?? null,
      failureCount,
      outcome,
      stage: err instanceof ExecutionError ? err.kind : undefined,
      error: err instanceof Error ? err.message : String(err),
    });

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

    if (tripped) {
      return { kind: 'needs_attention', taskId: task.id, failureCount };
    }
    return { kind: 'failed', taskId: task.id, failureCount };
  }
}

/**
 * A stable PR head branch for a story, identical across re-drives so a repeated
 * `openPr` reuses (and is recognized against) the same head — and INJECTIVE so two
 * different stories never collide onto one head (a collision would make story B
 * adopt story A's PR and get none of its own). The readable slug is for humans;
 * the appended short hash of the RAW id guarantees uniqueness even when the slug
 * is lossy (the GitHub id `owner/repo#number` sanitizes to a legal ref, but
 * `owner/repo#42` and `owner-repo#42` would otherwise both slug to the same thing).
 * Starts with a letter so it satisfies the open-pr SAFE_REF guard.
 */
function deterministicHeadBranch(externalStoryId: string): string {
  const slug = externalStoryId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  const hash = createHash('sha256').update(externalStoryId).digest('hex').slice(0, 8);
  return `tasca/${slug || 'task'}-${hash}`;
}

/**
 * Spawn the agent over the PTY and resolve when it exits cleanly; reject on a
 * non-zero exit or a real transport error. This is what turns the streaming
 * ExecutionPort.spawnAgent into an awaitable run step.
 *
 * EIO/EPIPE on the PTY master fd during child teardown is a benign Linux race
 * (the slave closes before the final read settles); treat it as success and rely
 * on the on-disk commit (verified by commitAgentWork) as the source of truth.
 * Any other onError is a real failure.
 */
function runAgentToCompletion(
  execution: ExecutionPort,
  input: { id: string; cwd: string; prompt: string },
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = execution.spawnAgent(input);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // A hung agent (never exits, never errors) would otherwise leave the task in
    // `executing` forever — the breaker only fires on a throw — and leak the PTY +
    // worktree + concurrency slot. Kill it and fail so the catch records it.
    const timer = setTimeout(() => {
      finish(() => {
        try {
          execution.killAgent(input.id);
        } catch {
          // best-effort reap; we're failing the run regardless
        }
        reject(new ExecutionError('spawn', `agent run timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    handle.onError((err) => {
      const code = (err as { code?: string }).code;
      // EIO/EPIPE on the PTY master during child teardown is a benign Linux race;
      // treat it as success and let commitAgentWork be the source of truth.
      if (code === 'EIO' || code === 'EPIPE') finish(resolve);
      else finish(() => reject(err));
    });
    handle.onExit((code) => {
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(`agent exited with code ${code}`)));
    });
  });
}

/**
 * Finalize a dispatched task: status-back, mark in_review, and audit — all AFTER
 * the PR is recorded. Every step is best-effort and CANNOT throw: the PR is the
 * deliverable, and propagating a finalize failure would drive the failure reset →
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
