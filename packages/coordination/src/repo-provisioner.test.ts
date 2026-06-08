import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { GitAppRepoProvisioner, redactToken, githubAuthEnv, type RepoProvisionerDeps } from './repo-provisioner';

// ── Per-test scratch dir ──────────────────────────────────────────────────────
// The provisioner does REAL fs (mkdir/rename/rm) even when `git` is faked, so each
// test gets its own mkdtemp reposDir and removes it afterwards (no shared residue).

const TOKEN = 'ghs_faketoken1234567890';
let REPOS_DIR: string;

beforeEach(async () => {
  REPOS_DIR = await mkdtemp(path.join(os.tmpdir(), 'tasca-repos-test-'));
});
afterEach(async () => {
  await rm(REPOS_DIR, { recursive: true, force: true });
});

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Records every git argv (and the per-call env). A faked `git clone <url> <dest>`
 * creates `<dest>/.git` so the production atomic-clone's real `rename(tmp, localPath)`
 * succeeds without touching the network. Optional `delay` yields the event loop
 * inside each call so concurrency (interleaving vs serialization) is observable.
 */
function makeGit(opts: { delay?: boolean } = {}) {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const git: NonNullable<RepoProvisionerDeps['git']> = async (args, runOpts) => {
    calls.push(args);
    envs.push(runOpts?.env);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (opts.delay) await new Promise((r) => setTimeout(r, 0));
    if (args[0] === 'clone') await mkdir(path.join(args[2]!, '.git'), { recursive: true });
    inFlight -= 1;
    // default-branch detection reads HEAD's symbolic name
    if (args.includes('rev-parse')) return 'main\n';
    return '';
  };
  return {
    git,
    calls,
    envs,
    /** The env recorded for the first call matching `subcommand` (clone/fetch/...). */
    envFor: (subcommand: string) => envs[calls.findIndex((c) => c.includes(subcommand))],
    maxInFlight: () => maxInFlight,
  };
}

/** The extraheader value env-auth injects for TOKEN (base64 of x-access-token:TOKEN). */
const EXTRAHEADER = `Authorization: Basic ${Buffer.from('x-access-token:' + TOKEN).toString('base64')}`;

function makeDeps(opts: {
  exists: (p: string) => Promise<boolean>;
  git?: RepoProvisionerDeps['git'];
  installationId?: string | null;
  token?: string;
}): { deps: RepoProvisionerDeps; tokenCalls: () => number } {
  let tokenCalls = 0;
  const deps: RepoProvisionerDeps = {
    appClient: {
      async getInstallationToken() {
        tokenCalls += 1;
        return { token: opts.token ?? TOKEN };
      },
    },
    store: {
      async getInstallationIdForOwner() {
        return opts.installationId === undefined ? '77' : opts.installationId;
      },
    },
    reposDir: REPOS_DIR,
    exists: opts.exists,
    ...(opts.git ? { git: opts.git } : {}),
  };
  return { deps, tokenCalls: () => tokenCalls };
}

/** The TOKENLESS origin URL the provisioner now clones/sets — no embedded credential. */
const originUrl = (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitAppRepoProvisioner.ensureLocalRepo', () => {
  it('.git absent → clones atomically (temp dir + rename) and returns the final path', async () => {
    const { git, calls, envFor } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const { deps } = makeDeps({ git, exists: async () => false });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result.path).toBe(local);
    expect(result.defaultBranch).toBe('main');
    expect(calls[0]![0]).toBe('clone');
    // The origin URL is TOKENLESS — no credential is persisted into .git/config.
    expect(calls[0]![1]).toBe(originUrl('acme', 'widgets'));
    expect(calls[0]![1]).not.toContain('x-access-token:');
    // The credential is carried via env-auth (extraheader) on the clone child only.
    expect(envFor('clone')?.GIT_CONFIG_VALUE_0).toBe(EXTRAHEADER);
    // Clones into a temp sibling, never directly into the published path…
    expect(calls[0]![2]).toMatch(new RegExp(`^${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-`));
    // …then renames into place: the final path is the complete checkout.
    expect(await pathExists(path.join(local, '.git'))).toBe(true);
    // …and detects the default branch off the clone.
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(true);
  });

  it('.git present → set-url tokenless origin then fetch --prune (env-auth, no clone)', async () => {
    const { git, calls, envFor } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const { deps } = makeDeps({ git, exists: async () => true });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result.path).toBe(local);
    expect(result.defaultBranch).toBe('main');
    expect(calls).toEqual([
      ['-C', local, 'remote', 'set-url', 'origin', originUrl('acme', 'widgets')],
      ['-C', local, 'fetch', '--prune', 'origin'],
      ['-C', local, 'rev-parse', '--abbrev-ref', 'HEAD'],
    ]);
    // set-url carries no credential; fetch authenticates via env-auth.
    expect(calls[0]!.join(' ')).not.toContain('x-access-token:');
    expect(envFor('fetch')?.GIT_CONFIG_VALUE_0).toBe(EXTRAHEADER);
  });

  it('a leftover non-empty dir without .git self-heals (rm + reclone), not wedged', async () => {
    // Simulate a crash mid-clone: localPath exists, is non-empty, has no .git.
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'partial.txt'), 'half a clone');
    const { git, calls } = makeGit();
    const { deps } = makeDeps({ git, exists: async () => false });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result.path).toBe(local);
    expect(calls[0]![0]).toBe('clone'); // recloned rather than failing on the non-empty dir
    expect(await pathExists(path.join(local, '.git'))).toBe(true);
    expect(await pathExists(path.join(local, 'partial.txt'))).toBe(false); // leftover cleared
  });

  it('the origin URL is TOKENLESS and the token is carried via env-auth only', async () => {
    const { git, calls, envFor } = makeGit();
    const { deps } = makeDeps({ git, exists: async () => false });

    await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    // No credential anywhere in the clone argv (so none lands in .git/config)…
    expect(calls[0]![1]).toBe('https://github.com/acme/widgets.git');
    expect(calls[0]!.join(' ')).not.toContain('x-access-token:');
    // …it is supplied to the clone child as an http.extraheader via env-auth.
    expect(envFor('clone')).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: EXTRAHEADER,
    });
  });

  it('githubAuthEnv builds a single-entry extraheader carrying the basic auth token', () => {
    const env = githubAuthEnv(TOKEN);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:' + TOKEN).toString('base64')}`,
    });
    // The raw token is base64-wrapped, never present verbatim.
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it.each(['nope', 'a/b/c', '../etc', 'owner/', '/repo', '', 'a/..', './x', 'x/.', '../..'])(
    'invalid repoRef %j → throws BEFORE minting a token or running git',
    async (ref) => {
      const { git, calls } = makeGit();
      const { deps, tokenCalls } = makeDeps({ git, exists: async () => false });
      await expect(new GitAppRepoProvisioner(deps).ensureLocalRepo(ref)).rejects.toThrow(
        /invalid repoRef/
      );
      expect(tokenCalls()).toBe(0); // rejected before any token mint
      expect(calls).toHaveLength(0); // and before any git ran
    }
  );

  it('store returns null → throws "no GitHub App installation" without minting a token', async () => {
    const { git, calls } = makeGit();
    const { deps, tokenCalls } = makeDeps({ git, exists: async () => false, installationId: null });
    await expect(
      new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets')
    ).rejects.toThrow(/no GitHub App installation for owner acme/);
    expect(tokenCalls()).toBe(0); // no installation → token never requested
    expect(calls).toHaveLength(0);
  });

  it('redactToken scrubs the token from a message echoing an auth URL (defense-in-depth)', () => {
    // The origin is now tokenless, but the redaction guard stays as defense against
    // any legacy/other path that still embeds a token in a URL.
    const leaky = `Command failed: git clone https://x-access-token:${TOKEN}@github.com/acme/widgets.git /var/tasca-repos/acme/widgets`;
    const safe = redactToken(leaky);
    expect(safe).not.toContain(TOKEN);
    expect(safe).toContain('x-access-token:***@');
  });

  it('the REAL default git wrapper rejects (env-auth) WITHOUT leaking the token', async () => {
    // No injected `git` → the production execFile wrapper runs. exists:()=>true takes
    // the set-url + fetch branch; localPath does not exist, so real `git -C <missing>
    // ...` fails fast (no network). The token is now carried in env (not argv), so the
    // rejection must not leak it — and the redaction guard scrubs any URL form too.
    const { deps } = makeDeps({ exists: async () => true }); // note: git NOT injected

    const err = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets').then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    );

    expect(err).not.toBeNull();
    expect(err).not.toContain(TOKEN);
  });

  it('serializes concurrent provisioning of the SAME owner/repo (no interleave)', async () => {
    const { git, maxInFlight } = makeGit({ delay: true });
    const { deps } = makeDeps({ git, exists: async () => true });
    const p = new GitAppRepoProvisioner(deps);

    await Promise.all([p.ensureLocalRepo('acme/widgets'), p.ensureLocalRepo('acme/widgets')]);

    expect(maxInFlight()).toBe(1); // the per-repo lock kept set-url+fetch atomic
  });

  it('provisions DIFFERENT repos concurrently (lock does not over-serialize)', async () => {
    const { git, maxInFlight } = makeGit({ delay: true });
    const { deps } = makeDeps({ git, exists: async () => true });
    const p = new GitAppRepoProvisioner(deps);

    await Promise.all([p.ensureLocalRepo('acme/widgets'), p.ensureLocalRepo('beta/gadgets')]);

    expect(maxInFlight()).toBe(2); // distinct keys run in parallel
  });
});

describe('GitAppRepoProvisioner.tokenForRepo', () => {
  it('mints the installation token for the slug owner', async () => {
    const { deps } = makeDeps({ exists: async () => true });
    const token = await new GitAppRepoProvisioner(deps).tokenForRepo('acme/widgets');
    expect(token).toBe(TOKEN);
  });

  it('throws when no installation exists for the owner', async () => {
    const { deps } = makeDeps({ exists: async () => true, installationId: null });
    await expect(new GitAppRepoProvisioner(deps).tokenForRepo('acme/widgets')).rejects.toThrow(
      /no GitHub App installation for owner acme/
    );
  });

  it('rejects an invalid slug before minting', async () => {
    const { deps, tokenCalls } = makeDeps({ exists: async () => true });
    await expect(new GitAppRepoProvisioner(deps).tokenForRepo('nope')).rejects.toThrow(/invalid repoRef/);
    expect(tokenCalls()).toBe(0);
  });
});

describe('GitAppRepoProvisioner.createWorktree', () => {
  it('adds a LOCAL worktree off origin/<defaultBranch> and returns path/branch/baseRef', async () => {
    const { git, calls } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const { deps } = makeDeps({ git, exists: async () => true }); // clone `.git` present

    const result = await new GitAppRepoProvisioner(deps).createWorktree('acme/widgets', 'gh-story-1');

    // Branch + worktree path carry the sanitized label slug + a random suffix.
    expect(result.branch).toMatch(/^tasca-wt\/gh-story-1-[0-9a-f]{8}$/);
    expect(result.baseRef).toBe('origin/main');
    expect(result.path).toMatch(
      new RegExp(`^${path.join(local + '.worktrees', 'gh-story-1-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{8}$`)
    );

    // The worktree is added LOCALLY (no env-auth needed) off the fetched default.
    const add = calls.find((c) => c.includes('worktree'))!;
    expect(add).toEqual([
      '-C',
      local,
      'worktree',
      'add',
      '--no-track',
      '-b',
      result.branch,
      result.path,
      'origin/main',
    ]);
  });

  it('throws when the repo is not provisioned (no .git)', async () => {
    const { git, calls } = makeGit();
    const { deps } = makeDeps({ git, exists: async () => false });
    await expect(
      new GitAppRepoProvisioner(deps).createWorktree('acme/widgets', 'gh-story-1')
    ).rejects.toThrow(/createWorktree: repo not provisioned: acme\/widgets/);
    expect(calls.some((c) => c.includes('worktree'))).toBe(false);
  });

  it('rejects an invalid slug before any git', async () => {
    const { git, calls } = makeGit();
    const { deps } = makeDeps({ git, exists: async () => true });
    await expect(
      new GitAppRepoProvisioner(deps).createWorktree('nope', 'gh-story-1')
    ).rejects.toThrow(/invalid repoRef/);
    expect(calls).toHaveLength(0);
  });
});
