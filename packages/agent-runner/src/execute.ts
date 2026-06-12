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
  removeScopedWorktree as defaultRemoveWorktree,
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
  /** Tear down the worktree after the run (injectable for tests); defaults to real. */
  removeWorktree?: (worktree: PreparedWorktree) => Promise<void>;
  logger?: RunnerLogger;
}

const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

export function makeRunnerExecute(deps: RunnerExecuteDeps): ExecuteJob {
  const timeoutMs = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const prepareWorktree = deps.prepareWorktree ?? defaultPrepareWorktree;
  const removeWorktree = deps.removeWorktree ?? ((w: PreparedWorktree) => defaultRemoveWorktree({ localPath: w.localPath, worktreePath: w.worktreePath }));
  return async (job, payload, token, control): Promise<ExecuteOutcome> => {
    // 1. Clone + worktree using the SCOPED token via env-auth (never persisted).
    let worktree: PreparedWorktree;
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

    // Once a worktree exists it MUST be reclaimed — on success, terminal fail, or retry
    // alike — or worktrees pile up on the shared volume until ENOSPC. The token-bearing
    // git work all lives inside this try; the finally tears the worktree down regardless.
    try {
      // 2. Spawn the agent. ExecutionPort scrubs the child env (no token, no broker
      //    socket). The prompt is the only attacker-influenced value; the factory
      //    POSIX-quotes it into the claude command.
      try {
        await spawnAndAwait(deps.execution, { id: payload.taskId, prompt: payload.prompt, cwd: worktree.worktreePath }, timeoutMs, control.signal);
      } catch (err) {
        // An operator cancel aborts the run (the heartbeat trips control.signal). That's a
        // clean interrupt — NOT a retryable failure — so the breaker isn't driven and no PR
        // is opened; the job is already `cancelled` in the queue.
        if (control.signal.aborted) return { ok: false, cancelled: true };
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

      // 3b. POINT OF NO RETURN. Atomically claim the right to finish (claimed→publishing).
      //     If an operator's requestCancel won the row first (→ cancelled) or the claim was
      //     fenced out, beginPublish is false: abort WITHOUT opening a PR. This is the
      //     exactly-one cancel hinge — opening the PR is the irreversible customer action.
      if (!(await control.beginPublish())) {
        return { ok: false, cancelled: true };
      }

      // 4. Open the PR with the SCOPED token (env-auth push + gh GH_TOKEN; not in argv).
      //    The deterministic head makes a re-drive idempotent (no duplicate PR).
      // PROJECTION model (roadmap D8): a github PR carries `Closes #N` so the native merge→issue-close
      // does the transition — the agent's only state-affecting write. Non-github → no closing keyword.
      const closes = payload.platform === 'github' ? /#(\d+)$/.exec(payload.externalStoryId) : null;
      const pr = await deps.execution.openPr({
        cwd: worktree.worktreePath,
        branch: worktree.branch,
        headBranch: payload.headBranch,
        title: `Tasca: ${payload.externalStoryId}`,
        ...(closes ? { body: `Closes #${closes[1]}` } : {}),
        token: token.token,
      });

      deps.logger?.info?.('agent-runner: PR opened', { jobId: job.id, taskId: payload.taskId, url: pr.url });
      // The PR url is the runner's result, written back to the QUEUE only (the reaper —
      // coordination-side — records it + finalizes; the runner never touches coordination
      // tables).
      return { ok: true, result: { prUrl: pr.url } };
    } finally {
      await removeWorktree(worktree).catch((err) => {
        deps.logger?.error?.('agent-runner: worktree teardown failed', { jobId: job.id, err: errMsg(err) });
      });
    }
  };
}

/** Spawn the agent over the PTY and resolve when it exits cleanly; reject on a non-zero
 *  exit, a real transport error, or a timeout. EIO/EPIPE on the PTY master during child
 *  teardown is a benign Linux race — treat it as success and let commitAgentWork be the
 *  source of truth. (Mirrors coordination's runAgentToCompletion.) */
function spawnAndAwait(execution: ExecutionPort, input: SpawnAgentInput, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Already cancelled before the agent even starts — don't spawn.
    if (signal.aborted) {
      reject(new Error('agent run aborted (cancelled before start)'));
      return;
    }
    // spawnAgent can throw SYNCHRONOUSLY before any handle exists — the executor throw
    // rejects this promise, which is what we want.
    const handle = execution.spawnAgent(input);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    // Operator cancel: the runner's heartbeat trips the signal when the claim is lost.
    // Kill the agent immediately and reject — execute maps an aborted signal to `cancelled`.
    const onAbort = (): void => {
      finish(() => {
        try {
          execution.killAgent(input.id);
        } catch {
          // best-effort reap; we're aborting regardless
        }
        reject(new Error('agent run aborted (cancelled)'));
      });
    };
    signal.addEventListener('abort', onAbort);
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
