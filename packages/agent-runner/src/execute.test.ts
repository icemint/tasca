import { describe, it, expect, vi } from 'vitest';
import type {
  AgentProcessHandle,
  CommitAgentWorkInput,
  ExecutionPort,
  OpenPrInput,
  PrepareWorktreeInput,
  SpawnAgentInput,
} from '@tasca/execution';
import type { DispatchJob } from '@tasca/db';
import type { RepoToken } from '@tasca/broker';
import { makeRunnerExecute } from './execute';
import type { DispatchPayload } from './runner';

// A spawn handle that fires onExit(code) once a microtask later.
function handleExiting(code: number): AgentProcessHandle {
  const exitCbs: Array<(c: number) => void> = [];
  queueMicrotask(() => exitCbs.forEach((cb) => cb(code)));
  return {
    pid: 1,
    onData() {},
    onExit(cb) {
      exitCbs.push(cb);
    },
    onError() {},
    kill() {},
  };
}

function fakeExecution(over: Partial<ExecutionPort> = {}): {
  execution: ExecutionPort;
  spawns: SpawnAgentInput[];
  commits: CommitAgentWorkInput[];
  prs: OpenPrInput[];
} {
  const spawns: SpawnAgentInput[] = [];
  const commits: CommitAgentWorkInput[] = [];
  const prs: OpenPrInput[] = [];
  const execution: ExecutionPort = {
    async initDb() {},
    async reserveWorktree() {
      throw new Error('unused');
    },
    spawnAgent(input) {
      spawns.push(input);
      return handleExiting(0);
    },
    killAgent() {},
    async openPr(input) {
      prs.push(input);
      return { url: 'https://github.com/acme/widgets/pull/7' };
    },
    async commitAgentWork(input) {
      commits.push(input);
      return { changed: true };
    },
    async close() {},
    ...over,
  };
  return { execution, spawns, commits, prs };
}

const PAYLOAD: DispatchPayload = {
  taskId: 'task-1',
  repoRef: 'acme/widgets',
  externalStoryId: 'acme/widgets#5',
  prompt: 'Fix the bug',
  headBranch: 'tasca/acme-widgets-5-abc123',
};
const JOB: DispatchJob = { id: 'job-1', taskId: 'task-1', payload: PAYLOAD, attempts: 1, fence: 1 };
const TOKEN: RepoToken = { token: 'ghs_scoped', expiresAt: Date.now() + 3_600_000 };

const fakePrepare = (over: Partial<{ worktreePath: string; branch: string; baseRef: string }> = {}) =>
  vi.fn(async (_input: PrepareWorktreeInput) => ({
    worktreePath: '/wt',
    branch: 'tasca-wt/x',
    baseRef: 'origin/main',
    ...over,
  }));

describe('makeRunnerExecute — clone → spawn → commit → openPr with the scoped token', () => {
  it('runs the full flow and returns the PR url; threads the SCOPED token to git auth', async () => {
    const { execution, spawns, commits, prs } = fakeExecution();
    const prepareWorktree = fakePrepare();
    const execute = makeRunnerExecute({ execution, reposDir: '/repos', prepareWorktree });

    const outcome = await execute(JOB, PAYLOAD, TOKEN);

    expect(outcome).toEqual({ ok: true, result: { prUrl: 'https://github.com/acme/widgets/pull/7' } });
    // the worktree is prepared with the scoped token (env-auth happens inside prepare)
    expect(prepareWorktree).toHaveBeenCalledWith({ repoRef: 'acme/widgets', token: 'ghs_scoped', reposDir: '/repos', taskLabel: 'acme/widgets#5' });
    // the agent runs in the prepared worktree
    expect(spawns[0]).toMatchObject({ id: 'task-1', cwd: '/wt', prompt: 'Fix the bug' });
    // commit checks against the base
    expect(commits[0]).toMatchObject({ cwd: '/wt', baseRef: 'origin/main' });
    // the PR push carries the SCOPED token (ExecutionPort.openPr does env-auth, token NOT in argv)
    expect(prs[0]).toMatchObject({ cwd: '/wt', branch: 'tasca-wt/x', headBranch: 'tasca/acme-widgets-5-abc123', token: 'ghs_scoped' });
  });

  it('SECURITY: the agent spawn input carries NO token and NO broker socket', async () => {
    const { execution, spawns } = fakeExecution();
    await makeRunnerExecute({ execution, reposDir: '/repos', prepareWorktree: fakePrepare() })(JOB, PAYLOAD, TOKEN);
    const spawnInput = spawns[0]!;
    const serialized = JSON.stringify(spawnInput);
    expect(serialized).not.toContain('ghs_scoped'); // no token in the spawn surface
    expect(serialized).not.toContain('BROKER'); // no broker socket path
    // env is not set by the runner (ExecutionPort.spawnAgent scrubs it to the allowlist).
    expect(spawnInput.env).toBeUndefined();
  });

  it('no committed change → terminal fail, no PR opened', async () => {
    const { execution, prs } = fakeExecution({ async commitAgentWork() { return { changed: false }; } });
    const outcome = await makeRunnerExecute({ execution, reposDir: '/r', prepareWorktree: fakePrepare() })(JOB, PAYLOAD, TOKEN);
    expect(outcome).toEqual({ ok: false, retry: false, error: 'agent produced no committed changes' });
    expect(prs).toHaveLength(0);
  });

  it('a clone failure is a RETRYABLE outcome (transient infra)', async () => {
    const prepareWorktree = vi.fn(async () => {
      throw new Error('network down');
    });
    const outcome = await makeRunnerExecute({ execution: fakeExecution().execution, reposDir: '/r', prepareWorktree })(JOB, PAYLOAD, TOKEN);
    expect(outcome).toMatchObject({ ok: false, retry: true });
  });

  it('a non-zero agent exit is a retryable failure (no PR)', async () => {
    const { execution, prs } = fakeExecution({
      spawnAgent(input) {
        return handleExiting(1); // non-zero exit
      },
    });
    const outcome = await makeRunnerExecute({ execution, reposDir: '/r', prepareWorktree: fakePrepare() })(JOB, PAYLOAD, TOKEN);
    expect(outcome).toMatchObject({ ok: false, retry: true });
    expect(prs).toHaveLength(0);
  });
});
