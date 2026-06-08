// The agent-runner: the execution-side composition root, the mirror of coordination
// across the dispatch-queue seam. It poll-claims a dispatch_job (exactly-once via the
// queue's FOR UPDATE SKIP LOCKED), mints a per-task repo-scoped token from the broker
// (NEVER the master key — that stays in the worker), runs the agent for that one job,
// then ALWAYS revokes the token. It holds no worker secret: a Postgres URL for the
// queue, a unix-socket path for the broker, and whatever the injected `execute` needs.

import type { DispatchJob, DispatchQueue } from '@tasca/db';
import type { CredentialBroker, RepoToken } from '@tasca/broker';
import { revokeToken } from './revoke';

export interface RunnerLogger {
  info?(message: string, ctx?: Record<string, unknown>): void;
  error?(message: string, ctx?: Record<string, unknown>): void;
}

/** What coordination enqueues — what the runner needs to execute. Opaque to the queue
 *  (jsonb); the runner validates the fields it uses. */
export interface DispatchPayload {
  /** owner/repo for the task — the runner asks the broker for a token scoped to it. */
  repoRef: string;
  [k: string]: unknown;
}

/** The outcome of executing one job. `retry:true` releases the job for another attempt
 *  (transient); `retry:false` fails it terminally. */
export type ExecuteOutcome = { ok: true } | { ok: false; retry: boolean; error: string };

/** Run ONE dispatched job with a freshly-minted scoped token. Injected — the real
 *  implementation (clone/worktree/spawn/openPr via the ExecutionPort, using `token`
 *  for git auth) is wired in the enqueue/execute slice. */
export type ExecuteJob = (
  job: DispatchJob,
  payload: DispatchPayload,
  token: RepoToken
) => Promise<ExecuteOutcome>;

export interface RunnerOptions {
  queue: DispatchQueue;
  broker: CredentialBroker;
  execute: ExecuteJob;
  runnerId: string;
  /** Lease per job, renewed mid-execute so a long task isn't reclaimed. Default 600s. */
  leaseSeconds?: number;
  /** Poll cadence when the queue is empty (poll-only — exactly-once is the queue's job). Default 1000ms. */
  pollIntervalMs?: number;
  /** Delay before a released (retry) job becomes claimable again. Default 30s. */
  retryDelaySeconds?: number;
  /** Revoke the scoped token after each task. Default: real GitHub revoke. Injectable for tests. */
  revoke?: (token: string) => Promise<unknown>;
  logger?: RunnerLogger;
}

export interface Runner {
  /** Start the claim loop (idempotent). */
  start(): void;
  /** Stop after the in-flight job; resolves when the loop has exited. */
  stop(): Promise<void>;
  /** Claim + run at most one job. Returns true if one was processed. (The loop + tests use this.) */
  runOnce(): Promise<boolean>;
}

const DEFAULT_LEASE_SECONDS = 600;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_RETRY_DELAY_SECONDS = 30;

export function createRunner(opts: RunnerOptions): Runner {
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const retryDelay = opts.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS;
  const revoke = opts.revoke ?? ((t: string) => revokeToken(t));

  let started = false;
  let stopping = false;
  let loopDone: Promise<void> | null = null;

  async function runOnce(): Promise<boolean> {
    const job = await opts.queue.claimNext(opts.runnerId, leaseSeconds);
    if (!job) return false;

    const payload = job.payload as Partial<DispatchPayload>;
    if (typeof payload?.repoRef !== 'string') {
      // An unworkable payload can never succeed — fail it terminally so the loop
      // doesn't spin on it forever.
      await opts.queue.fail(job.id, job.fence, 'invalid payload: repoRef missing');
      opts.logger?.error?.('runner: invalid job payload', { jobId: job.id });
      return true;
    }

    // Keep the lease alive while execute runs so a long task isn't reclaimed and
    // double-dispatched (the queue's fence makes a late write safe, but renewing
    // avoids the wasted second run).
    const heartbeat = setInterval(() => {
      void opts.queue.renewLease(job.id, job.fence, leaseSeconds).catch(() => {});
    }, Math.max(1000, Math.floor((leaseSeconds * 1000) / 2)));
    (heartbeat as { unref?: () => void }).unref?.();

    let token: RepoToken | null = null;
    try {
      token = await opts.broker.mintRepoToken(payload.repoRef);
      const outcome = await opts.execute(job, payload as DispatchPayload, token);
      if (outcome.ok) {
        await opts.queue.complete(job.id, job.fence);
      } else if (outcome.retry) {
        await opts.queue.release(job.id, job.fence, { delaySeconds: retryDelay });
      } else {
        await opts.queue.fail(job.id, job.fence, outcome.error);
      }
    } catch (err) {
      opts.logger?.error?.('runner: job threw', { jobId: job.id, err: String(err) });
      await opts.queue.release(job.id, job.fence, { delaySeconds: retryDelay }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      // ALWAYS revoke the scoped token (even on failure) so its effective lifetime is
      // this task, not GitHub's ~1h cap. Best-effort — a revoke failure must not throw.
      if (token) {
        await Promise.resolve(revoke(token.token)).catch(() => {});
      }
    }
    return true;
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      let processed = false;
      try {
        processed = await runOnce();
      } catch (err) {
        opts.logger?.error?.('runner: loop iteration failed', { err: String(err) });
      }
      if (!processed && !stopping) await sleep(pollMs);
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopping = false;
      opts.logger?.info?.('agent-runner: started', { runnerId: opts.runnerId });
      loopDone = loop();
    },
    async stop(): Promise<void> {
      stopping = true;
      await loopDone?.catch(() => {});
      started = false;
    },
    runOnce,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}
