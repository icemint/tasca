import { describe, it, expect, vi } from 'vitest';
import type { DispatchJob, DispatchJobInput, DispatchQueue } from '@tasca/db';
import type { CredentialBroker } from '@tasca/broker';
import { createRunner, type ExecuteOutcome } from './index';

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
  renewLease(id: string, fence: number): Promise<boolean> {
    this.renewed.push({ id, fence });
    return Promise.resolve(true);
  }
  complete(id: string, fence: number): Promise<boolean> {
    this.completed.push({ id, fence });
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

function setup(over: { execute?: () => Promise<ExecuteOutcome>; jobs?: DispatchJob[] } = {}) {
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
