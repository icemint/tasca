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
}

/**
 * The dispatch queue contract: coordination enqueues, an agent-runner claims. The
 * claim is exactly-once under concurrent runners — `claimNext` is the load-bearing
 * guarantee (FOR UPDATE SKIP LOCKED), proven by a forced-parallelism test.
 */
export interface DispatchQueue {
  /** Enqueue a job (status `queued`). Returns its id. */
  enqueue(input: DispatchJobInput): Promise<{ id: string }>;
  /**
   * Atomically claim the oldest available `queued` job for `runnerId`, leasing it
   * for `leaseSeconds` (after which a crashed runner's job is reclaimable). Returns
   * the job, or null when nothing is claimable. NEVER returns the same job to two
   * concurrent callers.
   */
  claimNext(runnerId: string, leaseSeconds: number): Promise<DispatchJob | null>;
  /** Mark a claimed job `done` (terminal). */
  complete(jobId: string): Promise<void>;
  /** Return a job to `queued` for another attempt, optionally delayed (backoff). */
  release(jobId: string, opts?: { delaySeconds?: number }): Promise<void>;
  /** Mark a job `failed` (terminal); records `error` for diagnostics. */
  fail(jobId: string, error?: string): Promise<void>;
  /** Requeue every `claimed` job whose lease has expired (crashed-runner recovery).
   *  Returns how many were reclaimed. */
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
    }>(
      `UPDATE dispatch_job
          SET status = 'claimed', claimed_by = $1, attempts = attempts + 1,
              lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id = (
          SELECT id FROM dispatch_job
           WHERE status = 'queued' AND available_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING id, task_id, payload, attempts`,
      [runnerId, leaseSeconds]
    );
    if (res.rowCount !== 1) return null;
    const row = res.rows[0]!;
    return { id: row.id, taskId: row.task_id, payload: row.payload, attempts: row.attempts };
  }

  async complete(jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE dispatch_job SET status = 'done', lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [jobId]
    );
  }

  async release(jobId: string, opts?: { delaySeconds?: number }): Promise<void> {
    await this.db.query(
      `UPDATE dispatch_job
          SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL,
              available_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id = $1`,
      [jobId, opts?.delaySeconds ?? 0]
    );
  }

  async fail(jobId: string, error?: string): Promise<void> {
    await this.db.query(
      `UPDATE dispatch_job
          SET status = 'failed', lease_expires_at = NULL, last_error = $2, updated_at = now()
        WHERE id = $1`,
      [jobId, error ?? null]
    );
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
