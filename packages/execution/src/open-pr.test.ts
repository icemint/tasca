import { describe, it, expect } from 'vitest';
import { openPr, type ExecFn } from './open-pr.js';
import { ExecutionError } from './port.js';

// Unit tests for the openPr idempotency path — no real git/gh. An injected ExecFn
// stands in for execFile, dispatching by the command + args.

const PR1 = 'https://github.com/icemint/demo/pull/1';

/** Build a fake exec from handlers keyed by a label derived from (file, args). */
function fakeExec(handlers: {
  push?: () => Promise<{ stdout: string; stderr: string }>;
  create?: () => Promise<{ stdout: string; stderr: string }>;
  list?: () => Promise<{ stdout: string; stderr: string }>;
}): ExecFn {
  return async (file, args) => {
    if (file === 'git' && args[0] === 'push') {
      return (handlers.push ?? (async () => ({ stdout: '', stderr: '' })))();
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      if (!handlers.create) throw new Error('unexpected gh pr create');
      return handlers.create();
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return (handlers.list ?? (async () => ({ stdout: '', stderr: '' })))();
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
}

const input = { cwd: '/repo', branch: 'tasca/icemint-demo-42', title: 'Tasca: demo#42' };

describe('openPr', () => {
  it('returns the parsed PR URL on a normal create', async () => {
    const exec = fakeExec({ create: async () => ({ stdout: `${PR1}\n`, stderr: '' }) });
    expect(await openPr(input, exec)).toEqual({ url: PR1 });
  });

  it('is idempotent: on "already exists", returns the EXISTING PR instead of throwing', async () => {
    const exec = fakeExec({
      create: async () => {
        // gh exits non-zero; the error carries the message on stderr.
        throw Object.assign(new Error('failed'), {
          stderr: 'a pull request for branch "tasca/icemint-demo-42" already exists',
        });
      },
      list: async () => ({ stdout: `${PR1}\n`, stderr: '' }),
    });
    expect(await openPr(input, exec)).toEqual({ url: PR1 });
  });

  it('re-throws when create fails for a reason other than an existing PR', async () => {
    const exec = fakeExec({
      create: async () => {
        throw Object.assign(new Error('boom'), { stderr: 'GraphQL: permission denied' });
      },
    });
    await expect(openPr(input, exec)).rejects.toThrow(/boom|permission denied/);
  });

  it('re-throws the original error when "already exists" but the PR cannot be read back', async () => {
    const exec = fakeExec({
      create: async () => {
        throw Object.assign(new Error('exists'), { stderr: 'already exists' });
      },
      list: async () => ({ stdout: '\n', stderr: '' }), // empty → nothing to return
    });
    await expect(openPr(input, exec)).rejects.toThrow(/exists/);
  });

  it('rejects an unsafe branch ref before running anything', async () => {
    const exec = fakeExec({});
    await expect(openPr({ ...input, branch: '--exec=evil' }, exec)).rejects.toThrow(/unsafe/);
  });

  it('pushes the local branch to a deterministic headBranch and opens the PR from it', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      if (file === 'gh' && args[1] === 'create') return { stdout: `${PR1}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const res = await openPr({ ...input, branch: 'tasca/local-2', headBranch: 'tasca/icemint-demo-42' }, exec);
    expect(res).toEqual({ url: PR1 });
    const push = calls.find((c) => c.file === 'git' && c.args[0] === 'push')!;
    // local:head refspec, forced, options terminated by `--`
    expect(push.args).toContain('--force');
    expect(push.args).toContain('tasca/local-2:tasca/icemint-demo-42');
    const create = calls.find((c) => c.file === 'gh' && c.args[1] === 'create')!;
    const headIdx = create.args.indexOf('--head');
    expect(create.args[headIdx + 1]).toBe('tasca/icemint-demo-42'); // PR head = deterministic, not the local branch
  });

  it('rejects an unsafe headBranch', async () => {
    const exec = fakeExec({});
    await expect(openPr({ ...input, headBranch: '--evil' }, exec)).rejects.toThrow(/unsafe/);
  });

  it('wraps a git push failure as ExecutionError kind "push"', async () => {
    const exec = fakeExec({
      push: async () => {
        throw Object.assign(new Error('push failed'), { stderr: 'remote rejected' });
      },
    });
    const err = await openPr(input, exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).kind).toBe('push');
    expect((err as ExecutionError).cause).toBeInstanceOf(Error);
  });

  it('wraps a non-idempotent gh pr create failure as ExecutionError kind "pr-create"', async () => {
    const exec = fakeExec({
      create: async () => {
        throw Object.assign(new Error('boom'), { stderr: 'GraphQL: permission denied' });
      },
    });
    const err = await openPr(input, exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).kind).toBe('pr-create');
    expect((err as ExecutionError).cause).toBeInstanceOf(Error);
  });

  it('wraps "already exists" with an unreadable PR as ExecutionError kind "pr-create"', async () => {
    const exec = fakeExec({
      create: async () => {
        throw Object.assign(new Error('exists'), { stderr: 'already exists' });
      },
      list: async () => ({ stdout: '\n', stderr: '' }),
    });
    const err = await openPr(input, exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).kind).toBe('pr-create');
  });

  it('wraps an unparseable gh output as ExecutionError kind "pr-parse"', async () => {
    const exec = fakeExec({ create: async () => ({ stdout: 'no url here', stderr: '' }) });
    const err = await openPr(input, exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).kind).toBe('pr-parse');
  });

  it('still returns the existing PR on "already exists" (idempotency unchanged)', async () => {
    const exec = fakeExec({
      create: async () => {
        throw Object.assign(new Error('failed'), {
          stderr: 'a pull request for branch "tasca/icemint-demo-42" already exists',
        });
      },
      list: async () => ({ stdout: `${PR1}\n`, stderr: '' }),
    });
    expect(await openPr(input, exec)).toEqual({ url: PR1 });
  });
});

describe('openPr — gh auth token (GH_TOKEN)', () => {
  function capturingExec(calls: Array<{ file: string; env?: NodeJS.ProcessEnv | undefined }>): ExecFn {
    return async (file, args, opts) => {
      calls.push({ file, env: opts.env });
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return { stdout: `${PR1}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
  }

  it('passes the token to gh as GH_TOKEN, but NOT to git push (push uses origin)', async () => {
    const calls: Array<{ file: string; env?: NodeJS.ProcessEnv | undefined }> = [];
    const res = await openPr({ ...input, token: 'ghs_install_token' }, capturingExec(calls));
    expect(res).toEqual({ url: PR1 });
    expect(calls.find((c) => c.file === 'gh')?.env?.GH_TOKEN).toBe('ghs_install_token');
    expect(calls.find((c) => c.file === 'git')?.env).toBeUndefined();
  });

  it('omits GH_TOKEN when no token is given (ambient gh auth)', async () => {
    const calls: Array<{ file: string; env?: NodeJS.ProcessEnv | undefined }> = [];
    await openPr(input, capturingExec(calls));
    expect(calls.find((c) => c.file === 'gh')?.env).toBeUndefined();
  });
});
