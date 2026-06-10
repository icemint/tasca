import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createExecution, commitAgentWorkImpl, type GitExecFn, type VendorServices } from './factory.js';
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

  it('a stale handle re-spawned under the same id does not orphan the replacement', async () => {
    // Spawn id 'x' (handle A), then re-spawn 'x' (handle B replaces A in the map).
    // A's LATE onExit must NOT deregister B — close() must still reap B.
    const a = fakePty();
    const b = fakePty();
    const ptys = [a.handle, b.handle];
    let i = 0;
    const port = createExecution({
      servicesOverride: fakeServices({ startLifecyclePty: () => ptys[i++]! }),
    });

    port.spawnAgent(spawnInput('x')); // → A
    port.spawnAgent(spawnInput('x')); // → B (replaces A under id 'x')
    a.fireExit(); // the stale A exits; identity guard means it must NOT remove B

    await port.close();
    expect(b.handle.kill).toHaveBeenCalledTimes(1); // B still reaped (not orphaned)
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

  it('spawnAgent with a prompt builds a non-interactive claude command (quoted, injection-safe)', () => {
    let capturedCommand: string | undefined;
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: (opts) => {
          capturedCommand = opts.command;
          return fakePty().handle;
        },
      }),
    });

    port.spawnAgent({ id: 'a', cwd: '/wt', prompt: 'do the thing' });

    expect(capturedCommand).toContain("'claude' '-p'");
    expect(capturedCommand).toContain("'do the thing'");
    expect(capturedCommand).toContain("'--allowedTools'");
  });

  it('spawnAgent prefers prompt over command when both are given', () => {
    let capturedCommand: string | undefined;
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: (opts) => {
          capturedCommand = opts.command;
          return fakePty().handle;
        },
      }),
    });

    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi', prompt: 'do the thing' });

    expect(capturedCommand).toContain("'claude' '-p'");
    expect(capturedCommand).not.toContain('echo hi');
  });

  it('spawnAgent with neither command nor prompt throws ExecutionError kind "spawn"', () => {
    const port = createExecution({ servicesOverride: fakeServices({}) });
    let thrown: unknown;
    try {
      // Deliberately omit both command and prompt (both are optional in the type).
      port.spawnAgent({ id: 'a', cwd: '/wt' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ExecutionError);
    expect((thrown as ExecutionError).kind).toBe('spawn');
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

describe('spawnAgent — env allowlist (no worker secrets reach the agent)', () => {
  // The agent runs prompt-injectable code with Bash; it must never inherit the
  // worker's secrets via the child env. These tests set fake secrets on the parent
  // process.env, spawn, and assert they are absent from the captured child env.
  const SAVED: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string | undefined): void => {
    if (!(name in SAVED)) SAVED[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterEach(() => {
    for (const [name, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const key of Object.keys(SAVED)) delete SAVED[key];
  });

  function captureEnv(): { port: ReturnType<typeof createExecution>; envOf: () => Record<string, string> | undefined } {
    let captured: Record<string, string> | undefined;
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: (opts) => {
          captured = opts.env;
          return fakePty().handle;
        },
      }),
    });
    return { port, envOf: () => captured };
  }

  it('omits inherited worker secrets but keeps PATH; DIRECT mode (no proxy) passes the real Anthropic key', () => {
    setEnv('GITHUB_APP_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----');
    setEnv('DATABASE_URL', 'postgres://secret@db/app');
    setEnv('PATH', '/usr/bin:/bin');
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    setEnv('ANTHROPIC_BASE_URL', undefined); // no proxy → direct mode (dev/no-queue)

    const { port, envOf } = captureEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' });

    const env = envOf()!;
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin:/bin'); // non-secret essentials still flow
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx'); // direct mode: the real key passes (legacy)
  });

  it('PROXY mode: with ANTHROPIC_BASE_URL set, the agent gets a PLACEHOLDER key — the real key NEVER flows', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-REAL-MUST-NOT-LEAK');
    setEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:8787'); // the runner points at the keyless bridge

    const { port, envOf } = captureEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' });

    const env = envOf()!;
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787'); // redirected to the proxy
    expect(env.ANTHROPIC_API_KEY).not.toBe('sk-ant-REAL-MUST-NOT-LEAK'); // the REAL key is gone
    expect(env.ANTHROPIC_API_KEY).toContain('placeholder'); // only the non-functional placeholder
    // The hard gate: the real key appears NOWHERE in the agent env.
    expect(JSON.stringify(env)).not.toContain('sk-ant-REAL-MUST-NOT-LEAK');
  });

  it('PROXY mode placeholder does not override a caller-supplied key (input.env escape hatch wins)', () => {
    setEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:8787');
    const { port, envOf } = captureEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi', env: { ANTHROPIC_API_KEY: 'explicit-test-key' } });
    expect(envOf()!.ANTHROPIC_API_KEY).toBe('explicit-test-key');
  });

  // The capstone's real guarantee: the vendor reads the GLOBAL process.env directly
  // (happy-path SSH_AUTH_SOCK/display vars, and the node-pty-unavailable fallback
  // spreads ALL of process.env under our `env`). The `env` ARG the previous tests
  // capture cannot see that leak. This fake snapshots process.env AT CALL TIME — what
  // the vendor would actually read — and proves the spawn-time scrub closes it.
  function captureProcessEnv(): {
    port: ReturnType<typeof createExecution>;
    seenOf: () => NodeJS.ProcessEnv | undefined;
  } {
    let seen: NodeJS.ProcessEnv | undefined;
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: () => {
          seen = { ...process.env }; // exactly what the vendor's process.env reads see
          return fakePty().handle;
        },
      }),
    });
    return { port, seenOf: () => seen };
  }

  it('scrubs worker secrets AND SSH_AUTH_SOCK/DISPLAY from the GLOBAL process.env during the spawn', () => {
    setEnv('GITHUB_APP_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----');
    setEnv('DATABASE_URL', 'postgres://secret@db/app');
    setEnv('SHORTCUT_API_TOKEN', 'sc-secret');
    setEnv('GH_TOKEN', 'ghs_leak');
    setEnv('SSH_AUTH_SOCK', '/tmp/agent.sock'); // vendor happy-path forwards this from process.env
    setEnv('DISPLAY', ':0'); // vendor getDisplayEnv() copies this from process.env
    setEnv('PATH', '/usr/bin:/bin');

    const { port, seenOf } = captureProcessEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' });

    const seen = seenOf()!;
    // The vendor — reading process.env on EITHER path — can only surface allowlisted vars.
    expect(seen.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(seen.DATABASE_URL).toBeUndefined();
    expect(seen.SHORTCUT_API_TOKEN).toBeUndefined();
    expect(seen.GH_TOKEN).toBeUndefined();
    expect(seen.SSH_AUTH_SOCK).toBeUndefined(); // ssh-agent socket no longer reachable
    expect(seen.DISPLAY).toBeUndefined();
    expect(seen.PATH).toBe('/usr/bin:/bin'); // allowlisted essentials survive
  });

  it('restores the full process.env after the spawn (the scrub is transient)', () => {
    setEnv('GITHUB_APP_PRIVATE_KEY', 'k');
    setEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
    const before = { ...process.env };

    const { port } = captureProcessEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' });

    expect(process.env.GITHUB_APP_PRIVATE_KEY).toBe('k');
    expect(process.env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect({ ...process.env }).toEqual(before); // worker keeps every var it had
  });

  it('restores process.env even when the spawn throws', () => {
    setEnv('GITHUB_APP_PRIVATE_KEY', 'k');
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: () => {
          throw new Error('boom');
        },
      }),
    });
    expect(() => port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' })).toThrow(ExecutionError);
    expect(process.env.GITHUB_APP_PRIVATE_KEY).toBe('k'); // finally-restore ran
  });

  it('passes caller-supplied input.env through (it wins over the allowlist)', () => {
    setEnv('PATH', '/usr/bin');
    const { port, envOf } = captureEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi', env: { PATH: '/custom', EXTRA: 'v' } });

    const env = envOf()!;
    expect(env.PATH).toBe('/custom'); // caller override wins
    expect(env.EXTRA).toBe('v');
  });

  it('TASCA_AGENT_ENV_PASSTHROUGH widens the allowlist to named vars', () => {
    setEnv('TASCA_AGENT_ENV_PASSTHROUGH', 'MY_TOOL_HOME, OTHER_VAR');
    setEnv('MY_TOOL_HOME', '/opt/tool');
    setEnv('OTHER_VAR', 'x');
    setEnv('STILL_SECRET', 'nope');

    const { port, envOf } = captureEnv();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' });

    const env = envOf()!;
    expect(env.MY_TOOL_HOME).toBe('/opt/tool');
    expect(env.OTHER_VAR).toBe('x');
    expect(env.STILL_SECRET).toBeUndefined(); // not listed → not passed
  });
});

describe('commitAgentWork', () => {
  /** A scripted git runner: returns stdout per `git <subcommand>` for deterministic, offline tests. */
  function fakeGit(stdoutBySub: Record<string, string>): { git: GitExecFn; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitExecFn = async (args) => {
      calls.push(args);
      return { stdout: stdoutBySub[args[0]!] ?? '' };
    };
    return { git, calls };
  }

  it('stages, commits when dirty, and reports changed=true when HEAD is ahead of baseRef', async () => {
    const { git, calls } = fakeGit({ status: ' M file.ts\n', 'rev-list': '1\n' });
    const res = await commitAgentWorkImpl(
      { cwd: '/wt', message: 'Tasca: x', baseRef: 'origin/main' },
      git
    );
    expect(res.changed).toBe(true);
    // The commit carries an inline committer identity so it works off a fresh clone
    // with no configured user.name/user.email.
    expect(calls).toEqual([
      ['add', '-A'],
      ['status', '--porcelain'],
      ['-c', 'user.name=Tasca Agent', '-c', 'user.email=agent@tasca.dev', 'commit', '-m', 'Tasca: x'],
      ['rev-list', '--count', 'origin/main..HEAD'],
    ]);
  });

  it('with an empty baseRef and a clean tree, counts commits ahead of upstream (agent self-committed)', async () => {
    // The agent committed its own work → tree is clean → didCommit is false, so
    // detection falls back to `@{u}..HEAD`; a real change is still reported.
    const { git, calls } = fakeGit({ status: '', 'rev-list': '1\n' });
    const res = await commitAgentWorkImpl({ cwd: '/wt', message: 'm', baseRef: '' }, git);
    expect(res.changed).toBe(true);
    expect(calls.some((c) => c[0] === 'rev-list' && c[2] === '@{u}..HEAD')).toBe(true);
  });

  it('reports changed=false when the worktree HEAD is not ahead of baseRef', async () => {
    const { git } = fakeGit({ status: '', 'rev-list': '0\n' });
    const res = await commitAgentWorkImpl(
      { cwd: '/wt', message: 'm', baseRef: 'origin/main' },
      git
    );
    expect(res.changed).toBe(false);
  });

  it('with an empty baseRef, changed reflects whether THIS call committed', async () => {
    // Dirty → commits → changed=true, and rev-list is NOT consulted.
    const dirty = fakeGit({ status: ' M f\n' });
    const a = await commitAgentWorkImpl({ cwd: '/wt', message: 'm', baseRef: '' }, dirty.git);
    expect(a.changed).toBe(true);
    expect(dirty.calls.some((c) => c[0] === 'rev-list')).toBe(false);

    // Clean → nothing committed → changed=false.
    const clean = fakeGit({ status: '' });
    const b = await commitAgentWorkImpl({ cwd: '/wt', message: 'm', baseRef: '' }, clean.git);
    expect(b.changed).toBe(false);
  });

  it('wraps a git failure in ExecutionError kind "commit"', async () => {
    const git: GitExecFn = async () => {
      throw new Error('git add exploded');
    };
    const err = await commitAgentWorkImpl({ cwd: '/wt', message: 'm', baseRef: '' }, git).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).kind).toBe('commit');
    expect((err as ExecutionError).cause).toBeInstanceOf(Error);
  });
});

describe('spawnAgent — ephemeral per-task HOME (Wave-2 shared-HOME residual)', () => {
  /** Capture the opts the factory hands the vendor, and the fake pty so a test can fire exit. */
  function capture(over?: { throwOnSpawn?: boolean }) {
    let opts: { env?: Record<string, string> } | undefined;
    const pty = fakePty();
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: (o) => {
          opts = o;
          if (over?.throwOnSpawn) throw new Error('spawn failed');
          return pty.handle;
        },
      }),
    });
    return { port, pty, optsOf: () => opts };
  }

  it('injects a FRESH per-task HOME + CLAUDE_CONFIG_DIR under it, distinct from the runner HOME', () => {
    const { port, pty, optsOf } = capture();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo hi' });
    const env = optsOf()!.env!;
    expect(env.HOME).toContain('tasca-agent-home-');
    expect(env.HOME).not.toBe(process.env.HOME); // NOT the shared runner HOME — no cross-task sourcing
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${env.HOME}/.claude`); // claude state isolated under it
    expect(existsSync(env.HOME!)).toBe(true); // created on disk
    pty.fireExit(0); // cleanup
  });

  it('gives each spawn a DISTINCT home (no cross-task sharing), each removed on exit', () => {
    const homes: string[] = [];
    const ptys = [fakePty(), fakePty()];
    let i = 0;
    const port = createExecution({
      servicesOverride: fakeServices({
        startLifecyclePty: (o) => {
          homes.push(o.env!.HOME!);
          return ptys[i++]!.handle;
        },
      }),
    });
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo' });
    port.spawnAgent({ id: 'b', cwd: '/wt', command: 'echo' });
    expect(homes[0]).not.toBe(homes[1]); // task B never sees task A's HOME
    ptys.forEach((p) => p.fireExit(0));
    expect(existsSync(homes[0]!)).toBe(false);
    expect(existsSync(homes[1]!)).toBe(false);
  });

  it('removes the per-task HOME when the agent exits (no disk leak, no persistence to the next task)', () => {
    const { port, pty, optsOf } = capture();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo' });
    const home = optsOf()!.env!.HOME!;
    expect(existsSync(home)).toBe(true);
    pty.fireExit(0);
    expect(existsSync(home)).toBe(false);
  });

  it('removes the per-task HOME on an agent ERROR too', () => {
    const { port, pty, optsOf } = capture();
    port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo' });
    const home = optsOf()!.env!.HOME!;
    pty.fireError(new Error('boom'));
    expect(existsSync(home)).toBe(false);
  });

  it('cleans up the per-task HOME when the spawn THROWS synchronously (no leak on failure)', () => {
    const { port, optsOf } = capture({ throwOnSpawn: true });
    expect(() => port.spawnAgent({ id: 'a', cwd: '/wt', command: 'echo' })).toThrow(ExecutionError);
    const home = optsOf()!.env!.HOME!;
    expect(home).toContain('tasca-agent-home-');
    expect(existsSync(home)).toBe(false); // created then cleaned, even on a spawn failure
  });
});
