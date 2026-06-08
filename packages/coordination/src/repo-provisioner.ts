// Clone-on-dispatch: turn a GitHub `owner/repo` slug into a local checkout with a
// TOKENLESS `origin`, plus a worktree for one task's execution, so the dispatch
// loop has a real filesystem repo to work from. A GitHub event's repoHint is a
// slug, not a path; without this the worktree step fails on every
// github-originated dispatch.
//
// Mechanism (pure shell via execFile — argv, never a shell string):
//   1. mint an installation token for the slug's owner
//   2. clone (first time, atomically) or set-url + fetch --prune (subsequent)
//      under reposDir, serialized per owner/repo, with origin = the TOKENLESS
//      `https://github.com/<owner>/<repo>.git`
//   3. authenticate the network git calls (clone/fetch) by injecting an
//      Authorization header into that ONE child via env (githubAuthEnv), never argv
//      or persisted config
//   4. create the task worktree LOCALLY (`git worktree add`), bypassing the vendor
//      worktree path that would `git fetch origin` + pushOnCreate (which the
//      tokenless origin cannot authenticate)
//
// CONCURRENCY: dispatches are detached (server.ts queueMicrotask) and the
// orchestrator's gate keys on the story, not the repo, so two stories targeting
// the same owner/repo can provision concurrently. We serialize per `owner/repo`
// with an in-process async mutex so set-url+fetch is atomic and two first-time
// clones can't collide. The clone is also made atomic (clone into a temp dir +
// rename into place) so a crash mid-clone leaves only an orphan temp dir, never a
// half-populated localPath that `git clone` would later refuse — the dispatch loop
// re-drives on failure, so a non-self-healing clone would wedge the repo forever.
//
// SECURITY — token in logs: even though the origin URL is now tokenless, the
// auth header is supplied via env and execFile's rejection can echo the environment;
// every git call stays wrapped to REDACT any `x-access-token:<secret>` form from a
// thrown error before it propagates into the breaker's error log.
//
// SECURITY — token NOT at rest, NOT reachable by the agent: the credential is
// provided per-invocation via env-auth (an http.extraheader injected through
// GIT_CONFIG_* into the single clone/fetch child), so it is NEVER persisted into
// <localPath>/.git/config and the worktree the agent runs in carries no token in
// any git config it can read. We also create the worktree ourselves (no vendored
// `git fetch`/pushOnCreate), so no authenticated origin is needed downstream — the
// PR push authenticates via its own env-auth in open-pr. We create reposDir mode
// 0700 (owner only) and re-mint a fresh short-lived (~1h) token per dispatch.
// RESIDUAL: a same-user process could read a concurrent git child's env via /proc;
// closing that requires a separate-user / egress sandbox (Phase 2, ops). In
// production set TASCA_REPOS_DIR to a dedicated private volume, not the shared tmp
// root.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, rm, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { RepoProvisioner, ProvisionedRepo } from './orchestrate';

const execFileAsync = promisify(execFile);

/** `owner/repo` — both segments are restricted to GitHub-legal name characters. */
const REPO_REF_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/** Replace any `x-access-token:<secret>@` with a redacted form, so a leaked argv
 *  (execFile attaches it to the rejection) never carries the live token. Exported
 *  so the default git wrapper's redaction is unit-testable without running git. */
export function redactToken(message: string): string {
  return message.replace(/x-access-token:[^@]*@/g, 'x-access-token:***@');
}

/**
 * Env that authenticates ONE git child (clone/fetch) against github.com via an
 * http.extraheader, without putting the token in argv or persisting it into
 * .git/config. `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` inject
 * config into the process for that invocation only (gone when the child exits), so
 * the credential never reaches the worktree the agent runs in. Exported for the
 * unit test + reuse by the open-pr push (which keeps its own local copy — execution
 * must not import @tasca packages).
 */
export function githubAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:' + token).toString('base64')}`,
  };
}

/**
 * The production git runner: `execFile('git', …)` returning stdout, with token
 * redaction on failure. `env` is merged OVER process.env for the one invocation
 * (env-auth). Exported (and used as the default `git` runner) so a test can prove the
 * wrapper WIRES redactToken on a real token-bearing argv — the only remaining way a
 * token could surface, since production now keeps the token out of argv entirely.
 */
export async function defaultGitRunner(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return stdout;
  } catch (err) {
    // execFile's rejection echoes the full argv (incl. any auth URL); redact the
    // token before it propagates into the breaker's error log.
    throw new Error(redactToken(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * The minimal structural deps GitAppRepoProvisioner needs, typed against shapes
 * (not the concrete GitHubAppClient / store classes) so tests inject fakes. The
 * real wiring passes the @tasca/adapters GitHubAppClient + the coordination store.
 */
export interface RepoProvisionerDeps {
  appClient: { getInstallationToken(installationId: string): Promise<{ token: string }> };
  store: { getInstallationIdForOwner(owner: string): Promise<string | null> };
  /** Filesystem root under which clones live as `<reposDir>/<owner>/<repo>`. */
  reposDir: string;
  /** Git runner (argv form) returning stdout. Default: execFile('git', …) with token
   *  redaction. `env` is merged OVER process.env for the one invocation (env-auth). */
  git?: (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<string>;
  /** `.git` existence probe. Default: fs.access-based. */
  exists?: (p: string) => Promise<boolean>;
}

export class GitAppRepoProvisioner implements RepoProvisioner {
  private readonly git: (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<string>;
  private readonly exists: (p: string) => Promise<boolean>;
  /** Per-`owner/repo` promise chain: serializes provisioning of the same repo. */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RepoProvisionerDeps) {
    this.git = deps.git ?? defaultGitRunner;
    this.exists =
      deps.exists ??
      (async (p) => {
        try {
          await access(p);
          return true;
        } catch {
          return false;
        }
      });
  }

  async ensureLocalRepo(repoRef: string): Promise<ProvisionedRepo> {
    const { owner, repo } = parseRef(repoRef); // validates BEFORE any token mint
    return this.withRepoLock(`${owner}/${repo}`, () => this.provision(owner, repo));
  }

  /** A current installation token for the repo's owner (the App client returns its
   *  in-memory cached one while still valid, re-minting near expiry). Used to auth
   *  `gh pr create`; throws when no installation exists. */
  async tokenForRepo(repoRef: string): Promise<string> {
    const { owner } = parseRef(repoRef);
    const installationId = await this.deps.store.getInstallationIdForOwner(owner);
    if (installationId === null) {
      throw new Error('no GitHub App installation for owner ' + owner);
    }
    const { token } = await this.deps.appClient.getInstallationToken(installationId);
    return token;
  }

  /** Resolve installation → mint token → clone-or-refresh. Runs under the per-repo lock. */
  private async provision(owner: string, repo: string): Promise<ProvisionedRepo> {
    const installationId = await this.deps.store.getInstallationIdForOwner(owner);
    if (installationId === null) {
      throw new Error('no GitHub App installation for owner ' + owner);
    }
    const { token } = await this.deps.appClient.getInstallationToken(installationId);

    const localPath = path.join(this.deps.reposDir, owner, repo);
    // The origin URL is TOKENLESS — the credential is never persisted into
    // .git/config (so the agent's worktree can't read it). It is supplied to the
    // single network git child via env-auth (an http.extraheader).
    const originUrl = 'https://github.com/' + owner + '/' + repo + '.git';
    const authEnv = githubAuthEnv(token);

    if (await this.exists(path.join(localPath, '.git'))) {
      // Existing checkout: re-point origin to the tokenless URL (in case an older
      // build embedded a token) and fetch the latest refs via env-auth so the
      // worktree branches off current state.
      await this.git(['-C', localPath, 'remote', 'set-url', 'origin', originUrl]);
      await this.git(['-C', localPath, 'fetch', '--prune', 'origin'], { env: authEnv });
      return { path: localPath, defaultBranch: await this.detectDefaultBranch(localPath) };
    }

    // No usable checkout. Clear any leftover first — a crash mid-clone can leave a
    // non-empty localPath without a complete `.git`, which `git clone` refuses
    // ("destination path already exists and is not an empty directory"), wedging
    // the repo on every re-drive. Then clone into a temp dir and rename into place
    // so localPath only ever appears once the clone is complete.
    await rm(localPath, { recursive: true, force: true });
    await mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const tmp = `${localPath}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await this.git(['clone', originUrl, tmp], { env: authEnv });
      await rename(tmp, localPath);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return { path: localPath, defaultBranch: await this.detectDefaultBranch(localPath) };
  }

  /**
   * Create an isolated worktree for one task off the local clone, returning its
   * path + branch + base ref. We do this ourselves (LOCAL `git worktree add`, no
   * auth) instead of the vendored worktree service, which would `git fetch origin`
   * + pushOnCreate — both need an authenticated origin, which we deliberately no
   * longer have (the origin is tokenless so the agent can't read a credential from
   * .git/config). The branch is created off `origin/<defaultBranch>` already fetched
   * by ensureLocalRepo. Runs under the per-repo lock so it can't race a concurrent
   * provision (set-url/fetch) of the same clone.
   */
  async createWorktree(
    repoRef: string,
    taskLabel: string
  ): Promise<{ path: string; branch: string; baseRef: string }> {
    const { owner, repo } = parseRef(repoRef);
    return this.withRepoLock(`${owner}/${repo}`, async () => {
      const localPath = path.join(this.deps.reposDir, owner, repo);
      if (!(await this.exists(path.join(localPath, '.git')))) {
        throw new Error('createWorktree: repo not provisioned: ' + repoRef);
      }
      const defaultBranch = await this.detectDefaultBranch(localPath);
      const slug =
        taskLabel
          .replace(/[^A-Za-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80) || 'task';
      const branch = `tasca-wt/${slug}-${randomBytes(4).toString('hex')}`;
      const worktreePath = path.join(
        this.deps.reposDir,
        owner,
        `${repo}.worktrees`,
        `${slug}-${randomBytes(4).toString('hex')}`
      );
      await mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
      // LOCAL branch off the already-fetched remote default — no network, no auth.
      await this.git([
        '-C',
        localPath,
        'worktree',
        'add',
        '--no-track',
        '-b',
        branch,
        worktreePath,
        `origin/${defaultBranch}`,
      ]);
      return { path: worktreePath, branch, baseRef: `origin/${defaultBranch}` };
    });
  }

  /**
   * Reclaim a worktree + its branch once a dispatch terminates, so re-drives and
   * completed runs don't accumulate worktrees/branches without bound under reposDir
   * (inode/disk exhaustion + ref bloat on a long-lived worker). Best-effort: every
   * step is independently swallowed and the whole method never rejects — a failure to
   * clean up MUST NOT fail or re-drive the dispatch. Runs under the per-repo lock so
   * it can't race a concurrent provision/createWorktree on the same clone's .git dir.
   */
  async removeWorktree(repoRef: string, worktreePath: string, branch: string): Promise<void> {
    try {
      const { owner, repo } = parseRef(repoRef);
      const localPath = path.join(this.deps.reposDir, owner, repo);
      await this.withRepoLock(`${owner}/${repo}`, async () => {
        // `worktree remove --force` drops the checkout even with a dirty tree; `prune`
        // then clears the admin entry if the dir was already gone; `branch -D` removes
        // the per-attempt branch. Each is independent — a missing worktree/branch
        // (e.g. `worktree add` failed mid-way) must not block reclaiming the rest.
        for (const args of [
          ['-C', localPath, 'worktree', 'remove', '--force', worktreePath],
          ['-C', localPath, 'worktree', 'prune'],
          ['-C', localPath, 'branch', '-D', branch],
        ]) {
          await this.git(args).catch(() => undefined);
        }
        // Also remove the worktree dir if `git worktree remove` left it (rare).
        await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      });
    } catch {
      // Never throw from cleanup — the dispatch outcome is already decided.
    }
  }

  /**
   * The clone's default branch (what HEAD points at after a fresh clone, i.e. the
   * remote's default). Orchestrate passes `origin/<this>` as the worktree base ref,
   * bypassing Emdash's per-project-settings lookup.
   */
  private async detectDefaultBranch(localPath: string): Promise<string> {
    const out = (await this.git(['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!out || out === 'HEAD') {
      // Detached HEAD (shouldn't happen on a fresh clone) — fall back to the remote's
      // advertised default via origin/HEAD.
      const sym = (await this.git(['-C', localPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
      return sym.replace(/^origin\//, '') || 'main';
    }
    return out;
  }

  /**
   * Serialize work for a given key behind any in-flight work for the same key,
   * while different keys proceed concurrently. The stored tail never rejects (so a
   * failed provision doesn't poison the next waiter) and is dropped once settled if
   * no newer waiter has replaced it, keeping the map bounded.
   */
  private withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chain.get(key) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.then(
      () => {},
      () => {}
    );
    this.chain.set(key, tail);
    void tail.then(() => {
      if (this.chain.get(key) === tail) this.chain.delete(key);
    });
    return run;
  }
}

/** Parse + validate an `owner/repo` slug; throws on anything that isn't exactly that. */
function parseRef(repoRef: string): { owner: string; repo: string } {
  const match = REPO_REF_RE.exec(repoRef);
  if (!match) {
    throw new Error('invalid repoRef (expected owner/repo): ' + repoRef);
  }
  const owner = match[1]!;
  const repo = match[2]!;
  // `.`/`..` satisfy the char class but are path-traversal segments (the ref
  // becomes a reposDir path); reject them so a malicious slug can't escape it.
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new Error('invalid repoRef (expected owner/repo): ' + repoRef);
  }
  return { owner, repo };
}
