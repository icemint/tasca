import { describe, it, expect, vi } from 'vitest';
import { createExecution, type VendorServices } from './factory.js';
import { ExecutionError } from './port.js';

// Unit tests for the createExecution() port — PTY reaping + typed-error wrapping —
// driven entirely through the servicesOverride test seam, so no native vendor /
// compiled bridge is loaded.

/** A fake PTY handle that records kills and lets a test fire its exit/error listeners. */
function fakePty(opts?: { killThrows?: boolean }) {
  const exitListeners: Array<(code: number, signal?: number) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const handle = {
    pid: 1234,
    killed: 0,
    onData: (_l: (chunk: string) => void) => {},
    onExit: (l: (code: number, signal?: number) => void) => {
      exitListeners.push(l);
    },
    onError: (l: (err: Error) => void) => {
      errorListeners.push(l);
    },
    kill: vi.fn((_signal?: string) => {
      handle.killed += 1;
      if (opts?.killThrows) throw new Error('kill failed');
    }),
  };
  return {
    handle,
    fireExit: (code = 0) => exitListeners.forEach((l) => l(code)),
    fireError: (err = new Error('pty error')) => errorListeners.forEach((l) => l(err)),
  };
}

/** Build a VendorServices fake from per-method overrides. */
function fakeServices(over: {
  startLifecyclePty?: VendorServices['ptyManager']['startLifecyclePty'];
  createWorktree?: VendorServices['worktreeService']['createWorktree'];
  close?: () => Promise<void>;
}): VendorServices {
  return {
    worktreeService: {
      createWorktree:
        over.createWorktree ??
        (async (repoPath) => ({ path: `${repoPath}/wt`, branch: 'tasca/x' })),
    },
    ptyManager: {
      startLifecyclePty:
        over.startLifecyclePty ?? (() => fakePty().handle),
    },
    databaseService: {
      initialize: async () => {},
      close: over.close ?? (async () => {}),
    },
    createDrizzleClient: async () => ({ close: async () => {} }),
  };
}

const spawnInput = (id: string) => ({ id, command: 'echo hi', cwd: '/wt' });

describe('createExecution — PTY reaping', () => {
  it('close() kills all live handles, then closes the DB', async () => {
    const a = fakePty();
    const b = fakePty();
    const ptys = [a.handle, b.handle];
    let i = 0;
    const close = vi.fn(async () => {});
    const port = createExecution({
      servicesOverride: fakeServices({ startLifecyclePty: () => ptys[i++]!, close }),
    });

    port.spawnAgent(spawnInput('a'));
    port.spawnAgent(spawnInput('b'));

    await port.close();

    expect(a.handle.kill).toHaveBeenCalledTimes(1);
    expect(b.handle.kill).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    // DB closed AFTER the handles were reaped.
    expect(a.handle.kill.mock.invocationCallOrder[0]!).toBeLessThan(
      close.mock.invocationCallOrder[0]!
    );
  });

  it('does NOT kill a handle that already fired onExit', async () => {
    const a = fakePty();
    const port = createExecution({
      servicesOverride: fakeServices({ startLifecyclePty: () => a.handle }),
    });

    port.spawnAgent(spawnInput('a'));
    a.fireExit(0); // agent finished → deregistered

    await port.close();
    expect(a.handle.kill).not.toHaveBeenCalled();
  });

  it('does NOT kill a handle that already fired onError', async () => {
    const a = fakePty();
    const port = createExecution({
      servicesOverride: fakeServices({ startLifecyclePty: () => a.handle }),
    });

    port.spawnAgent(spawnInput('a'));
    a.fireError();

    await port.close();
    expect(a.handle.kill).not.toHaveBeenCalled();
  });

  it('killAgent(id) kills and deregisters exactly one agent', async () => {
    const a = fakePty();
    const b = fakePty();
    const ptys = [a.handle, b.handle];
    let i = 0;
    const port = createExecution({
      servicesOverride: fakeServices({ startLifecyclePty: () => ptys[i++]! }),
    });

    port.spawnAgent(spawnInput('a'));
    port.spawnAgent(spawnInput('b'));

    port.killAgent('a');
    expect(a.handle.kill).toHaveBeenCalledTimes(1);
    expect(b.handle.kill).not.toHaveBeenCalled();

    // 'a' is deregistered: close() reaps only the remaining 'b' (a not killed again).
    await port.close();
    expect(a.handle.kill).toHaveBeenCalledTimes(1);
    expect(b.handle.kill).toHaveBeenCalledTimes(1);
  });

  it('killAgent on an unknown id is a no-op', async () => {
    const port = createExecution({ servicesOverride: fakeServices({}) });
    expect(() => port.killAgent('nope')).not.toThrow();
  });

  it('a kill that throws does not stop close() from reaping the rest', async () => {
    const bad = fakePty({ killThrows: true });
    const good = fakePty();
    const ptys = [bad.handle, good.handle];
    let i = 0;
    const port = createExecution({
      servicesOverride: fakeServices({ startLifecyclePty: () => ptys[i++]! }),
    });

    port.spawnAgent(spawnInput('bad'));
    port.spawnAgent(spawnInput('good'));

    await expect(port.close()).resolves.toBeUndefined();
    expect(bad.handle.kill).toHaveBeenCalledTimes(1);
    expect(good.handle.kill).toHaveBeenCalledTimes(1);
  });
});

describe('createExecution — typed error wrapping', () => {
  it('reserveWorktree rejects with ExecutionError kind "worktree" when the vendor throws', async () => {
    const port = createExecution({
      servicesOverride: fakeServices({
        createWorktree: async () => {
          throw new Error('git worktree add failed');
        },
      }),
    });

    const err = await port
      .reserveWorktree({ repoPath: '/repo', taskLabel: 'demo', projectId: 'p1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).kind).toBe('worktree');
    expect((err as ExecutionError).cause).toBeInstanceOf(Error);
  });

  it('spawnAgent throws ExecutionError kind "spawn" SYNCHRONOUSLY when startLifecyclePty throws', () => {
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: () => {
          throw new Error('pty spawn failed');
        },
      }),
    });

    let thrown: unknown;
    try {
      port.spawnAgent(spawnInput('a'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ExecutionError);
    expect((thrown as ExecutionError).kind).toBe('spawn');
    expect((thrown as ExecutionError).cause).toBeInstanceOf(Error);
  });

  it('a failed spawn registers no live handle (nothing to reap on close)', async () => {
    const close = vi.fn(async () => {});
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: () => {
          throw new Error('pty spawn failed');
        },
        close,
      }),
    });
    expect(() => port.spawnAgent(spawnInput('a'))).toThrow(ExecutionError);
    await expect(port.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
