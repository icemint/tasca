import { randomUUID } from 'node:crypto';
import type { Queryable } from './claim-repo';

/** A job to dispatch: the task it belongs to + the opaque payload a runner needs. */
export interface DispatchJobInput {
  taskId: string;
  /** Everything the runner needs to execute (repoRef, prompt context, headBranch, …).
   *  Opaque to the queue — serialized as jsonb. */
  payload: Record<string, unknown>;
  /** Delay before the job becomes claimable (backoff / scheduled retry). Default 0. */
  availableInSeconds?: number;
}

/** A finished (terminal) job the reaper leases to finalize: a `done` job carries the
 *  runner's `result` (e.g. the PR url) to record; a `failed` job carries `lastError` to
 *  drive the task's breaker; a `cancelled` job (operator interrupt) re-routes the task. The
 *  status is the source of truth — the reaper finalizes per it, then `markReaped` deletes it. */
export interface FinishedJob {
  id: string;
  taskId: string;
  payload: Record<string, unknown>;
  status: 'done' | 'failed' | 'cancelled';
  result: Record<string, unknown> | null;
  lastError: string | null;
}

/** What a single sweep of expired-lease claims did: how many were requeued for another
 *  runner vs failed-over (over the attempts cap) so the reaper drives the task breaker. */
export interface SweepResult {
  reclaimed: number;
  failedOver: number;
}

/**
 * The outcome of requesting a cancel:
 *   - 'removed'   — it was still `queued`, taken off the queue before any runner claimed it.
 *   - 'signalled' — it was `claimed` (a runner is executing); flipped to `cancelled`, so the
 *                   runner will lose the row at its point-of-no-return (beginPublish) or its
 *                   next heartbeat, abort, and revoke its scoped token. The reaper reaps it.
 *   - 'too_late'  — the runner already passed the point of no return (`publishing`) or the job
 *                   is terminal (`done`/`failed`/`cancelled`); the cancel is a no-op.
 */
export type CancelResult = 'removed' | 'signalled' | 'too_late';

/**
 * The outcome of cancelling whatever job is currently live for a TASK (used by the
 * write-API's interrupt/reassign-executing path). Same three cancel outcomes as
 * {@link CancelResult}, plus:
 *   - 'no_job' — the task has NO active dispatch job (queued/claimed/publishing). Either it
 *               is running in-process (the coordination fallback, which this seam can't
 *               interrupt) or it already finished. The caller must surface this honestly,
 *               never as a false "interrupted".
 */
export type CancelForTaskResult = CancelResult | 'no_job';

/** A claimed job handed to exactly one runner. */
export interface DispatchJob {
  id: string;
  taskId: string;
  payload: Record<string, unknown>;
  /** 1 on the first delivery; higher after a lease reclaim / release-retry. */
  attempts: number;
  /**
   * The FENCING TOKEN for this claim — a monotonic counter bumped on every claim.
   * complete/release/fail/renewLease must present it; the write is rejected if the
   * job was reclaimed and re-claimed by another runner in the meantime (the epoch
   * advanced). This stops a lease-lapsed-but-alive runner from clobbering the job a
   * second runner now legitimately owns. Treat it as opaque.
   */
  fence: number;
}

/**
 * The dispatch queue contract: coordination enqueues, an agent-runner claims.
 *
 * Two layered guarantees:
 *   1. DELIVERY is exactly-once under concurrent runners — `claimNext` (FOR UPDATE
 *      SKIP LOCKED) never hands the same job to two callers (proven by a forced-
 *      parallelism test).
 *   2. COMPLETION is fenced — complete/release/fail are rejected unless they carry
 *      the `fence` from the CURRENT claim, so a runner that overran its lease (and
 *      was reclaimed + re-claimed by another runner) cannot clobber the new owner's
 *      job. Those methods return `true` iff the write applied (the caller still
 *      holds the claim) and `false` if it was fenced out (it lost the lease).
 *
 * A runner doing long work should `renewLease` before its lease lapses; otherwise
 * `reclaimExpired` will requeue the job and EXECUTION degrades to at-least-once
 * (a second runner may run it concurrently) — so runner side effects must be
 * idempotent (Tasca's deterministic PR head + idempotent openPr provide this).
 */
export interface DispatchQueue {
  /** Enqueue a job (status `queued`). Returns its id. */
  enqueue(input: DispatchJobInput): Promise<{ id: string }>;
  /**
   * Atomically claim the oldest available `queued` job for `runnerId`, leasing it
   * for `leaseSeconds` and bumping its fence. Returns the job (with its `fence`), or
   * null when nothing is claimable. NEVER returns the same job to two concurrent
   * callers.
   */
  claimNext(runnerId: string, leaseSeconds: number): Promise<DispatchJob | null>;
  /**
   * Atomically remove a job IFF it is still `queued` (unclaimed). Returns true when it
   * was removed, false when it could NOT be (a runner already claimed it, or it's
   * gone). This is the race-safe hinge of the runner-wait path: coordination enqueues,
   * waits (polling) for a runner to claim, then `cancel`s on timeout — true means no
   * runner took it (retire the task to needs_attention), false means a runner owns it
   * (let the runner + reaper handle it). The exactly-once claim guarantees these never
   * overlap. (Also: the in-process no-queue mode still uses `true` to run in-process.)
   */
  cancel(jobId: string): Promise<boolean>;
  /** Read a job's current status (`queued`/`claimed`/`publishing`/`done`/`failed`/
   *  `cancelled`), or null if the row is gone. Non-destructive — used to poll for a
   *  runner claim during the bounded wait without consuming the race-safe `cancel`. */
  jobStatus(jobId: string): Promise<string | null>;
  /** Extend the lease of a still-held job (heartbeat for long runs). Returns false
   *  if the claim was already lost (fence advanced / no longer claimed). */
  renewLease(jobId: string, fence: number, leaseSeconds: number): Promise<boolean>;
  /**
   * The runner's POINT OF NO RETURN, taken right before it opens the PR. Atomically moves a
   * still-held `claimed` job to `publishing` (fenced). Returns true if the runner won the
   * row — it is now committed to finish and a concurrent `requestCancel` will see `too_late`.
   * Returns false if it lost: an operator's `requestCancel` flipped the row to `cancelled`
   * first, or the claim was fenced out — either way the runner MUST abort without opening a
   * PR and revoke its token. This conditional transition is the exactly-one cancel hinge.
   */
  beginPublish(jobId: string, fence: number): Promise<boolean>;
  /**
   * Request cancellation of a job (operator interrupt / executing-reassign). Removes it if
   * still `queued`; flips it `claimed`→`cancelled` if a runner holds it (the runner aborts +
   * revokes); a no-op once the runner is `publishing` or the job is terminal. See CancelResult.
   */
  requestCancel(jobId: string): Promise<CancelResult>;
  /**
   * Cancel whatever job is currently live for a TASK (the write-API interrupt / reassign-an-
   * executing-task entrypoint). Finds the task's active job (queued/claimed/publishing), locks
   * it, and applies the same exactly-one cancel as {@link requestCancel}. Returns 'no_job' when
   * the task has no active job (in-process fallback, or already finished). Designed to run on a
   * caller-supplied transaction client so the cancel + the task-state transition commit
   * atomically. See {@link CancelForTaskResult}.
   */
  requestCancelForTask(taskId: string): Promise<CancelForTaskResult>;
  /** Mark a job `done` (terminal) from `publishing` (the runner's post-point-of-no-return
   *  state), storing the runner's `result` for the reaper. Fenced: false if the claim/row was
   *  lost (e.g. reclaimed). */
  complete(jobId: string, fence: number, result?: Record<string, unknown>): Promise<boolean>;
  /** Return a job to `queued` for another attempt, optionally delayed (backoff).
   *  Fenced: returns false if the claim was lost. */
  release(jobId: string, fence: number, opts?: { delaySeconds?: number }): Promise<boolean>;
  /** Mark a job `failed` (terminal); records `error`. Fenced: returns false if lost. */
  fail(jobId: string, fence: number, error?: string): Promise<boolean>;
  /** Requeue every `claimed` job whose lease has expired (crashed-runner recovery).
   *  Returns how many were reclaimed. The next claim bumps their fence, so a revived
   *  original runner's terminal write is fenced out. */
  reclaimExpired(): Promise<number>;
  /**
   * Sweep expired-lease claims (a runner claimed then died): requeue those under
   * `maxAttempts` for another runner, but FAIL OVER those at/over the cap to `failed`
   * (so the reaper drives the task's breaker instead of re-dispatching forever). This
   * bounds REPEATED claim-then-die — it does not (and cannot) un-stall a job requeued
   * to a fleet with no live runner (no consumer ⇒ no progress; the reaper logs the
   * sweep so that's observable). Returns the split of reclaimed vs failed-over.
   */
  sweepExpired(maxAttempts: number): Promise<SweepResult>;
  /**
   * Lease up to `limit` terminal (`done`/`failed`) jobs to ONE reaper for finalization,
   * via FOR UPDATE SKIP LOCKED. Sets `reaping_at` (a lease) WITHOUT changing status, so
   * a reaper crash mid-finalize just lets the lease lapse and the row is re-selected.
   * Idempotent finalize + this lease give at-least-once finalization with no lost rows.
   */
  claimFinished(limit: number, leaseSeconds: number): Promise<FinishedJob[]>;
  /** Delete a finished job once the reaper has finalized it (terminal cleanup). */
  markReaped(jobId: string): Promise<void>;
}

/**
 * Postgres dispatch queue. The claim uses the canonical FOR UPDATE SKIP LOCKED idiom:
 * the inner SELECT locks ONE claimable row and skips rows other transactions already
 * hold, so N concurrent claimers each take a DISTINCT row (or null) — never the same
 * one. The outer UPDATE flips it to `claimed` and leases it in the same statement.
 */
export class PgDispatchQueue implements DispatchQueue {
  // A pool or a single connection (tests drive the race on dedicated connections).
  constructor(private readonly db: Queryable) {}

  async enqueue(input: DispatchJobInput): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO dispatch_job (id, task_id, payload, available_at)
       VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4))`,
      [id, input.taskId, JSON.stringify(input.payload), input.availableInSeconds ?? 0]
    );
    return { id };
  }

  async claimNext(runnerId: string, leaseSeconds: number): Promise<DispatchJob | null> {
    const res = await this.db.query<{
      id: string;
      task_id: string;
      payload: Record<string, unknown>;
      attempts: number;
      claim_epoch: string;
    }>(
      `UPDATE dispatch_job
          SET status = 'claimed', claimed_by = $1, attempts = attempts + 1,
              claim_epoch = claim_epoch + 1,
              lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id = (
          SELECT id FROM dispatch_job
           WHERE status = 'queued' AND available_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING id, task_id, payload, attempts, claim_epoch`,
      [runnerId, leaseSeconds]
    );
    if (res.rowCount !== 1) return null;
    const row = res.rows[0]!;
    // bigint comes back as a string from pg; the fence fits well within a JS number
    // for any realistic claim count, and is treated as opaque by callers.
    return { id: row.id, taskId: row.task_id, payload: row.payload, attempts: row.attempts, fence: Number(row.claim_epoch) };
  }

  async cancel(jobId: string): Promise<boolean> {
    // Delete only while still queued — if a runner has claimed it (status='claimed'),
    // the WHERE misses, rowCount 0, and the caller defers to the runner.
    const res = await this.db.query(
      `DELETE FROM dispatch_job WHERE id = $1 AND status = 'queued'`,
      [jobId]
    );
    return res.rowCount === 1;
  }

  async jobStatus(jobId: string): Promise<string | null> {
    const res = await this.db.query<{ status: string }>(
      `SELECT status FROM dispatch_job WHERE id = $1`,
      [jobId]
    );
    return res.rowCount === 1 ? res.rows[0]!.status : null;
  }

  async renewLease(jobId: string, fence: number, leaseSeconds: number): Promise<boolean> {
    // Renew while the runner still holds the job — `claimed` (agent running) OR `publishing`
    // (past beginPublish, opening the PR). Covering `publishing` keeps a slow openPr from
    // letting the lease lapse (which would both spuriously abort the run and make the row
    // reclaimable mid-publish). Still fenced on claim_epoch, so a reclaim/cancel loses it.
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status IN ('claimed','publishing')`,
      [jobId, fence, leaseSeconds]
    );
    return res.rowCount === 1;
  }

  async beginPublish(jobId: string, fence: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE dispatch_job SET status = 'publishing', updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status = 'claimed'`,
      [jobId, fence]
    );
    return res.rowCount === 1;
  }

  async requestCancel(jobId: string): Promise<CancelResult> {
    // One statement: capture the prior status under a row lock, then flip queued|claimed →
    // cancelled. The row lock is what serializes this against the runner's beginPublish
    // (claimed → publishing) — exactly one of the two transitions wins the `claimed` row.
    const res = await this.db.query<{ prev_status: string }>(
      `WITH prev AS (SELECT id, status FROM dispatch_job WHERE id = $1 FOR UPDATE)
       UPDATE dispatch_job d
          SET status = 'cancelled', cancelled_at = now(), lease_expires_at = NULL, updated_at = now()
         FROM prev
        WHERE d.id = prev.id AND prev.status IN ('queued','claimed')
       RETURNING prev.status AS prev_status`,
      [jobId]
    );
    if (res.rowCount !== 1) return 'too_late'; // publishing / terminal / gone
    return res.rows[0]!.prev_status === 'queued' ? 'removed' : 'signalled';
  }

  async requestCancelForTask(taskId: string): Promise<CancelForTaskResult> {
    // Find the task's single live job (the system invariant is one active job per task;
    // ORDER BY created_at DESC LIMIT 1 is a defensive tiebreak), lock it, then apply the
    // same queued|claimed → cancelled flip as requestCancel. The FOR UPDATE on `active`
    // serializes against the runner's beginPublish exactly as the by-id path does. The
    // RETURNING reports the prior status even when the conditional UPDATE did not fire, so
    // a 'publishing' job is told apart from no job at all.
    const res = await this.db.query<{ prev_status: string; cancelled: boolean }>(
      `WITH active AS (
         SELECT id, status FROM dispatch_job
          WHERE task_id = $1 AND status IN ('queued','claimed','publishing')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
       ),
       upd AS (
         UPDATE dispatch_job d
            SET status = 'cancelled', cancelled_at = now(), lease_expires_at = NULL, updated_at = now()
           FROM active
          WHERE d.id = active.id AND active.status IN ('queued','claimed')
         RETURNING d.id
       )
       SELECT a.status AS prev_status, EXISTS (SELECT 1 FROM upd) AS cancelled
         FROM active a`,
      [taskId]
    );
    if (res.rowCount !== 1) return 'no_job'; // no active job — in-process fallback or already done
    const row = res.rows[0]!;
    if (!row.cancelled) return 'too_late'; // it was 'publishing' — the runner is finishing
    return row.prev_status === 'queued' ? 'removed' : 'signalled';
  }

  async complete(jobId: string, fence: number, result?: Record<string, unknown>): Promise<boolean> {
    // Accept 'publishing' (the normal path — the runner beginPublishes before openPr) AND
    // 'claimed' (back-compat: a complete with no prior beginPublish). Still fenced.
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'done', lease_expires_at = NULL, result = $3::jsonb, updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status IN ('claimed','publishing')`,
      [jobId, fence, result === undefined ? null : JSON.stringify(result)]
    );
    return res.rowCount === 1;
  }

  async release(jobId: string, fence: number, opts?: { delaySeconds?: number }): Promise<boolean> {
    // Accept 'publishing' as well as 'claimed': if openPr THROWS after a won beginPublish,
    // execute rejects and the runner's catch releases for an idempotent re-drive — the row
    // is 'publishing' by then, so a 'claimed'-only guard would strand it until the lease
    // lapsed (sweep would still recover it, but a lease later). Still fenced on claim_epoch.
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL,
              available_at = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status IN ('claimed','publishing')`,
      [jobId, fence, opts?.delaySeconds ?? 0]
    );
    return res.rowCount === 1;
  }

  async fail(jobId: string, fence: number, error?: string): Promise<boolean> {
    // Symmetric with release/complete: a terminal failure can land from 'claimed' OR
    // 'publishing' (a non-retryable post-beginPublish failure records + drives the breaker
    // promptly instead of stranding the row). Still fenced on claim_epoch.
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'failed', lease_expires_at = NULL, last_error = $3, updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status IN ('claimed','publishing')`,
      [jobId, fence, error ?? null]
    );
    return res.rowCount === 1;
  }

  async reclaimExpired(): Promise<number> {
    // Same recovery scope as sweepExpired (the live reaper path): a dead runner can leave
    // an expired lease in `claimed` OR `publishing` — both must requeue, else `publishing`
    // zombies. openPr is idempotent so the re-drive is safe.
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status IN ('claimed','publishing') AND lease_expires_at < now()`
    );
    return res.rowCount ?? 0;
  }

  async sweepExpired(maxAttempts: number): Promise<SweepResult> {
    // Two writes, both scoped to expired-lease jobs a runner still nominally holds —
    // `claimed` (died mid-run) OR `publishing` (died after beginPublish, mid/after openPr).
    // Without `publishing` the latter is a ZOMBIE: never swept, never finalized (the reaper
    // takes terminal only), never re-claimable. A live publisher renews its lease (renewLease
    // now covers publishing), so only a genuinely dead one expires here. The re-drive is safe
    // because openPr is idempotent (deterministic head → no duplicate PR). Fail over FIRST
    // (attempts at the cap → 'failed' for the reaper's breaker path), then requeue the rest —
    // ordering so a row counts once. attempts was already incremented by the claim that then
    // died, so `attempts >= maxAttempts` means it has had its allotted runner tries.
    const failed = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'failed', claimed_by = NULL, lease_expires_at = NULL,
              last_error = 'exceeded max dispatch attempts', updated_at = now()
        WHERE status IN ('claimed','publishing') AND lease_expires_at < now() AND attempts >= $1`,
      [maxAttempts]
    );
    const reclaimed = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status IN ('claimed','publishing') AND lease_expires_at < now() AND attempts < $1`,
      [maxAttempts]
    );
    return { reclaimed: reclaimed.rowCount ?? 0, failedOver: failed.rowCount ?? 0 };
  }

  async claimFinished(limit: number, leaseSeconds: number): Promise<FinishedJob[]> {
    const res = await this.db.query<{
      id: string;
      task_id: string;
      payload: Record<string, unknown>;
      status: 'done' | 'failed' | 'cancelled';
      result: Record<string, unknown> | null;
      last_error: string | null;
    }>(
      `UPDATE dispatch_job
          SET reaping_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id IN (
          SELECT id FROM dispatch_job
           WHERE status IN ('done','failed','cancelled')
             AND (reaping_at IS NULL OR reaping_at < now())
           ORDER BY updated_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
      RETURNING id, task_id, payload, status, result, last_error`,
      [limit, leaseSeconds]
    );
    return res.rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      payload: r.payload,
      status: r.status,
      result: r.result,
      lastError: r.last_error,
    }));
  }

  async markReaped(jobId: string): Promise<void> {
    await this.db.query(`DELETE FROM dispatch_job WHERE id = $1`, [jobId]);
  }
}
