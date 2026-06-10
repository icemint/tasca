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
import type { DispatchQueue } from '@tasca/db';
import { ExecutionError, type ExecutionPort } from '@tasca/execution';
import type { CoordinationStore } from './store';
import type { StatusReporter, Logger } from './ports';
import { DEFAULT_ORG_ID } from './resolve-org';

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

/** The narrow slice of OrchestrationDeps the finalize seam needs — also what the reaper
 *  (which finalizes a runner-completed job out of band) supplies. */
export interface FinalizeDeps {
  store: CoordinationStore;
  status: StatusReporter;
  audit: AuditSink;
  logger?: Logger;
}

/** The event fields finalize/audit actually read — so a caller (e.g. the reaper) that
 *  only has the dispatch payload can finalize without fabricating a whole AdapterEvent. */
export interface FinalizeEvent {
  platform: AdapterEvent['platform'];
  externalStoryId: string;
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
  /**
   * Create an isolated worktree for one task off the provisioned local clone,
   * returning its path + branch + base ref. The provisioner owns worktree creation
   * (rather than ExecutionPort.reserveWorktree) because the clone's origin is
   * tokenless — the vendored worktree path would `git fetch origin` + push, which a
   * tokenless origin can't authenticate. Branches off `origin/<defaultBranch>`.
   */
  createWorktree(
    repoRef: string,
    taskLabel: string
  ): Promise<{ path: string; branch: string; baseRef: string }>;
  /** A current installation token for the repo's owner — used to auth `gh pr create`
   *  AND the env-auth'd `git push` in open-pr (the tokenless origin can't auth it). */
  tokenForRepo(repoRef: string): Promise<string>;
  /**
   * Reclaim a worktree created by createWorktree: remove the worktree dir + its
   * branch + prune stale admin entries. Best-effort (never throws) — called once a
   * dispatch terminates (success OR failure) so re-drives don't accumulate worktrees
   * and branches without bound under the worker's repos dir.
   */
  removeWorktree(repoRef: string, worktreePath: string, branch: string): Promise<void>;
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
  /**
   * The dispatch queue (the coordination→execution split). When wired, a dispatch is
   * ENQUEUED for an agent-runner; coordination waits (polling) for a runner to claim it.
   * If none claims within `runnerWaitMs`, the task is retired to `needs_attention` with a
   * "no execution capacity" reason — NEVER run in-process (the hardened boundary holds).
   * Absent → no queue: the agent runs in-process (Stage-1 single-process / test mode).
   */
  dispatchQueue?: DispatchQueue;
  /** How long to wait (polling) for a runner to claim before retiring the task to
   *  needs_attention. Default 30000ms — long enough to absorb a runner redeploy, short
   *  enough that a real outage escalates visibly. Override via TASCA_RUNNER_WAIT_MS. */
  runnerWaitMs?: number;
  /** Poll interval while waiting for a runner claim. Default 500ms. */
  runnerPollMs?: number;
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
/** Default window to wait (polling) for an agent-runner to claim an enqueued job before
 *  the task is retired to needs_attention. 30s absorbs a routine runner redeploy (cached
 *  image + Node boot + first claim poll, ~10–25s) while escalating a real outage fast. */
const DEFAULT_RUNNER_WAIT_MS = 30_000;
/** Default poll interval while waiting for a runner to claim. */
const DEFAULT_RUNNER_POLL_MS = 500;

/** What coordination enqueues for an agent-runner — everything the runner needs to
 *  execute the task. Mirrors @tasca/agent-runner's DispatchPayload (jsonb on the wire). */
export interface DispatchPayload {
  taskId: string;
  repoRef: string;
  platform: AdapterEvent['platform'];
  externalStoryId: string;
  agentId: string;
  prompt: string;
  headBranch: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Build the agent's prompt from the real story content. Shared by the enqueued
 *  payload and the in-process path so a runner and the fallback run the SAME task. */
function buildAgentPrompt(content: { title: string; body: string }): string {
  return (
    'You are an autonomous software engineer working in a fresh checkout of this repository. ' +
    'Implement the task below: make the necessary code changes and commit them with a clear message. ' +
    'Make only the changes the task requires.\n\n' +
    `Task: ${content.title}\n\n${content.body}`
  );
}

export type OrchestrationOutcome =
  | { kind: 'dispatched'; taskId: string; agentId: string; prUrl: string }
  | { kind: 'lost_claim'; taskId: string; agentId: string }
  | { kind: 'no_candidate'; taskId: string }
  | { kind: 'not_routable'; taskId: string; status: TaskStatus }
  | { kind: 'needs_attention'; taskId: string; failureCount: number }
  | { kind: 'failed'; taskId: string; failureCount: number }
  // No agent-runner claimed the enqueued job within the wait bound → retired to
  // needs_attention with a "no execution capacity" reason (the breaker is untouched).
  | { kind: 'no_capacity'; taskId: string; agentId: string }
  // An operator cancel/reassign took the job mid-wait (the job is `cancelled`); the
  // canceller owns the task's post-cancel state, so orchestration just bows out.
  | { kind: 'preempted'; taskId: string; agentId: string };

/**
 * The workspace an event belongs to (for resolving its org via a platform_connection).
 * GitHub: the account/owner login (the `owner` of `owner/repo` — from repoHint, else the
 * `owner/repo#n` story id). Shortcut/Linear carry no workspace in the event yet (their
 * connection mapping arrives with onboarding, slice 5), so they resolve to null → the
 * webhook edge uses the default org. Exported so the server's ledger edge derives the same
 * workspace as the orchestration path, keeping a delivery's ledger + tasks on one org.
 */
export function workspaceForEvent(
  event: Pick<AdapterEvent, 'platform' | 'externalStoryId' | 'repoHint'>
): string | null {
  if (event.platform !== 'github') return null;
  const fromHint = event.repoHint?.split('/')[0];
  if (fromHint) return fromHint;
  const m = /^([^/#]+)\//.exec(event.externalStoryId);
  return m ? m[1]! : null;
}

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

  // Resolve the org this event acts in (the webhook EDGE): the workspace's connection
  // owns an org; an unconnected workspace falls to the default org (single-org until
  // onboarding, slice 5). This is the ONLY default-org materialization on this path —
  // the store has no fallback, so every store call below carries an explicit org.
  const orgId =
    (await deps.store.getOrgForConnection(event.platform, workspaceForEvent(event) ?? '')) ??
    DEFAULT_ORG_ID;

  // §6.4 — ingest: get-or-create the task for this story (routable, v0 on first
  // delivery; the existing row on re-delivery / re-assignment). Re-driving the
  // same row is what lets failure_count accumulate toward the breaker (§6.14).
  const repoRef = event.repoHint ?? null;
  const task = await deps.store.getOrCreateTask(orgId, {
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
  // Set only on the provisioner path, so the finally can reclaim the worktree +
  // branch the provisioner created once the dispatch terminates (success OR failure)
  // — without it, every dispatch and every re-drive leaks a worktree under reposDir.
  let provisionedWorktree: { path: string; branch: string } | undefined;
  try {
    // §6.5 — estimate tier (heuristics + one budgeted/cached classifier call),
    // then persist it (inspectable).
    const content = await deps.content.fetch(event);
    const estimate = await estimateTier(
      content,
      deps.classifier ? { classifier: deps.classifier } : {}
    );
    await deps.store.setTierEstimate(orgId, task.id, estimate);

    // §6.6 — match capability over eligible agents.
    const taskForMatch: Task = { ...task, tierEstimate: estimate };
    const candidates = await deps.directory.listCandidates(taskForMatch);
    const ranked = matchCapability(estimate, candidates);
    const winner = ranked.find((m) => m.eligible) ?? null;

    await deps.store.recordRoutingDecision(orgId, {
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
    const existingPrs = await deps.store.listPullRequestsForTask(orgId, task.id);
    if (existingPrs.length > 0) {
      const prUrl = existingPrs[0]!.url;
      // The row was just re-claimed (claimed). Mirror the normal path's
      // claimed→executing move before finalizing — finalize advances
      // executing→in_review, and the write-path guard rejects claimed→in_review,
      // which would otherwise (silently, via finalize's best-effort wrapper) strand
      // the task in `claimed` with an open PR.
      await deps.store.setStatus(orgId, task.id, 'executing');
      await finalizeDispatch(deps, orgId, task.id, event, winner.agentId, principalId, prUrl);
      return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl };
    }

    // §6.9-13 — dispatch → worktree + agent → PR → status-back.
    await deps.store.setStatus(orgId, task.id, 'executing');

    // The agent prompt (shared by the enqueued payload + the in-process path so a
    // runner and the fallback run the SAME task). content is the real story body.
    const prompt = buildAgentPrompt(content);
    if (prompt.length > PROMPT_TRUNCATE_THRESHOLD) {
      deps.logger?.info?.('coordination: agent prompt truncated to fit', {
        taskId: task.id,
        promptChars: prompt.length,
        capChars: PROMPT_TRUNCATE_THRESHOLD,
      });
    }

    // SPLIT DISPATCH (when a queue is wired): enqueue the job for an agent-runner and WAIT
    // (polling) for a runner to claim it. The hardened boundary HOLDS — there is no longer
    // an in-process fallback: if no runner claims within the wait bound, the task is retired
    // to needs_attention with an honest "no execution capacity" reason (visible + actionable),
    // NEVER run in-process co-located with the master key. `cancel` stays the race-safe hinge
    // at the timeout boundary.
    if (deps.dispatchQueue && repoRef) {
      const payload: DispatchPayload = {
        taskId: task.id,
        repoRef,
        platform: event.platform,
        externalStoryId: event.externalStoryId,
        agentId: winner.agentId,
        prompt,
        headBranch: deterministicHeadBranch(event.externalStoryId),
      };
      const { id: jobId } = await deps.dispatchQueue.enqueue({
        taskId: task.id,
        payload: payload as unknown as Record<string, unknown>,
      });
      const waitMs = deps.runnerWaitMs ?? DEFAULT_RUNNER_WAIT_MS;
      const pollMs = deps.runnerPollMs ?? DEFAULT_RUNNER_POLL_MS;
      const claim = await awaitRunnerClaim(deps.dispatchQueue, jobId, waitMs, pollMs);
      if (claim === 'claimed') {
        // A runner owns the task; the reaper finalizes on completion (PR url unknown here).
        deps.logger?.info?.('coordination: dispatched to an agent-runner', { taskId: task.id, jobId });
        return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: '(runner)' };
      }
      if (claim === 'preempted') {
        // An operator cancel/reassign flipped the job to `cancelled` mid-wait; the canceller
        // owns the task's post-cancel state. Bow out — never claim 'dispatched' for it.
        deps.logger?.info?.('coordination: dispatch preempted by an operator cancel/reassign', { taskId: task.id, jobId });
        return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
      }
      // claim === 'timeout': the job is still queued past the bound. cancel() decides it
      // atomically — true ⇒ we deleted a still-queued job (genuinely no runner); false ⇒
      // a runner or operator took it in the last gap, so defer to its true status.
      const removed = await deps.dispatchQueue.cancel(jobId);
      if (!removed) {
        const st = await deps.dispatchQueue.jobStatus(jobId);
        if (st === 'cancelled' || st === null) {
          return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
        }
        deps.logger?.info?.('coordination: a runner claimed at the wait boundary', { taskId: task.id, jobId });
        return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: '(runner)' };
      }
      // Genuinely no execution capacity. Retire to needs_attention WITHOUT the breaker —
      // a runner outage is infra-unavailability, not an agent failure, so it must not burn
      // the task's retry budget. The reason is recorded in last_error for the operator.
      const reason = `no execution capacity: no agent-runner claimed within ${waitMs}ms`;
      const acted = await deps.store.failNoCapacity(orgId, task.id, reason);
      if (!acted) {
        // The guard missed: an operator cancel/reassign moved the task out of executing
        // during the wait. They own it — don't claim a no_capacity we didn't apply.
        deps.logger?.info?.('coordination: no-capacity retire skipped; task already moved (operator)', { taskId: task.id, jobId });
        return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
      }
      deps.logger?.error('coordination: no runner claimed within the wait bound; task → needs_attention (no execution capacity)', {
        taskId: task.id,
        jobId,
        waitMs,
      });
      return { kind: 'no_capacity', taskId: task.id, agentId: winner.agentId };
    }

    // NO-QUEUE MODE ONLY (deps.dispatchQueue absent, or no repoRef to dispatch): run the
    // agent IN-PROCESS. This is the Stage-1 single-process / test execution path, NOT a
    // production fallback — when the queue is wired, the branch above always returns.
    // Provision a worktree for the agent run. A GitHub event's repoHint is an
    // `owner/repo` slug, not a local path. With a provisioner we ensure the
    // (tokenless-origin) local clone exists, then have the PROVISIONER create the
    // worktree — NOT ExecutionPort.reserveWorktree, whose vendored path would
    // `git fetch origin` + pushOnCreate against an origin we can no longer
    // authenticate. The provisioner branches off `origin/<defaultBranch>` and
    // returns that as the base ref. Without a provisioner (Stage-1 single-checkout /
    // tests) we keep reserveWorktree, repoRef used as-is and no base-ref override.
    let worktree: { path: string; branch: string };
    let baseRef: string | undefined;
    if (repoRef && deps.provisioner) {
      await deps.provisioner.ensureLocalRepo(repoRef);
      const created = await deps.provisioner.createWorktree(repoRef, event.externalStoryId);
      worktree = created;
      baseRef = created.baseRef;
      provisionedWorktree = { path: created.path, branch: created.branch };
    } else {
      worktree = await deps.execution.reserveWorktree({
        repoPath: repoRef ?? '.',
        taskLabel: event.externalStoryId,
        projectId: event.externalStoryId,
      });
    }

    // §6.10 — spawn the agent over a PTY; await its exit before opening the PR. The
    // prompt was built above (shared with the enqueued payload). The body is
    // attacker-controlled; it reaches the shell only through the POSIX-quoted claude
    // command the factory builds from `prompt`.
    const agentRun = await runAgentToCompletion(
      deps.execution,
      { id: task.id, cwd: worktree.path, prompt },
      agentTimeoutMs
    );
    // Always surface what the agent did — its exit code + output tail — so a
    // no-diff run (below) is diagnosable: did it edit nothing, hit an auth error,
    // run in the wrong place, find no usable tools?
    deps.logger?.info?.('coordination: agent run complete', {
      taskId: task.id,
      exitCode: agentRun.exitCode,
      outputChars: agentRun.outputTail.length,
      outputTail: agentRun.outputTail,
    });

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
    // `gh pr create` (inside openPr) needs its own token — the worktree origin
    // authenticates the git push, but gh doesn't read that. Obtain a current
    // installation token for the owner (the App client returns its cached one while
    // still valid); absent provisioner → gh falls back to ambient auth.
    const prToken =
      repoRef && deps.provisioner ? await deps.provisioner.tokenForRepo(repoRef) : undefined;
    const pr = await deps.execution.openPr({
      cwd: worktree.path,
      branch: worktree.branch,
      headBranch: deterministicHeadBranch(event.externalStoryId),
      title: `Tasca: ${event.externalStoryId}`,
      ...(prToken ? { token: prToken } : {}),
    });
    await deps.store.recordPullRequest(orgId, { taskId: task.id, url: pr.url });

    // §6.12 — finalize (audit + status-back + in_review): best-effort, never throws.
    await finalizeDispatch(deps, orgId, task.id, event, winner.agentId, principalId, pr.url);

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
      orgId,
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
  } finally {
    // Reclaim the provisioner-created worktree + branch on EVERY terminal path
    // (success, failure, re-drive) so they don't accumulate without bound. Only the
    // provisioner path sets this; reserveWorktree (no-provisioner) is unaffected.
    // removeWorktree is best-effort and never throws, so it can't disturb the outcome.
    if (provisionedWorktree && repoRef && deps.provisioner) {
      await deps.provisioner.removeWorktree(
        repoRef,
        provisionedWorktree.path,
        provisionedWorktree.branch
      );
    }
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
/** What an agent run produced: its exit code (null on a benign EIO/EPIPE teardown)
 *  and the tail of its terminal output — captured so a no-diff / failed run is
 *  diagnosable (did the agent edit nothing, hit an auth error, find no tools?). */
interface AgentRunResult {
  exitCode: number | null;
  outputTail: string;
}

/** Poll the dispatch queue for a runner to claim `jobId`, up to `waitMs`. Returns:
 *  - 'claimed'   — a runner took it (status left 'queued' for a runner state),
 *  - 'preempted' — an operator cancel/reassign flipped it to 'cancelled' (or it's gone),
 *  - 'timeout'   — still 'queued' after the bound (no runner claimed).
 *  The first poll is immediate, so a fast claim returns without waiting the full bound. */
async function awaitRunnerClaim(
  queue: DispatchQueue,
  jobId: string,
  waitMs: number,
  pollMs: number
): Promise<'claimed' | 'preempted' | 'timeout'> {
  const interval = Math.max(1, pollMs);
  const polls = Math.max(1, Math.ceil(waitMs / interval));
  for (let i = 0; i < polls; i++) {
    const st = await queue.jobStatus(jobId);
    if (st === null || st === 'cancelled') return 'preempted';
    if (st !== 'queued') return 'claimed';
    if (i < polls - 1) await sleep(interval);
  }
  return 'timeout';
}

/** Cap on captured agent output; we keep only the last of a long run for the log. */
const AGENT_OUTPUT_TAIL_CHARS = 4000;

function runAgentToCompletion(
  execution: ExecutionPort,
  input: { id: string; cwd: string; prompt: string },
  timeoutMs: number
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const handle = execution.spawnAgent(input);
    // Capture the agent's terminal output (the PTY merges stdout+stderr) so a run
    // is not a black box: keep only the tail to bound memory + the log line.
    let output = '';
    handle.onData((chunk) => {
      output += chunk;
      if (output.length > AGENT_OUTPUT_TAIL_CHARS) output = output.slice(-AGENT_OUTPUT_TAIL_CHARS);
    });
    const tail = (): string => output.slice(-1000);
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
        reject(new ExecutionError('spawn', `agent run timed out after ${timeoutMs}ms; output: ${tail()}`));
      });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    handle.onError((err) => {
      const code = (err as { code?: string }).code;
      // EIO/EPIPE on the PTY master during child teardown is a benign Linux race;
      // treat it as success and let commitAgentWork be the source of truth.
      if (code === 'EIO' || code === 'EPIPE') finish(() => resolve({ exitCode: null, outputTail: output }));
      else finish(() => reject(err));
    });
    handle.onExit((code) => {
      if (code === 0) finish(() => resolve({ exitCode: 0, outputTail: output }));
      // A non-zero exit carries the output tail so the failure log shows what the
      // agent said (auth error, no tools, …), not just the bare code.
      else finish(() => reject(new ExecutionError('spawn', `agent exited with code ${code}; output: ${tail()}`)));
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
export async function finalizeDispatch(
  deps: FinalizeDeps,
  orgId: string,
  taskId: string,
  event: FinalizeEvent,
  agentId: string,
  principalId: string | null,
  prUrl: string,
  // The CUSTOMER-FACING post + its audits must fire at most once. The reaper finalizes
  // at-least-once (a job can be re-leased after a crash / failed markReaped), so it
  // passes false on a re-finalize (PR already recorded) to suppress a duplicate
  // 'PR opened' comment. In-process callers (single finalize) keep the default true.
  firstFinalize = true
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

  // setStatus is idempotent (in_review→in_review is rejected + swallowed), so it always
  // runs to reconcile a left-behind 'executing'. The post + audits are additive
  // (a second 'PR opened' comment hits the customer), so they're gated on first finalize.
  if (firstFinalize) {
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
  }
  await safe('set.in_review', () => deps.store.setStatus(orgId, taskId, 'in_review'));
  if (firstFinalize) {
    await safe('audit.status.post', () =>
      audit(deps, principalId, agentId, event, {
        action: 'status.post',
        target: taskId,
        payload: { state: 'in_review', prUrl },
      })
    );
  }
}

/** Best-effort audit append — skipped (not failed) when no principal resolves. */
async function audit(
  deps: Pick<OrchestrationDeps, 'audit'>,
  principalId: string | null,
  agentId: string,
  event: { platform: AdapterEvent['platform'] },
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
