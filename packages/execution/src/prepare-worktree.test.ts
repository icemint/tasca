import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareScopedWorktree, gitAuthEnv, type GitRunner } from './prepare-worktree';

const TOKEN = 'ghs_scoped_tok_abcdef0123456789';

/** Records every git argv + env. A faked clone creates `<dest>/.git` so the real
 *  rename(tmp, localPath) succeeds without touching the network. */
function fakeGit() {
  const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
  const git: GitRunner = async (args, opts) => {
    calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
    if (args[0] === 'clone') await mkdir(path.join(args[2]!, '.git'), { recursive: true });
    if (args.includes('rev-parse')) return 'main\n';
    return '';
  };
  return { git, calls };
}

describe('prepareScopedWorktree — credential isolation carries over to the runner', () => {
  it('the scoped token NEVER appears in argv or the origin URL (env-auth only, tokenless origin)', async () => {
    const reposDir = await mkdtemp(path.join(os.tmpdir(), 'tasca-rt-'));
    try {
      const { git, calls } = fakeGit();
      const wt = await prepareScopedWorktree({
        repoRef: 'acme/widgets',
        token: TOKEN,
        reposDir,
        taskLabel: 'gh-1',
        git,
        exists: async () => false, // fresh clone path
      });

      const flat = calls.map((c) => c.args.join(' ')).join('\n');
      // The token is NEVER in any argv, and the origin URL is tokenless.
      expect(flat).not.toContain(TOKEN);
      expect(flat).not.toContain('x-access-token');
      expect(flat).toContain('clone https://github.com/acme/widgets.git'); // tokenless origin
      // The credential rides ONLY the clone/fetch child's env (the extraheader).
      const clone = calls.find((c) => c.args[0] === 'clone')!;
      expect(clone.env?.GIT_CONFIG_VALUE_0).toBe(gitAuthEnv(TOKEN).GIT_CONFIG_VALUE_0);
      // The worktree-add (where the AGENT's checkout comes from) carries NO auth env.
      const wtAdd = calls.find((c) => c.args.includes('worktree'))!;
      expect(wtAdd.env).toBeUndefined();
      expect(wt.baseRef).toBe('origin/main');
      expect(wt.branch).toMatch(/^tasca-wt\/gh-1-[0-9a-f]{8}$/);
    } finally {
      await rm(reposDir, { recursive: true, force: true });
    }
  });

  it('an existing checkout is re-pointed tokenless + fetched via env-auth (token not in set-url argv)', async () => {
    const reposDir = await mkdtemp(path.join(os.tmpdir(), 'tasca-rt-'));
    try {
      const { git, calls } = fakeGit();
      await prepareScopedWorktree({
        repoRef: 'acme/widgets',
        token: TOKEN,
        reposDir,
        taskLabel: 'gh-2',
        git,
        exists: async () => true, // existing-checkout path
      });
      const setUrl = calls.find((c) => c.args.includes('set-url'))!;
      expect(setUrl.args.join(' ')).toContain('https://github.com/acme/widgets.git');
      expect(setUrl.args.join(' ')).not.toContain(TOKEN);
      expect(setUrl.env).toBeUndefined(); // set-url is unauthenticated (tokenless URL)
      const fetch = calls.find((c) => c.args.includes('fetch'))!;
      expect(fetch.env?.GIT_CONFIG_VALUE_0).toBeDefined(); // fetch authenticates via env
    } finally {
      await rm(reposDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid repoRef', async () => {
    await expect(
      prepareScopedWorktree({ repoRef: 'not-a-ref', token: TOKEN, reposDir: '/tmp', taskLabel: 't', git: fakeGit().git })
    ).rejects.toThrow(/invalid repoRef/);
  });
});
