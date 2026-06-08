import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { GitAppRepoProvisioner, redactToken, type RepoProvisionerDeps } from './repo-provisioner';

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
 * Records every git argv. A faked `git clone <url> <dest>` creates `<dest>/.git`
 * so the production atomic-clone's real `rename(tmp, localPath)` succeeds without
 * touching the network. Optional `delay` yields the event loop inside each call so
 * concurrency (interleaving vs serialization) is observable.
 */
function makeGit(opts: { delay?: boolean } = {}) {
  const calls: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const git = async (args: string[]): Promise<string> => {
    calls.push(args);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (opts.delay) await new Promise((r) => setTimeout(r, 0));
    if (args[0] === 'clone') await mkdir(path.join(args[2]!, '.git'), { recursive: true });
    inFlight -= 1;
    // default-branch detection reads HEAD's symbolic name
    if (args.includes('rev-parse')) return 'main\n';
    return '';
  };
  return { git, calls, maxInFlight: () => maxInFlight };
}

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

const authUrl = (owner: string, repo: string, token = TOKEN) =>
  `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitAppRepoProvisioner.ensureLocalRepo', () => {
  it('.git absent → clones atomically (temp dir + rename) and returns the final path', async () => {
    const { git, calls } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const { deps } = makeDeps({ git, exists: async () => false });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result.path).toBe(local);
    expect(result.defaultBranch).toBe('main');
    expect(calls[0]![0]).toBe('clone');
    expect(calls[0]![1]).toBe(authUrl('acme', 'widgets'));
    // Clones into a temp sibling, never directly into the published path…
    expect(calls[0]![2]).toMatch(new RegExp(`^${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-`));
    // …then renames into place: the final path is the complete checkout.
    expect(await pathExists(path.join(local, '.git'))).toBe(true);
    // …and detects the default branch off the clone.
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(true);
  });

  it('.git present → set-url origin then fetch --prune (no clone)', async () => {
    const { git, calls } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const { deps } = makeDeps({ git, exists: async () => true });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result.path).toBe(local);
    expect(result.defaultBranch).toBe('main');
    expect(calls).toEqual([
      ['-C', local, 'remote', 'set-url', 'origin', authUrl('acme', 'widgets')],
      ['-C', local, 'fetch', '--prune', 'origin'],
      ['-C', local, 'rev-parse', '--abbrev-ref', 'HEAD'],
    ]);
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

  it('the origin URL embeds the installation token', async () => {
    const { git, calls } = makeGit();
    const { deps } = makeDeps({ git, exists: async () => false });

    await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(calls[0]![1]).toBe(`https://x-access-token:${TOKEN}@github.com/acme/widgets.git`);
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

  it('redactToken scrubs the token from a message echoing the auth URL', () => {
    const leaky = `Command failed: git clone ${authUrl('acme', 'widgets')} /var/tasca-repos/acme/widgets`;
    const safe = redactToken(leaky);
    expect(safe).not.toContain(TOKEN);
    expect(safe).toContain('x-access-token:***@');
  });

  it('the REAL default git wrapper redacts the token from an execFile rejection', async () => {
    // No injected `git` → the production execFile wrapper runs. exists:()=>true takes
    // the set-url branch; localPath does not exist, so real `git -C <missing> ...`
    // fails fast (no network) and execFile's rejection carries the full argv — incl.
    // the auth URL. This is the ONLY test that exercises the actual leak guard.
    const { deps } = makeDeps({ exists: async () => true }); // note: git NOT injected

    const err = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets').then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    );

    expect(err).not.toBeNull();
    expect(err).not.toContain(TOKEN);
    expect(err).toContain('x-access-token:***@');
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
