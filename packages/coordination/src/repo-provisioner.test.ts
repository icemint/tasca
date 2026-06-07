import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { GitAppRepoProvisioner, redactToken, type RepoProvisionerDeps } from './repo-provisioner';

// ── In-memory fakes ───────────────────────────────────────────────────────────

const TOKEN = 'ghs_faketoken1234567890';
// A writable root: the clone branch runs a REAL mkdir(parent) (git itself is faked,
// so no network/clone happens), so reposDir must be a real writable directory.
const REPOS_DIR = path.join(os.tmpdir(), 'tasca-repos-test');

/** Records every git argv (and cwd) so the test can assert the exact command. */
function makeGit() {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
  };
  return { git, calls };
}

function makeDeps(opts: {
  exists: (p: string) => Promise<boolean>;
  git?: RepoProvisionerDeps['git'];
  installationId?: string | null;
  token?: string;
}): RepoProvisionerDeps {
  return {
    appClient: {
      async getInstallationToken() {
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
}

const authUrl = (owner: string, repo: string, token = TOKEN) =>
  `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitAppRepoProvisioner.ensureLocalRepo', () => {
  it('.git absent → clones into <reposDir>/<owner>/<repo> and returns that path', async () => {
    const { git, calls } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const deps = makeDeps({ git, exists: async () => false });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result).toBe(local);
    expect(calls).toEqual([['clone', authUrl('acme', 'widgets'), local]]);
  });

  it('.git present → set-url origin then fetch --prune (no clone)', async () => {
    const { git, calls } = makeGit();
    const local = path.join(REPOS_DIR, 'acme', 'widgets');
    const deps = makeDeps({ git, exists: async () => true });

    const result = await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(result).toBe(local);
    expect(calls).toEqual([
      ['-C', local, 'remote', 'set-url', 'origin', authUrl('acme', 'widgets')],
      ['-C', local, 'fetch', '--prune', 'origin'],
    ]);
  });

  it('the origin URL embeds the installation token', async () => {
    const { git, calls } = makeGit();
    const deps = makeDeps({ git, exists: async () => false });

    await new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets');

    expect(calls[0]![1]).toBe(`https://x-access-token:${TOKEN}@github.com/acme/widgets.git`);
  });

  it.each(['nope', 'a/b/c', '../etc', 'owner/', '/repo', ''])(
    'invalid repoRef %j → throws',
    async (ref) => {
      const { git } = makeGit();
      const deps = makeDeps({ git, exists: async () => false });
      await expect(new GitAppRepoProvisioner(deps).ensureLocalRepo(ref)).rejects.toThrow(
        /invalid repoRef/
      );
    }
  );

  it('store returns null → throws "no GitHub App installation"', async () => {
    const { git } = makeGit();
    const deps = makeDeps({ git, exists: async () => false, installationId: null });
    await expect(
      new GitAppRepoProvisioner(deps).ensureLocalRepo('acme/widgets')
    ).rejects.toThrow(/no GitHub App installation for owner acme/);
  });

  it('redactToken scrubs the token from a message echoing the auth URL', () => {
    // The production default git wrapper applies exactly this to execFile's
    // rejection (which echoes the full argv, incl. the auth URL).
    const leaky = `Command failed: git clone ${authUrl('acme', 'widgets')} /var/tasca-repos/acme/widgets`;
    const safe = redactToken(leaky);
    expect(safe).not.toContain(TOKEN);
    expect(safe).toContain('x-access-token:***@');
  });

  it('a git failure carrying the token → ensureLocalRepo rejects with it REDACTED', async () => {
    // Simulate execFile's redaction-less throw (full argv in the message), wrapped
    // through the SAME production redactToken the default git wrapper uses.
    const deps: RepoProvisionerDeps = {
      appClient: { async getInstallationToken() { return { token: TOKEN }; } },
      store: { async getInstallationIdForOwner() { return '77'; } },
      reposDir: REPOS_DIR,
      // `.git` present → the set-url git call runs first (no real mkdir/clone),
      // and that is the call we make throw with the token in its message.
      exists: async () => true,
      git: async (args) => {
        try {
          throw new Error(`Command failed: git ${args.join(' ')}`);
        } catch (err) {
          throw new Error(redactToken(err instanceof Error ? err.message : String(err)));
        }
      },
    };

    const err = await new GitAppRepoProvisioner(deps)
      .ensureLocalRepo('acme/widgets')
      .then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e))
      );

    expect(err).not.toBeNull();
    expect(err).not.toContain(TOKEN);
    expect(err).toContain('x-access-token:***@');
  });
});
