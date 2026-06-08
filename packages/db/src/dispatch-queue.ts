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
   * gone). This is the race-safe hinge of the in-process fallback: coordination
   * enqueues, waits briefly, then `cancel`s — true means no runner took it (run it
   * in-process), false means a runner owns it (let the runner + reaper handle it). The
   * queue's exactly-once claim guarantees these two outcomes never overlap.
   */
  cancel(jobId: string): Promise<boolean>;
  /** Extend the lease of a still-held job (heartbeat for long runs). Returns false
   *  if the claim was already lost (fence advanced / no longer claimed). */
  renewLease(jobId: string, fence: number, leaseSeconds: number): Promise<boolean>;
  /** Mark a claimed job `done` (terminal). Fenced: returns false if the claim was lost. */
  complete(jobId: string, fence: number): Promise<boolean>;
  /** Return a job to `queued` for another attempt, optionally delayed (backoff).
   *  Fenced: returns false if the claim was lost. */
  release(jobId: string, fence: number, opts?: { delaySeconds?: number }): Promise<boolean>;
  /** Mark a job `failed` (terminal); records `error`. Fenced: returns false if lost. */
  fail(jobId: string, fence: number, error?: string): Promise<boolean>;
  /** Requeue every `claimed` job whose lease has expired (crashed-runner recovery).
   *  Returns how many were reclaimed. The next claim bumps their fence, so a revived
   *  original runner's terminal write is fenced out. */
  reclaimExpired(): Promise<number>;
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

  async renewLease(jobId: string, fence: number, leaseSeconds: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status = 'claimed'`,
      [jobId, fence, leaseSeconds]
    );
    return res.rowCount === 1;
  }

  async complete(jobId: string, fence: number): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE dispatch_job SET status = 'done', lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status = 'claimed'`,
      [jobId, fence]
    );
    return res.rowCount === 1;
  }

  async release(jobId: string, fence: number, opts?: { delaySeconds?: number }): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL,
              available_at = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status = 'claimed'`,
      [jobId, fence, opts?.delaySeconds ?? 0]
    );
    return res.rowCount === 1;
  }

  async fail(jobId: string, fence: number, error?: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'failed', lease_expires_at = NULL, last_error = $3, updated_at = now()
        WHERE id = $1 AND claim_epoch = $2 AND status = 'claimed'`,
      [jobId, fence, error ?? null]
    );
    return res.rowCount === 1;
  }

  async reclaimExpired(): Promise<number> {
    const res = await this.db.query(
      `UPDATE dispatch_job
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status = 'claimed' AND lease_expires_at < now()`
    );
    return res.rowCount ?? 0;
  }
}
