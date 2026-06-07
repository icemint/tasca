// @tasca/execution — the ExecutionPort contract.
//
// A clean, Electron-free seam over the vendored execution core. Consumers
// (the coordination server) depend only on this interface; the concrete
// implementation in `factory.ts` bridges to the vendored modules at runtime.
//
// Types flow from @tasca/domain / @tasca/contracts only — this package must
// NOT import routing/adapters/coordination (Stage-1 scaffold §1.3 boundary).

import type { Task } from '@tasca/domain';

/** An isolated git worktree reserved for one task's execution. */
export interface Worktree {
  /** Absolute path to the worktree checkout. */
  path: string;
  /** The branch the worktree is checked out on (e.g. `tasca/<task>`). */
  branch: string;
  /** The originating project/repo path the worktree was created from. */
  repoPath: string;
}

/** Parameters for reserving/creating an isolated worktree off a base ref. */
export interface ReserveWorktreeInput {
  /** Absolute path to the source git repository. */
  repoPath: string;
  /** A human-readable task label; used to derive the branch name. */
  taskLabel: string;
  /** Internal project identifier (persisted alongside the worktree). */
  projectId: string;
  /** Base ref to branch from (defaults to the repo's default branch). */
  baseRef?: string;
}

/** A spawned agent command running inside a worktree via a PTY. */
export interface AgentProcessHandle {
  /** PTY process id, when available. */
  pid: number | undefined;
  /** Subscribe to streamed stdout/stderr chunks. */
  onData(listener: (chunk: string) => void): void;
  /** Fires once when the process exits. */
  onExit(listener: (code: number, signal?: number) => void): void;
  /** Fires on a spawn/transport error. */
  onError(listener: (err: Error) => void): void;
  /** Terminate the process. */
  kill(signal?: string): void;
}

/** Parameters for spawning an agent command in a worktree. */
export interface SpawnAgentInput {
  /** Stable id for the lifecycle PTY (used for bookkeeping/kill). */
  id: string;
  /** The shell command to run (e.g. the provider CLI argv joined). */
  command: string;
  /** Working directory — normally a reserved worktree path. */
  cwd: string;
  /** Extra environment for the spawned process (merged over the parent env). */
  env?: Record<string, string>;
}

/** Parameters for opening a pull request from a worktree branch. */
export interface OpenPrInput {
  /** Worktree (or repo) directory the push/PR runs from. */
  cwd: string;
  /** Local branch (in `cwd`) whose commits are pushed. */
  branch: string;
  /**
   * Deterministic remote head branch to push to + open the PR from. When set, the
   * local `branch` is pushed to this ref (`branch:headBranch`) so the PR head is
   * STABLE across re-drives — the worktree's local branch carries a random suffix
   * per attempt, which would otherwise let a re-drive open a SECOND PR. Defaults
   * to `branch` (legacy behavior) when omitted.
   */
  headBranch?: string;
  /** PR title. */
  title: string;
  /** PR body (Markdown). */
  body?: string;
  /** Base branch for the PR (defaults to the repo default). */
  base?: string;
  /** Remote to push to (defaults to `origin`). */
  remote?: string;
}

/** Result of an open-PR attempt. */
export interface OpenPrResult {
  /** The created PR URL (parsed from `gh` stdout). */
  url: string;
}

/**
 * The execution capability surface proven by the de-Electron spike:
 *   - reserve/create an isolated worktree,
 *   - spawn an agent command over a PTY (onData/onExit transport),
 *   - open a PR (git push + gh pr create — pure shell),
 *   - initialize the local SQLite store.
 *
 * Every method is Electron-free.
 */
export interface ExecutionPort {
  /** Apply migrations and ready the local SQLite store. Idempotent. */
  initDb(): Promise<void>;

  /** Reserve/create an isolated worktree for a task. */
  reserveWorktree(input: ReserveWorktreeInput): Promise<Worktree>;

  /** Spawn an agent command inside a worktree, streaming via callbacks. */
  spawnAgent(input: SpawnAgentInput): AgentProcessHandle;

  /** Push the worktree branch and open a PR (pure shell; no Electron). */
  openPr(input: OpenPrInput): Promise<OpenPrResult>;

  /** Release resources (close the DB client, etc.). */
  close(): Promise<void>;
}

/** Optional context carried through execution; mirrors a domain Task slice. */
export type ExecutionTaskRef = Pick<Task, 'id' | 'repoRef'>;
