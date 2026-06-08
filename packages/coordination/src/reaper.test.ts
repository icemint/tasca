import { describe, it, expect, vi } from 'vitest';
import type { DispatchQueue, FinishedJob, SweepResult } from '@tasca/db';
import type { CoordinationStore } from './store';
import type { StatusReporter } from './ports';
import type { AuditSink } from './orchestrate';
import { makeReaper, type ReaperDeps } from './reaper';

const DONE_PAYLOAD = {
  taskId: 'task-1',
  repoRef: 'acme/widgets',
  platform: 'github' as const,
  externalStoryId: 'acme/widgets#5',
  agentId: 'agent-1',
  prompt: 'x',
  headBranch: 'tasca/x',
};

function doneJob(over: Partial<FinishedJob> = {}): FinishedJob {
  return {
    id: 'job-1',
    taskId: 'task-1',
    payload: DONE_PAYLOAD,
    status: 'done',
    result: { prUrl: 'https://github.com/acme/widgets/pull/7' },
    lastError: null,
    ...over,
  };
}

function failedJob(over: Partial<FinishedJob> = {}): FinishedJob {
  return { id: 'job-2', taskId: 'task-2', payload: DONE_PAYLOAD, status: 'failed', result: null, lastError: 'no committed changes', ...over };
}

/** A queue fake exposing only what the reaper calls; the rest throws if touched. */
function fakeQueue(opts: { finished: FinishedJob[]; sweep?: SweepResult }): { queue: DispatchQueue; reaped: string[]; sweepCalls: number[] } {
  const reaped: string[] = [];
  const sweepCalls: number[] = [];
  let handed = false;
  const queue = {
    async sweepExpired(maxAttempts: number) {
      sweepCalls.push(maxAttempts);
      return opts.sweep ?? { reclaimed: 0, failedOver: 0 };
    },
    async claimFinished() {
      // Hand the batch out once (a second tick sees an empty queue).
      if (handed) return [];
      handed = true;
      return opts.finished;
    },
    async markReaped(jobId: string) {
      reaped.push(jobId);
    },
  } as unknown as DispatchQueue;
  return { queue, reaped, sweepCalls };
}

function fakeStore(over: Partial<CoordinationStore> = {}): { store: CoordinationStore; calls: { setStatus: Array<[string, string]>; recordedPrs: string[]; failures: string[] } } {
  const calls = { setStatus: [] as Array<[string, string]>, recordedPrs: [] as string[], failures: [] as string[] };
  const store = {
    async listPullRequestsForTask() {
      return [];
    },
    async recordPullRequest(input: { taskId: string; url: string }) {
      calls.recordedPrs.push(input.url);
    },
    async recordFailureAndTransition(taskId: string) {
      calls.failures.push(taskId);
      return { failureCount: 1, tripped: false };
    },
    async setStatus(taskId: string, status: string) {
      calls.setStatus.push([taskId, status]);
    },
    ...over,
  } as unknown as CoordinationStore;
  return { store, calls };
}

function baseDeps(queue: DispatchQueue, store: CoordinationStore, over: Partial<ReaperDeps> = {}): { deps: ReaperDeps; status: { posts: unknown[] }; audits: Array<{ action: string }> } {
  const posts: unknown[] = [];
  const audits: Array<{ action: string }> = [];
  const status = { posts };
  const deps: ReaperDeps = {
    queue,
    store,
    status: { async postStatus(u: unknown) { posts.push(u); } } as unknown as StatusReporter,
    audit: { async record(e: { action: string }) { audits.push(e); } } as AuditSink,
    principalIdFor: async () => 'principal-1',
    ...over,
  };
  return { deps, status, audits };
}

describe('makeReaper — finalizes runner-completed jobs from the coordination side', () => {
  it('a DONE job: records the PR, posts status-back + advances to in_review, then reaps the job', async () => {
    const { queue, reaped } = fakeQueue({ finished: [doneJob()] });
    const { store, calls } = fakeStore();
    const { deps, status, audits } = baseDeps(queue, store);

    const res = await makeReaper(deps).tick();

    expect(res.finalizedDone).toBe(1);
    expect(calls.recordedPrs).toEqual(['https://github.com/acme/widgets/pull/7']);
    expect(calls.setStatus).toContainEqual(['task-1', 'in_review']);
    expect(status.posts).toHaveLength(1); // status-back posted
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['pr.create', 'status.post']));
    expect(reaped).toEqual(['job-1']); // deleted after finalize
  });

  it('IDEMPOTENT: a DONE job whose PR is already recorded does NOT record a second one (re-tick safe)', async () => {
    const { queue, reaped } = fakeQueue({ finished: [doneJob()] });
    const { store, calls } = fakeStore({
      async listPullRequestsForTask() {
        return [{ url: 'https://github.com/acme/widgets/pull/7' }] as never;
      },
    });
    const { deps } = baseDeps(queue, store);

    await makeReaper(deps).tick();

    expect(calls.recordedPrs).toEqual([]); // not re-recorded
    expect(calls.setStatus).toContainEqual(['task-1', 'in_review']); // still (re)advances
    expect(reaped).toEqual(['job-1']);
  });

  it('a FAILED job drives the task breaker (recordFailureAndTransition) + audits task.failed, then reaps', async () => {
    const { queue, reaped } = fakeQueue({ finished: [failedJob()] });
    const { store, calls } = fakeStore();
    const { deps, audits } = baseDeps(queue, store);

    const res = await makeReaper(deps).tick();

    expect(res.finalizedFailed).toBe(1);
    expect(calls.failures).toEqual(['task-2']);
    expect(audits.map((a) => a.action)).toContain('task.failed');
    expect(calls.recordedPrs).toEqual([]); // no PR on a failed job
    expect(reaped).toEqual(['job-2']);
  });

  it('surfaces the sweep result and passes the attempts cap', async () => {
    const { queue, sweepCalls } = fakeQueue({ finished: [], sweep: { reclaimed: 2, failedOver: 1 } });
    const { store } = fakeStore();
    const { deps } = baseDeps(queue, store, { maxDispatchAttempts: 5 });

    const res = await makeReaper(deps).tick();

    expect(res).toMatchObject({ reclaimed: 2, failedOver: 1, finalizedDone: 0, finalizedFailed: 0 });
    expect(sweepCalls).toEqual([5]); // cap threaded through
  });

  it('a finalize failure leaves the job UN-REAPED (its reaping lease lapses → retried next tick)', async () => {
    const { queue, reaped } = fakeQueue({ finished: [doneJob()] });
    const { store } = fakeStore({
      async recordPullRequest() {
        throw new Error('db down');
      },
    });
    const { deps } = baseDeps(queue, store);

    const res = await makeReaper(deps).tick();

    expect(res.finalizedDone).toBe(0);
    expect(reaped).toEqual([]); // NOT deleted — left for retry, never lost
  });

  it('a DONE job with no PR url is reaped without finalizing (anomaly, not an infinite re-lease)', async () => {
    const { queue, reaped } = fakeQueue({ finished: [doneJob({ result: {} })] });
    const { store, calls } = fakeStore();
    const { deps } = baseDeps(queue, store);

    const res = await makeReaper(deps).tick();

    expect(res.finalizedDone).toBe(1);
    expect(calls.recordedPrs).toEqual([]); // nothing to record
    expect(calls.setStatus).toEqual([]); // finalize skipped
    expect(reaped).toEqual(['job-1']); // still reaped (no infinite re-lease)
  });
});
