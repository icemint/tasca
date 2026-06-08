// Clone-on-dispatch for the agent-runner: turn a GitHub `owner/repo` + a SCOPED token
// into a worktree the agent runs in — with the SAME credential isolation the worker
// proved in #230. The origin is TOKENLESS (`https://github.com/<owner>/<repo>.git`);
// the token authenticates the one clone/fetch child via an http.extraheader injected
// through GIT_CONFIG_* env — NEVER in argv, NEVER persisted into .git/config. So the
// worktree the prompt-injected agent runs in carries no credential it can read, and
// the local branch is created off the already-fetched `origin/<default>` with no auth.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, rm, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const REPO_REF_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/** Redact any `x-access-token:<secret>@` form before a git error propagates. */
export function redactToken(message: string): string {
  return message
    .replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@')
    .replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
}

/** Env that authenticates ONE git child against github.com via an http.extraheader,
 *  without the token in argv or persisted config. Gone when the child exits. */
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}`,
  };
}

/** Minimal git runner (argv form), injectable for tests. `env` is merged OVER
 *  process.env for the one invocation (env-auth). Redacts the token from any error. */
export type GitRunner = (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<string>;

const defaultGit: GitRunner = async (args, opts) => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return stdout;
  } catch (err) {
    throw new Error(redactToken(err instanceof Error ? err.message : String(err)));
  }
};

const fsExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

export interface PrepareWorktreeInput {
  /** owner/repo. */
  repoRef: string;
  /** The scoped per-task token — used ONLY via env-auth; never persisted. */
  token: string;
  /** Filesystem root under which clones + worktrees live. */
  reposDir: string;
  /** Human label (the story id) used to derive the worktree branch name. */
  taskLabel: string;
  /** Injected git runner (tests); defaults to execFile('git', …) with redaction. */
  git?: GitRunner;
  /** Injected `.git` existence probe (tests). */
  exists?: (p: string) => Promise<boolean>;
}

export interface PreparedWorktree {
  /** Absolute path to the worktree the agent runs in. */
  worktreePath: string;
  /** The per-attempt local branch. */
  branch: string;
  /** Base ref the work is compared against (`origin/<default>`). */
  baseRef: string;
}

/**
 * Clone (tokenless origin, env-auth) or refresh the repo under `reposDir`, then add a
 * fresh worktree off `origin/<default>`. The token rides ONLY the clone/fetch child's
 * env — the resulting `.git/config` origin is tokenless, so the agent's Bash can read
 * no credential from the worktree it runs in.
 */
export async function prepareScopedWorktree(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
  const m = REPO_REF_RE.exec(input.repoRef);
  if (!m) throw new Error(`prepareScopedWorktree: invalid repoRef ${JSON.stringify(input.repoRef)}`);
  const owner = m[1]!;
  const repo = m[2]!;
  const git = input.git ?? defaultGit;
  const exists = input.exists ?? fsExists;

  const localPath = path.join(input.reposDir, owner, repo);
  const originUrl = `https://github.com/${owner}/${repo}.git`; // TOKENLESS
  const authEnv = gitAuthEnv(input.token);

  if (await exists(path.join(localPath, '.git'))) {
    // Existing checkout: re-point origin tokenless (in case an older build embedded a
    // token) and fetch the latest via env-auth.
    await git(['-C', localPath, 'remote', 'set-url', 'origin', originUrl]);
    await git(['-C', localPath, 'fetch', '--prune', 'origin'], { env: authEnv });
  } else {
    // No usable checkout: clear any leftover, clone into a temp dir (env-auth) + rename
    // into place so localPath only appears once the clone is complete.
    await rm(localPath, { recursive: true, force: true });
    await mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const tmp = `${localPath}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await git(['clone', originUrl, tmp], { env: authEnv });
      await rename(tmp, localPath);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  const defaultBranch = await detectDefaultBranch(git, localPath);
  const slug =
    input.taskLabel
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'task';
  const branch = `tasca-wt/${slug}-${randomBytes(4).toString('hex')}`;
  const worktreePath = path.join(input.reposDir, owner, `${repo}.worktrees`, `${slug}-${randomBytes(4).toString('hex')}`);
  await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  // LOCAL branch off the already-fetched remote default — no network, no auth.
  await git(['-C', localPath, 'worktree', 'add', '--no-track', '-b', branch, worktreePath, `origin/${defaultBranch}`]);

  return { worktreePath, branch, baseRef: `origin/${defaultBranch}` };
}

async function detectDefaultBranch(git: GitRunner, localPath: string): Promise<string> {
  const out = (await git(['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!out || out === 'HEAD') {
    const sym = (await git(['-C', localPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    return sym.replace(/^origin\//, '') || 'main';
  }
  return out;
}
