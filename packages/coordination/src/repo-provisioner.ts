// Clone-on-dispatch: turn a GitHub `owner/repo` slug into a local checkout with
// an authenticated `origin`, so reserveWorktree (which runs `git worktree add`
// against a LOCAL repo and pushes to `origin`) has a real filesystem repo to work
// from. A GitHub event's repoHint is a slug, not a path; without this the worktree
// step fails on every github-originated dispatch.
//
// Mechanism (pure shell via execFile — argv, never a shell string):
//   1. mint an installation token for the slug's owner
//   2. embed it in an https `origin` URL
//   3. clone (first time, atomically) or set-url + fetch --prune (subsequent)
//      under reposDir, serialized per owner/repo
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
// SECURITY — token in logs: the origin URL embeds the installation token, and
// execFile's rejection carries the full argv, so an unwrapped git failure would
// leak the token into the breaker's error log. Every git call is wrapped to
// REDACT the token from any thrown error before it propagates.
//
// SECURITY — token at rest: `git clone`/`git remote set-url` persist the token
// into <localPath>/.git/config. This is a DELIBERATE exception to
// GitHubAppClient's in-memory-only posture: the downstream worktree push and
// open-pr's `git push origin` authenticate via that stored origin URL, so the
// credential has to live there. We mitigate by creating reposDir mode 0700 (owner
// only) and re-minting a fresh short-lived (~1h) token on every existing-checkout
// dispatch. In production set TASCA_REPOS_DIR to a dedicated private volume rather
// than the shared tmp root.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, rm, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { RepoProvisioner } from './orchestrate';

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
 * The minimal structural deps GitAppRepoProvisioner needs, typed against shapes
 * (not the concrete GitHubAppClient / store classes) so tests inject fakes. The
 * real wiring passes the @tasca/adapters GitHubAppClient + the coordination store.
 */
export interface RepoProvisionerDeps {
  appClient: { getInstallationToken(installationId: string): Promise<{ token: string }> };
  store: { getInstallationIdForOwner(owner: string): Promise<string | null> };
  /** Filesystem root under which clones live as `<reposDir>/<owner>/<repo>`. */
  reposDir: string;
  /** Git runner (argv form). Default: execFile('git', args, opts) with token redaction. */
  git?: (args: string[], opts?: { cwd?: string }) => Promise<void>;
  /** `.git` existence probe. Default: fs.access-based. */
  exists?: (p: string) => Promise<boolean>;
}

export class GitAppRepoProvisioner implements RepoProvisioner {
  private readonly git: (args: string[], opts?: { cwd?: string }) => Promise<void>;
  private readonly exists: (p: string) => Promise<boolean>;
  /** Per-`owner/repo` promise chain: serializes provisioning of the same repo. */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RepoProvisionerDeps) {
    this.git =
      deps.git ??
      (async (args, opts) => {
        try {
          await execFileAsync('git', args, opts ?? {});
        } catch (err) {
          // execFile's rejection echoes the full argv (incl. the auth URL); redact
          // the token before it propagates into the breaker's error log.
          throw new Error(redactToken(err instanceof Error ? err.message : String(err)));
        }
      });
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

  async ensureLocalRepo(repoRef: string): Promise<string> {
    const { owner, repo } = parseRef(repoRef); // validates BEFORE any token mint
    return this.withRepoLock(`${owner}/${repo}`, () => this.provision(owner, repo));
  }

  /** Resolve installation → mint token → clone-or-refresh. Runs under the per-repo lock. */
  private async provision(owner: string, repo: string): Promise<string> {
    const installationId = await this.deps.store.getInstallationIdForOwner(owner);
    if (installationId === null) {
      throw new Error('no GitHub App installation for owner ' + owner);
    }
    const { token } = await this.deps.appClient.getInstallationToken(installationId);

    const localPath = path.join(this.deps.reposDir, owner, repo);
    const authUrl =
      'https://x-access-token:' + token + '@github.com/' + owner + '/' + repo + '.git';

    if (await this.exists(path.join(localPath, '.git'))) {
      // Existing checkout: re-point origin to a fresh auth URL (the token rotates)
      // and fetch the latest refs so the worktree branches off current state.
      await this.git(['-C', localPath, 'remote', 'set-url', 'origin', authUrl]);
      await this.git(['-C', localPath, 'fetch', '--prune', 'origin']);
      return localPath;
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
      await this.git(['clone', authUrl, tmp]);
      await rename(tmp, localPath);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return localPath;
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
