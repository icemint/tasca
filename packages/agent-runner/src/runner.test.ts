import { describe, it, expect, vi } from 'vitest';
import type { DispatchJob, DispatchJobInput, DispatchQueue } from '@tasca/db';
import type { CredentialBroker } from '@tasca/broker';
import { createRunner, type ExecuteOutcome, type ExecuteJob } from './index';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

class FakeQueue implements DispatchQueue {
  jobs: DispatchJob[] = [];
  completed: Array<{ id: string; fence: number }> = [];
  released: Array<{ id: string; fence: number }> = [];
  failed: Array<{ id: string; fence: number; error?: string }> = [];
  renewed: Array<{ id: string; fence: number }> = [];
  enqueue(_: DispatchJobInput): Promise<{ id: string }> {
    return Promise.resolve({ id: 'x' });
  }
  claimNext(): Promise<DispatchJob | null> {
    return Promise.resolve(this.jobs.shift() ?? null);
  }
  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }
  renewLease(id: string, fence: number): Promise<boolean> {
    this.renewed.push({ id, fence });
    return Promise.resolve(true);
  }
  completedResults: Array<{ id: string; fence: number; result?: Record<string, unknown> }> = [];
  complete(id: string, fence: number, result?: Record<string, unknown>): Promise<boolean> {
    this.completed.push({ id, fence });
    this.completedResults.push({ id, fence, ...(result ? { result } : {}) });
    return Promise.resolve(true);
  }
  release(id: string, fence: number): Promise<boolean> {
    this.released.push({ id, fence });
    return Promise.resolve(true);
  }
  fail(id: string, fence: number, error?: string): Promise<boolean> {
    this.failed.push({ id, fence, ...(error ? { error } : {}) });
    return Promise.resolve(true);
  }
  reclaimExpired(): Promise<number> {
    return Promise.resolve(0);
  }
  // Cancel seam: by default the runner wins the point-of-no-return (beginPublish true) and
  // no cancel is requested. Tests override `beginPublishResult` to exercise the cancel path.
  beginPublishResult = true;
  beginPublished: Array<{ id: string; fence: number }> = [];
  beginPublish(id: string, fence: number): Promise<boolean> {
    this.beginPublished.push({ id, fence });
    return Promise.resolve(this.beginPublishResult);
  }
  requestCancel(): Promise<'removed' | 'signalled' | 'too_late'> {
    return Promise.resolve('too_late');
  }
  requestCancelForTask(): Promise<'removed' | 'signalled' | 'too_late' | 'no_job'> {
    return Promise.resolve('no_job');
  }
  // Reaper-side methods — unused by the runner, present to satisfy the interface.
  sweepExpired(): Promise<{ reclaimed: number; failedOver: number }> {
    return Promise.resolve({ reclaimed: 0, failedOver: 0 });
  }
  claimFinished(): Promise<never[]> {
    return Promise.resolve([]);
  }
  markReaped(): Promise<void> {
    return Promise.resolve();
  }
}

function job(over: Partial<DispatchJob> = {}): DispatchJob {
  return { id: 'job-1', taskId: 't1', payload: { repoRef: 'acme/widgets' }, attempts: 1, fence: 7, ...over };
}

const brokerThatMints = (token = 'scoped-tok'): { broker: CredentialBroker; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    broker: {
      mintRepoToken: async (repoRef: string) => {
        calls.push(repoRef);
        return { token, expiresAt: Date.now() + 3_600_000 };
      },
    },
  };
};

function setup(over: { execute?: ExecuteJob; jobs?: DispatchJob[] } = {}) {
  const queue = new FakeQueue();
  queue.jobs = over.jobs ?? [job()];
  const { broker, calls: brokerCalls } = brokerThatMints();
  const revoked: string[] = [];
  const execute = vi.fn(over.execute ?? (async (): Promise<ExecuteOutcome> => ({ ok: true })));
  const runner = createRunner({
    queue,
    broker,
    execute,
    runnerId: 'runner-A',
    revoke: async (t: string) => {
      revoked.push(t);
    },
    pollIntervalMs: 5,
  });
  return { queue, runner, execute, revoked, brokerCalls };
}

describe('agent-runner — the claim → scoped token → execute → revoke lifecycle', () => {
  it('claims a job, mints a SCOPED token for its repo, executes, completes (fence threaded), and REVOKES the token', async () => {
    const { queue, runner, execute, revoked, brokerCalls } = setup();
    expect(await runner.runOnce()).toBe(true);
    expect(brokerCalls).toEqual(['acme/widgets']); // token scoped to the job's repo
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.completed).toEqual([{ id: 'job-1', fence: 7 }]); // fence carried through
    expect(revoked).toEqual(['scoped-tok']); // token revoked after the task
  });

  it('REVOKES the token even when the task fails (the credential never outlives the task)', async () => {
    const { queue, runner, revoked } = setup({ execute: async () => ({ ok: false, retry: false, error: 'boom' }) });
    await runner.runOnce();
    expect(queue.failed).toEqual([{ id: 'job-1', fence: 7, error: 'boom' }]);
    expect(revoked).toEqual(['scoped-tok']); // still revoked
  });

  it('REVOKES the token even when execute THROWS, and releases the job for retry', async () => {
    const { queue, runner, revoked } = setup({
      execute: async () => {
        throw new Error('unexpected');
      },
    });
    await runner.runOnce();
    expect(queue.released).toEqual([{ id: 'job-1', fence: 7 }]);
    expect(revoked).toEqual(['scoped-tok']);
  });

  it('a transient failure (retry:true) releases the job; a terminal one fails it', async () => {
    const a = setup({ execute: async () => ({ ok: false, retry: true, error: 'transient' }) });
    await a.runner.runOnce();
    expect(a.queue.released).toHaveLength(1);
    expect(a.queue.failed).toHaveLength(0);
  });

  it('an invalid payload (no repoRef) fails the job WITHOUT minting a token (nothing to revoke)', async () => {
    const { queue, runner, execute, revoked, brokerCalls } = setup({ jobs: [job({ payload: { nope: 1 } })] });
    await runner.runOnce();
    expect(brokerCalls).toEqual([]); // never asked the broker
    expect(execute).not.toHaveBeenCalled();
    expect(queue.failed[0]).toMatchObject({ id: 'job-1', fence: 7 });
    expect(revoked).toEqual([]); // no token was minted
  });

  it('runOnce returns false on an empty queue (the loop then backs off)', async () => {
    const { runner } = setup({ jobs: [] });
    expect(await runner.runOnce()).toBe(false);
  });

  it('a CANCELLED outcome writes NOTHING back to the queue but ALWAYS revokes the token', async () => {
    // The job is already `cancelled` in the queue (the operator won the row). The runner must
    // not complete/release/fail it (those would fight the cancel), and must still revoke.
    const { queue, runner, revoked } = setup({ execute: async () => ({ ok: false, cancelled: true }) });
    await runner.runOnce();
    expect(queue.completed).toEqual([]);
    expect(queue.released).toEqual([]);
    expect(queue.failed).toEqual([]);
    expect(revoked).toEqual(['scoped-tok']); // token revoked on a cancel-win
  });

  it('execute that throws AFTER beginPublish (openPr failed) → catch releases for re-drive + revokes the token', async () => {
    // The point-of-no-return was passed (beginPublish called), then openPr threw. The
    // runner's catch must still requeue (release) the now-`publishing` job and revoke.
    const { queue, runner, revoked } = setup({
      execute: async (_job, _payload, _token, control) => {
        await control.beginPublish();
        throw new Error('openPr failed: network');
      },
    });
    await runner.runOnce();
    expect(queue.beginPublished).toEqual([{ id: 'job-1', fence: 7 }]);
    expect(queue.released).toEqual([{ id: 'job-1', fence: 7 }]); // requeued via the catch path
    expect(queue.completed).toEqual([]);
    expect(revoked).toEqual(['scoped-tok']); // token always revoked
  });

  it('threads beginPublish (the point-of-no-return gate) to execute with the job id + fence', async () => {
    const { queue, runner } = setup({
      // A custom execute that exercises the injected gate, like the real one does before openPr.
      execute: async (_job, _payload, _token, control) => {
        const won = await control.beginPublish();
        return won ? { ok: true } : { ok: false, cancelled: true };
      },
    });
    await runner.runOnce();
    expect(queue.beginPublished).toEqual([{ id: 'job-1', fence: 7 }]); // delegated with the job fence
    expect(queue.completed).toHaveLength(1); // beginPublish won (default true) → completed
  });
});

describe('agent-runner — observability of the security-relevant failure signals', () => {
  it('logs when a token revoke FAILS (the token then self-expires at the 1h cap — never silent)', async () => {
    const queue = new FakeQueue();
    queue.jobs = [job()];
    const { broker } = brokerThatMints();
    const errors: string[] = [];
    const runner = createRunner({
      queue,
      broker,
      execute: async () => ({ ok: true }),
      runnerId: 'r',
      revoke: async () => false, // revoke failed
      logger: { error: (m) => errors.push(m) },
    });
    await runner.runOnce();
    expect(errors.some((m) => /revoke failed/.test(m))).toBe(true);
  });

  it('logs when a write is FENCED OUT (lease lost → another runner reclaimed the job)', async () => {
    const queue = new FakeQueue();
    queue.jobs = [job()];
    queue.complete = async () => false; // fenced out: we lost the lease mid-execute
    const { broker } = brokerThatMints();
    const errors: string[] = [];
    const runner = createRunner({
      queue,
      broker,
      execute: async () => ({ ok: true }),
      runnerId: 'r',
      revoke: async () => {},
      logger: { error: (m) => errors.push(m) },
    });
    await runner.runOnce();
    expect(errors.some((m) => /lost the lease before complete/.test(m))).toBe(true);
  });
});

describe('agent-runner — lease heartbeat keeps a long task alive', () => {
  it('renews the lease while a slow execute runs (so it is not reclaimed)', async () => {
    const queue = new FakeQueue();
    queue.jobs = [job()];
    const { broker } = brokerThatMints();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = createRunner({
      queue,
      broker,
      execute: async () => {
        await gate; // hold the task open
        return { ok: true };
      },
      runnerId: 'r',
      leaseSeconds: 2, // heartbeat ~ every 1s
      revoke: async () => {},
    });
    const p = runner.runOnce();
    await new Promise((r) => setTimeout(r, 1200)); // past one heartbeat interval
    expect(queue.renewed.length).toBeGreaterThanOrEqual(1);
    expect(queue.renewed[0]).toMatchObject({ id: 'job-1', fence: 7 });
    release();
    await p;
  });
});
