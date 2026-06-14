import { describe, it, expect } from 'vitest';
import type { TaskStatus } from '@tasca/domain';
import type { VerifiedEvent } from '@tasca/contracts';
import {
  makeGitHubMergeHandler,
  type MergeHandlerStore,
  type MergedPrParser,
} from './github-merge';

// Unit tests for the PR-merge → task-done side-handler. Hand-rolled fakes for the
// store (real in-memory state) and the parser (drives the merge signal); no live
// GitHub, no Postgres. Verifies: a PR found in `in_review` → merged + done; a PR not
// recorded → no-op; a task already `done` → no-op no-throw; a task not in `in_review`
// → skipped; the resolved org (cross-org) is the one written.

const PR_URL = 'https://github.com/icemint/demo/pull/7';

interface TaskState {
  orgId: string;
  taskId: string;
  status: TaskStatus;
}

/** A fake store backed by a single PR→(org,task) row + a task status map. Records
 *  the markPullRequestMerged + setStatus calls so tests assert what was written. */
function fakeStore(opts: {
  /** The PR row to resolve, or null to simulate a PR Tasca did not open. */
  pr: { orgId: string; taskId: string } | null;
  /** The task's current status (when the PR resolves to a known task). */
  task?: TaskState | null;
}): MergeHandlerStore & { merged: string[]; transitions: Array<{ orgId: string; taskId: string; status: TaskStatus }> } {
  const merged: string[] = [];
  const transitions: Array<{ orgId: string; taskId: string; status: TaskStatus }> = [];
  return {
    merged,
    transitions,
    async getTaskIdByPullRequestUrl(url) {
      return url === PR_URL ? opts.pr : null;
    },
    async getTask(orgId, taskId) {
      const t = opts.task;
      if (!t || t.orgId !== orgId || t.taskId !== taskId) return null;
      return { status: t.status };
    },
    async markPullRequestMerged(orgId, url) {
      merged.push(`${orgId}:${url}`);
    },
    async setStatus(orgId, taskId, status) {
      // Mirror the real store's terminal guard so a test that wrongly reaches here on a
      // `done` task fails loudly rather than silently passing.
      const cur = opts.task?.status;
      if (cur === 'done' && status === 'done') {
        throw new Error('setStatus: illegal transition done -> done');
      }
      transitions.push({ orgId, taskId, status });
    },
  };
}

/** A parser that returns a fixed merge signal (or null for a non-merge body). */
function fakeParser(result: { prUrl: string } | null): MergedPrParser {
  return { parseMergedPr: (_v: VerifiedEvent) => result };
}

const silentLogger = { error() {}, info() {} };

describe('makeGitHubMergeHandler', () => {
  it('advances an in_review task to done and marks its PR merged (resolved org)', async () => {
    const store = fakeStore({
      pr: { orgId: 'org-A', taskId: 'task-1' },
      task: { orgId: 'org-A', taskId: 'task-1', status: 'in_review' },
    });
    const handler = makeGitHubMergeHandler({
      store,
      parser: fakeParser({ prUrl: PR_URL }),
      logger: silentLogger,
    });

    await handler('{}');

    expect(store.merged).toEqual(['org-A:' + PR_URL]);
    expect(store.transitions).toEqual([{ orgId: 'org-A', taskId: 'task-1', status: 'done' }]);
  });

  it('no-ops when the event is not a merge (parser returns null)', async () => {
    const store = fakeStore({
      pr: { orgId: 'org-A', taskId: 'task-1' },
      task: { orgId: 'org-A', taskId: 'task-1', status: 'in_review' },
    });
    const handler = makeGitHubMergeHandler({
      store,
      parser: fakeParser(null),
      logger: silentLogger,
    });

    await handler('{}');

    expect(store.merged).toEqual([]);
    expect(store.transitions).toEqual([]);
  });

  it('no-ops on a merge for a PR Tasca did not open (no recorded row)', async () => {
    const store = fakeStore({ pr: null });
    const handler = makeGitHubMergeHandler({
      store,
      parser: fakeParser({ prUrl: PR_URL }),
      logger: silentLogger,
    });

    await handler('{}');

    expect(store.merged).toEqual([]);
    expect(store.transitions).toEqual([]);
  });

  it('records the merge but does NOT advance a task already done — a duplicate redelivery (no throw)', async () => {
    const store = fakeStore({
      pr: { orgId: 'org-A', taskId: 'task-1' },
      task: { orgId: 'org-A', taskId: 'task-1', status: 'done' },
    });
    const handler = makeGitHubMergeHandler({
      store,
      parser: fakeParser({ prUrl: PR_URL }),
      logger: silentLogger,
    });

    await expect(handler('{}')).resolves.toBeUndefined();
    // The merge is recorded durably (idempotent), but the done→done advance is NOT attempted, so the
    // terminal guard is never hit — a clean no-op.
    expect(store.merged).toEqual(['org-A:' + PR_URL]);
    expect(store.transitions).toEqual([]);
  });

  it('records the merge but does NOT advance a task that left in_review (e.g. executing, or operator-escalated)', async () => {
    const store = fakeStore({
      pr: { orgId: 'org-A', taskId: 'task-1' },
      task: { orgId: 'org-A', taskId: 'task-1', status: 'executing' },
    });
    const handler = makeGitHubMergeHandler({
      store,
      parser: fakeParser({ prUrl: PR_URL }),
      logger: silentLogger,
    });

    await handler('{}');

    // The merge fact is durably recorded on the PR row regardless of the task's status (so an escalated
    // task's merge isn't lost), but only an in_review task is advanced.
    expect(store.merged).toEqual(['org-A:' + PR_URL]);
    expect(store.transitions).toEqual([]);
  });

  it('skips when the resolved task has vanished (getTask returns null)', async () => {
    const store = fakeStore({ pr: { orgId: 'org-A', taskId: 'task-gone' }, task: null });
    const handler = makeGitHubMergeHandler({
      store,
      parser: fakeParser({ prUrl: PR_URL }),
      logger: silentLogger,
    });

    await handler('{}');

    expect(store.merged).toEqual([]);
    expect(store.transitions).toEqual([]);
  });
});
