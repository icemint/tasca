// Clone-on-dispatch: turn a GitHub `owner/repo` slug into a local checkout with
// an authenticated `origin`, so reserveWorktree (which runs `git worktree add`
// against a LOCAL repo and pushes to `origin`) has a real filesystem repo to work
// from. A GitHub event's repoHint is a slug, not a path; without this the worktree
// step fails on every github-originated dispatch.
//
// Mechanism (pure shell via execFile — argv, never a shell string):
//   1. mint an installation token for the slug's owner
//   2. embed it in an https `origin` URL
//   3. clone (first time) or set-url + fetch --prune (subsequent) under reposDir
//
// SECURITY: the origin URL embeds the installation token. execFile's rejection
// carries the full argv, so an unwrapped git failure would leak the token into the
// breaker's error log. Every git call is wrapped to REDACT the token from any
// thrown error before it propagates.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access } from 'node:fs/promises';
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
    } else {
      await mkdir(path.dirname(localPath), { recursive: true });
      await this.git(['clone', authUrl, localPath]);
    }
    return localPath;
  }
}
