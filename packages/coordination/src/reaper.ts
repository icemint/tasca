// The REAPER — the coordination-side finalizer for the split dispatch path. The runner
// is write-scoped to the QUEUE ONLY: it claims, mints a scoped token, executes, and
// writes its result back to the queue (a `done` job carrying the PR url, or a `failed`
// job). It NEVER touches coordination tables — that keeps a compromised runner's blast
// radius to the queue. The reaper closes the loop from this side:
//
//   sweepExpired  — a runner that claimed then DIED leaves an expired lease; requeue it
//                   for another runner, or fail it over at the attempts cap so a dead
//                   runner can't stall its task forever (the runner-path equivalent of
//                   the in-process fallback).
//   claimFinished — lease terminal jobs to THIS reaper, then finalize per their status:
//                     done   → record the PR + status-back + advance task to in_review
//                     failed → drive the task breaker (recordFailureAndTransition)
//                   then markReaped (delete) the job.
//
// Finalize is idempotent (it skips re-recording a PR already on the task) so the
// at-least-once lease — a reaper crash mid-finalize just lets reaping_at lapse and the
// row is re-selected — never double-records or strands a task.

import type { DispatchQueue, FinishedJob } from '@tasca/db';
import type { CoordinationStore } from './store';
import type { StatusReporter, Logger } from './ports';
import { finalizeDispatch, type AuditSink, type DispatchPayload, type FinalizeEvent } from './orchestrate';

export interface ReaperDeps {
  queue: DispatchQueue;
  store: CoordinationStore;
  status: StatusReporter;
  audit: AuditSink;
  /** Resolve an agent's audit principal id (the reaper attributes finalize audits). */
  principalIdFor(agentId: string): Promise<string | null>;
  /** Breaker threshold for failed-job finalization; defaults to 2 (mirrors orchestrate). */
  breakerThreshold?: number;
  /** Max terminal jobs finalized per tick. Default 10. */
  batchSize?: number;
  /** How long a finished job is leased to this reaper while it finalizes. Default 30s. */
  reapLeaseSeconds?: number;
  /** Attempts cap for sweepExpired fail-over. Default 3. */
  maxDispatchAttempts?: number;
  /** Poll cadence of the reaper loop. Default 2000ms. */
  pollIntervalMs?: number;
  logger?: Logger;
}

export interface ReapResult {
  finalizedDone: number;
  finalizedFailed: number;
  reclaimed: number;
  failedOver: number;
}

export interface Reaper {
  /** Run one sweep + finalize batch. Returns what it did (tests drive this directly). */
  tick(): Promise<ReapResult>;
  /** Start the poll loop (idempotent). */
  start(): void;
  /** Stop after the in-flight tick; resolves when the loop has exited. */
  stop(): Promise<void>;
}

const DEFAULT_BREAKER_THRESHOLD = 2;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_REAP_LEASE_SECONDS = 30;
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3;
const DEFAULT_POLL_MS = 2000;

export function makeReaper(deps: ReaperDeps): Reaper {
  const breakerThreshold = deps.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const reapLeaseSeconds = deps.reapLeaseSeconds ?? DEFAULT_REAP_LEASE_SECONDS;
  const maxAttempts = deps.maxDispatchAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;

  const finalizeDeps = { store: deps.store, status: deps.status, audit: deps.audit, ...(deps.logger ? { logger: deps.logger } : {}) };

  async function finalizeDone(job: FinishedJob): Promise<void> {
    const payload = job.payload as Partial<DispatchPayload>;
    const prUrl = typeof job.result?.['prUrl'] === 'string' ? (job.result['prUrl'] as string) : null;
    if (!prUrl) {
      // A `done` job with no PR url is anomalous (the runner reports one on success).
      // Finalize can't record a PR it doesn't have; reap it with a loud log rather than
      // re-leasing it forever. The task's status reconciles on a later delivery.
      deps.logger?.error('reaper: done job has no PR url; reaping without finalize', { jobId: job.id, taskId: job.taskId });
      return;
    }
    const event = finalizeEvent(payload);
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '(runner)';
    // Idempotency: if a PR is already recorded for this task (a prior tick finalized,
    // or the in-process path did), DON'T record a second one — just (re)advance status.
    const existing = await deps.store.listPullRequestsForTask(job.taskId);
    if (existing.length === 0) {
      await deps.store.recordPullRequest({ taskId: job.taskId, url: prUrl });
    }
    const principalId = await deps.principalIdFor(agentId);
    await finalizeDispatch(finalizeDeps, job.taskId, event, agentId, principalId, prUrl);
  }

  async function finalizeFailed(job: FinishedJob): Promise<void> {
    const payload = job.payload as Partial<DispatchPayload>;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '(runner)';
    // Drive the SAME breaker the in-process catch uses: increment failure + transition
    // (below threshold → routable for a re-drive; at/over → needs_attention) atomically.
    const { failureCount, tripped } = await deps.store.recordFailureAndTransition(job.taskId, breakerThreshold);
    const principalId = await deps.principalIdFor(agentId);
    if (principalId) {
      await deps.audit
        .record({
          principalId,
          agentId,
          platform: payload.platform,
          action: 'task.failed',
          target: job.taskId,
          payload: { failureCount, outcome: tripped ? 'needs_attention' : 'retry', error: job.lastError ?? 'runner reported failure' },
        })
        .catch((err) => deps.logger?.error('reaper: failed-job audit threw', { jobId: job.id, err: errMsg(err) }));
    }
    deps.logger?.info?.('reaper: finalized failed job', { jobId: job.id, taskId: job.taskId, failureCount, tripped });
  }

  async function tick(): Promise<ReapResult> {
    const result: ReapResult = { finalizedDone: 0, finalizedFailed: 0, reclaimed: 0, failedOver: 0 };

    // 1. Recover dead-runner claims first, so their fail-overs surface as `failed` jobs
    //    this same tick's finalize pass can pick up.
    const swept = await deps.queue.sweepExpired(maxAttempts);
    result.reclaimed = swept.reclaimed;
    result.failedOver = swept.failedOver;

    // 2. Finalize a batch of terminal jobs. Each is independent: a throw on one leaves
    //    it un-reaped (its lease lapses → re-selected next tick) without blocking others.
    const finished = await deps.queue.claimFinished(batchSize, reapLeaseSeconds);
    for (const job of finished) {
      try {
        if (job.status === 'done') {
          await finalizeDone(job);
          result.finalizedDone += 1;
        } else {
          await finalizeFailed(job);
          result.finalizedFailed += 1;
        }
        await deps.queue.markReaped(job.id);
      } catch (err) {
        deps.logger?.error('reaper: finalize failed; leaving job for retry', { jobId: job.id, taskId: job.taskId, status: job.status, err: errMsg(err) });
      }
    }
    return result;
  }

  let started = false;
  let stopping = false;
  let loopDone: Promise<void> | null = null;

  async function loop(): Promise<void> {
    while (!stopping) {
      try {
        await tick();
      } catch (err) {
        deps.logger?.error('reaper: tick failed', { err: errMsg(err) });
      }
      if (!stopping) await sleep(pollMs);
    }
  }

  return {
    tick,
    start(): void {
      if (started) return;
      started = true;
      stopping = false;
      deps.logger?.info?.('coordination: reaper started');
      loopDone = loop();
    },
    async stop(): Promise<void> {
      stopping = true;
      await loopDone?.catch(() => {});
      started = false;
    },
  };
}

/** Reconstruct the finalize event from the dispatch payload (platform + story id are
 *  all finalize/status-back read). Defaults platform to 'github' if a malformed payload
 *  lacks it — finalize is best-effort and never throws on a missing field. */
function finalizeEvent(payload: Partial<DispatchPayload>): FinalizeEvent {
  return {
    platform: payload.platform ?? 'github',
    externalStoryId: typeof payload.externalStoryId === 'string' ? payload.externalStoryId : '',
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
