// The runner's REAL execute: clone (scoped-token env-auth, tokenless origin) → spawn
// the agent → commit → open the PR, all through the ExecutionPort. The credential
// isolation the worker proved in #230 carries over to the runner BY CONSTRUCTION:
//   - prepareScopedWorktree keeps the token out of .git/config (env-auth only), so the
//     agent's Bash can read no credential from the worktree it runs in;
//   - ExecutionPort.spawnAgent runs the agent under spawnWithScrubbedEnv, so the
//     agent's process env carries NO scoped token and NO broker socket path;
//   - ExecutionPort.openPr authenticates the push/gh via env-auth + GH_TOKEN — the
//     token never reaches argv.
// The runner holds a weaker (one-repo, task-lived) token than the worker's master key,
// but a prompt-injected agent still cannot read even that token from its context.

import {
  prepareScopedWorktree as defaultPrepareWorktree,
  type ExecutionPort,
  type PrepareWorktreeInput,
  type PreparedWorktree,
  type SpawnAgentInput,
} from '@tasca/execution';
import type { ExecuteJob, ExecuteOutcome, RunnerLogger } from './runner';

export interface RunnerExecuteDeps {
  execution: ExecutionPort;
  /** Filesystem root for clones + worktrees (a private volume in prod). */
  reposDir: string;
  /** Max wall-clock for one agent run before it's killed. Default 600000ms. */
  agentTimeoutMs?: number;
  /** Clone+worktree (injectable for tests); defaults to the real env-auth clone. */
  prepareWorktree?: (input: PrepareWorktreeInput) => Promise<PreparedWorktree>;
  logger?: RunnerLogger;
}

const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

export function makeRunnerExecute(deps: RunnerExecuteDeps): ExecuteJob {
  const timeoutMs = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const prepareWorktree = deps.prepareWorktree ?? defaultPrepareWorktree;
  return async (job, payload, token): Promise<ExecuteOutcome> => {
    // 1. Clone + worktree using the SCOPED token via env-auth (never persisted).
    let worktree;
    try {
      worktree = await prepareWorktree({
        repoRef: payload.repoRef,
        token: token.token,
        reposDir: deps.reposDir,
        taskLabel: payload.externalStoryId,
      });
    } catch (err) {
      // Transient infra (clone/network) → retry; the breaker/attempts bound it.
      return { ok: false, retry: true, error: `prepare worktree failed: ${errMsg(err)}` };
    }

    // 2. Spawn the agent. ExecutionPort scrubs the child env (no token, no broker
    //    socket). The prompt is the only attacker-influenced value; the factory
    //    POSIX-quotes it into the claude command.
    try {
      await spawnAndAwait(deps.execution, { id: payload.taskId, prompt: payload.prompt, cwd: worktree.worktreePath }, timeoutMs);
    } catch (err) {
      return { ok: false, retry: true, error: `agent run failed: ${errMsg(err)}` };
    }

    // 3. Commit whatever the agent left; never open an empty PR.
    const work = await deps.execution.commitAgentWork({
      cwd: worktree.worktreePath,
      message: `Tasca: ${payload.externalStoryId}`,
      baseRef: worktree.baseRef,
    });
    if (!work.changed) {
      return { ok: false, retry: false, error: 'agent produced no committed changes' };
    }

    // 4. Open the PR with the SCOPED token (env-auth push + gh GH_TOKEN; not in argv).
    //    The deterministic head makes a re-drive idempotent (no duplicate PR).
    const pr = await deps.execution.openPr({
      cwd: worktree.worktreePath,
      branch: worktree.branch,
      headBranch: payload.headBranch,
      title: `Tasca: ${payload.externalStoryId}`,
      token: token.token,
    });

    deps.logger?.info?.('agent-runner: PR opened', { jobId: job.id, taskId: payload.taskId, url: pr.url });
    // The PR url is the runner's result, written back to the QUEUE only (the reaper —
    // coordination-side — records it + finalizes; the runner never touches coordination
    // tables).
    return { ok: true, result: { prUrl: pr.url } };
  };
}

/** Spawn the agent over the PTY and resolve when it exits cleanly; reject on a non-zero
 *  exit, a real transport error, or a timeout. EIO/EPIPE on the PTY master during child
 *  teardown is a benign Linux race — treat it as success and let commitAgentWork be the
 *  source of truth. (Mirrors coordination's runAgentToCompletion.) */
function spawnAndAwait(execution: ExecutionPort, input: SpawnAgentInput, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // spawnAgent can throw SYNCHRONOUSLY before any handle exists — the executor throw
    // rejects this promise, which is what we want.
    const handle = execution.spawnAgent(input);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          execution.killAgent(input.id);
        } catch {
          // best-effort reap; we're failing the run regardless
        }
        reject(new Error(`agent run timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    handle.onError((err: Error) => {
      const code = (err as { code?: string }).code;
      if (code === 'EIO' || code === 'EPIPE') finish(resolve);
      else finish(() => reject(err));
    });
    handle.onExit((code: number) => {
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(`agent exited with code ${code}`)));
    });
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
