import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareScopedWorktree, removeScopedWorktree, gitAuthEnv, type GitRunner } from './prepare-worktree';

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

  it('rejects a `..` repoRef before any filesystem write (path-traversal guard)', async () => {
    // The dot-permitting regex matches owner='..' / repo='..'; without the guard, path.join
    // would escape reposDir and the no-checkout branch would rm -rf the escaped path.
    for (const repoRef of ['../x', 'foo/..', '../..']) {
      const { git, calls } = fakeGit();
      await expect(
        prepareScopedWorktree({ repoRef, token: TOKEN, reposDir: '/tmp/tasca-repos', taskLabel: 't', git, exists: async () => false })
      ).rejects.toThrow(/unsafe repoRef/);
      expect(calls).toHaveLength(0); // rejected before any git/rm ran
    }
  });

  it('branches off the REMOTE default (origin/HEAD), not the stale local checkout', async () => {
    const reposDir = await mkdtemp(path.join(os.tmpdir(), 'tasca-rt-'));
    try {
      // Simulate an upstream rename: the local checkout still reads `master` via rev-parse,
      // but origin/HEAD now points at `main`. The base must follow origin/HEAD.
      const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const git: GitRunner = async (args, opts) => {
        calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
        if (args.includes('symbolic-ref')) return 'origin/main\n';
        if (args.includes('rev-parse')) return 'master\n'; // stale local branch
        return '';
      };
      const wt = await prepareScopedWorktree({ repoRef: 'acme/widgets', token: TOKEN, reposDir, taskLabel: 'gh-3', git, exists: async () => true });
      expect(wt.baseRef).toBe('origin/main');
      const wtAdd = calls.find((c) => c.args.includes('worktree'))!;
      expect(wtAdd.args).toContain('origin/main'); // not origin/master
      // origin/HEAD was refreshed via env-auth so a rename is picked up
      const setHead = calls.find((c) => c.args.includes('set-head'))!;
      expect(setHead.env?.GIT_CONFIG_VALUE_0).toBeDefined();
    } finally {
      await rm(reposDir, { recursive: true, force: true });
    }
  });
});

describe('removeScopedWorktree — the runner reclaims worktrees so the shared volume cannot fill', () => {
  it('removes the worktree via `git worktree remove --force`', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return '';
    };
    await removeScopedWorktree({ localPath: '/repos/acme/widgets', worktreePath: '/repos/acme/widgets.worktrees/x', git });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['-C', '/repos/acme/widgets', 'worktree', 'remove', '--force', '/repos/acme/widgets.worktrees/x']);
  });

  it('falls back to prune when the git remove fails (dangling registration is still cleared)', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      if (args.includes('remove')) throw new Error('worktree is locked');
      return '';
    };
    await removeScopedWorktree({ localPath: '/repos/acme/widgets', worktreePath: '/nope', git });
    expect(calls.some((a) => a.includes('remove'))).toBe(true);
    expect(calls.some((a) => a.includes('prune'))).toBe(true); // pruned after the failed remove
  });
});
