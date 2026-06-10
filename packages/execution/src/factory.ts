// createExecution() — the ExecutionPort factory.
//
// Wires the proven, Electron-free capabilities into one ExecutionPort:
//   - DB init        -> vendored DatabaseService (sqlite3 + Drizzle migrations)
//   - reserveWorktree-> vendored WorktreeService.createWorktree
//   - spawnAgent     -> vendored ptyManager.startLifecyclePty (callback transport)
//   - openPr         -> ./open-pr (git push + gh pr create — pure shell)
//
// The vendored modules are compiled CommonJS loaded behind the bootstrap shim
// (runtime/vendor-bridge.cjs). They are untyped at this boundary; we describe
// only the slice we use.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  ExecutionError,
  type AgentProcessHandle,
  type CommitAgentWorkInput,
  type CommitAgentWorkResult,
  type ExecutionPort,
  type OpenPrInput,
  type OpenPrResult,
  type ReserveWorktreeInput,
  type SpawnAgentInput,
  type Worktree,
} from './port.js';
import { openPr as openPrImpl } from './open-pr.js';
import { buildClaudeCommand } from './agent-command.js';

const execFileAsync = promisify(execFile);

// --- minimal shapes for the untyped vendored services ---
interface VendorWorktreeInfo {
  path: string;
  branch: string;
  [k: string]: unknown;
}
interface VendorPtyHandle {
  pid?: number;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number, signal?: number) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(signal?: string): void;
}
export interface VendorServices {
  worktreeService: {
    createWorktree(
      repoPath: string,
      taskLabel: string,
      projectId: string,
      baseRef?: string
    ): Promise<VendorWorktreeInfo>;
  };
  ptyManager: {
    startLifecyclePty(opts: {
      id: string;
      command: string;
      cwd: string;
      env?: Record<string, string>;
    }): VendorPtyHandle;
  };
  databaseService: {
    initialize(): Promise<void>;
    close?(): Promise<void>;
  };
  createDrizzleClient: (opts: { filePath: string; cacheResult?: boolean }) => Promise<{
    close(): Promise<void>;
  }>;
}

export interface CreateExecutionOptions {
  /**
   * Absolute path to the compiled vendor main process (<vendor>/dist/main).
   * Defaults to the in-repo submodule build. Sets EMDASH_DIST_MAIN for the
   * bootstrap resolver.
   */
  distMain?: string;
  /** Local SQLite DB file. Sets EMDASH_DB_FILE (bypasses app.getPath). */
  dbFile?: string;
  /** userData dir for the electron-stub. Sets EMDASH_USER_DATA_DIR. */
  userDataDir?: string;
  /**
   * App root the vendor uses to discover the drizzle/ migrations dir. Defaults
   * to the vendored submodule root. Sets EMDASH_APP_PATH.
   */
  appPath?: string;
  /**
   * TEST SEAM ONLY. When provided, these services are used INSTEAD of loading
   * the native vendor bridge, so the port can be unit-tested (error wrapping +
   * PTY reaping) without the compiled vendor / native bindings. Leave undefined
   * in production — the real lazy bridge is used and behavior is unchanged.
   */
  servicesOverride?: VendorServices;
}

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// SECURITY — agent env allowlist. The agent runs attacker-influenced (prompt-injected)
// code with Bash inside its worktree; it must NEVER inherit the worker's secrets
// (GITHUB_APP_PRIVATE_KEY, DATABASE_URL, SHORTCUT_*, GH_TOKEN, …). Passing the full
// process.env would let a `printenv` exfil all of them. Instead the child env is
// built from this strict allowlist of non-secret vars the CLI genuinely needs
// (PATH/HOME for spawning, locale/TZ for correct output, and the Anthropic auth the
// `claude` CLI itself reads). Operators can widen it via TASCA_AGENT_ENV_PASSTHROUGH
// (comma-separated names). Caller-supplied input.env still wins (spread last). The
// allowlist is also enforced on the GLOBAL process.env at spawn time (see
// spawnWithScrubbedEnv) because the vendor reads process.env directly — passing a
// filtered `env` arg alone would not bound what the child inherits.
const AGENT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  // ANTHROPIC_API_KEY is DELIBERATELY NOT allowlisted — the real key must never flow to
  // the prompt-injected agent. It is supplied per-mode below (proxy → placeholder; direct
  // dev/no-queue → the real key, an explicit legacy passthrough).
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
];

// A non-functional placeholder so the Claude CLI starts when redirected to the Anthropic
// proxy (which supplies the real auth worker-side). The proxy STRIPS any client x-api-key,
// so this value is never used for auth and is harmless if read by the agent.
const ANTHROPIC_PROXY_PLACEHOLDER_KEY = 'sk-ant-proxy-placeholder-not-a-real-key';

// The vendor's PTY control flag — read INSIDE startLifecyclePty (not a secret).
// Preserved through the scrub below so an operator's PTY toggle still takes effect.
const VENDOR_CONTROL_ENV = ['EMDASH_DISABLE_PTY'];

/**
 * SECURITY — the env allowlist must be enforced on the GLOBAL process.env, not just
 * the `env` we hand the vendor. The vendored `startLifecyclePty` reads process.env
 * DIRECTLY: its happy path pulls SSH_AUTH_SOCK + the X11/Wayland display vars from
 * it, and its node-pty-unavailable fallback spreads the ENTIRE process.env underneath
 * our `env`. (Under de-Electronized Node the native node-pty binding often fails to
 * load, so that fallback — the full-process.env leak — is the LIKELY production path.)
 * Passing a filtered `env` arg therefore can't bound what reaches the agent.
 *
 * So we transiently reduce process.env to `allowedKeys` for the duration of the
 * SYNCHRONOUS spawn, then restore it. startLifecyclePty does no awaiting before it
 * forks the child (node-pty/child_process snapshot env during the spawn call), so on
 * Node's single thread nothing but the child being created ever observes the reduced
 * env. Restoration runs in `finally`, so a throwing spawn still restores.
 */
function spawnWithScrubbedEnv<T>(allowedKeys: Set<string>, spawn: () => T): T {
  const removed: Array<[string, string]> = [];
  for (const key of Object.keys(process.env)) {
    if (allowedKeys.has(key)) continue;
    const value = process.env[key];
    if (value !== undefined) removed.push([key, value]);
    delete process.env[key];
  }
  try {
    return spawn();
  } finally {
    for (const [key, value] of removed) process.env[key] = value;
  }
}

// SECURITY RESIDUALS — what the spawn-time env scrub does NOT close (Phase-2, ops):
//   1. The vendor runs the command via a LOGIN+INTERACTIVE shell (`$SHELL -ilc …`), so
//      the worker user's profiles (/etc/profile, ~/.bashrc, ~/.zprofile, …) are sourced
//      INSIDE the agent — any `export SECRET=…` there re-enters the env after the scrub,
//      and the agent's Bash can read those rc files directly. Run the agent as a
//      DEDICATED unprivileged user with empty profiles (the multi-tenant deploy target),
//      not as the worker user.
//   2. Same-user / shared-namespace exposure (the DOMINANT residual): the worker runs
//      as root and the agent is an in-process child sharing the worker's PID/net/mount
//      namespaces + HOME. A root agent reads the WORKER'S OWN /proc/<pid>/environ —
//      which permanently holds GITHUB_APP_PRIVATE_KEY/DATABASE_URL/etc — directly,
//      bypassing this scrub; likewise a concurrent git/gh child's environ, internal
//      Postgres/metadata over the shared net ns. Closing it needs a separate-user +
//      PID/mount/net-namespace sandbox per agent (+ brokered creds + egress allowlist).
// The scrub closes the in-process env-INHERITANCE leak (what the child gets); it does
// NOT bound what a same-uid sibling can READ. See docs/Security-Review-Stage1.md.
// These residuals are deployment boundaries, tracked for the Phase-2 sandbox.

function defaultVendorRoot(): string {
  // src/factory.ts -> ../vendor/emdash
  return path.join(HERE, '..', 'vendor', 'emdash');
}

/**
 * Build an ExecutionPort backed by the vendored de-Electron execution core.
 *
 * Side effect: sets the EMDASH_* env contract the bootstrap shim and vendored
 * db/path module read. Call once per process before first use.
 */
export function createExecution(options: CreateExecutionOptions = {}): ExecutionPort {
  const vendorRoot = options.appPath ?? defaultVendorRoot();
  const distMain = options.distMain ?? path.join(vendorRoot, 'dist', 'main');

  process.env.EMDASH_DIST_MAIN = distMain;
  process.env.EMDASH_APP_PATH = vendorRoot;
  if (options.dbFile) process.env.EMDASH_DB_FILE = options.dbFile;
  if (options.userDataDir) process.env.EMDASH_USER_DATA_DIR = options.userDataDir;

  // Load the vendored services behind the bootstrap shim. Deferred so the env
  // contract above is in place before the vendor's eager imports run. The test
  // seam (servicesOverride) bypasses the native bridge entirely.
  let services: VendorServices | null = options.servicesOverride ?? null;
  const getServices = (): VendorServices => {
    if (!services) {
      const bridge = require(path.join(HERE, 'runtime', 'vendor-bridge.cjs')) as {
        getServices(): VendorServices;
      };
      services = bridge.getServices();
    }
    return services;
  };

  // Live PTY handles keyed by SpawnAgentInput.id, so close() can reap any agent
  // still running at shutdown (the DB-only close orphaned them). A handle is
  // deregistered when it fires onExit/onError (so a finished agent isn't killed)
  // or when killAgent()/close() reaps it.
  const liveHandles = new Map<string, VendorPtyHandle>();

  /** Best-effort kill + deregister; swallows a kill error so one bad handle can't block draining. */
  const reap = (id: string, handle: VendorPtyHandle): void => {
    liveHandles.delete(id);
    try {
      handle.kill();
    } catch {
      // best-effort: a handle that's already dead (or whose kill throws) must
      // not stop us draining the rest.
    }
  };

  return {
    async initDb(): Promise<void> {
      await getServices().databaseService.initialize();
    },

    async reserveWorktree(input: ReserveWorktreeInput): Promise<Worktree> {
      let info: VendorWorktreeInfo;
      try {
        info = await getServices().worktreeService.createWorktree(
          input.repoPath,
          input.taskLabel,
          input.projectId,
          input.baseRef
        );
      } catch (err) {
        throw new ExecutionError('worktree', `reserveWorktree failed: ${errMessage(err)}`, {
          cause: err,
        });
      }
      return { path: info.path, branch: info.branch, repoPath: input.repoPath };
    },

    spawnAgent(input: SpawnAgentInput): AgentProcessHandle {
      // When a prompt is given, build the non-interactive claude command from it
      // (injection-safe) and ignore input.command; otherwise run command as-is.
      let command: string;
      if (input.prompt !== undefined) {
        command = buildClaudeCommand({
          prompt: input.prompt,
          ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        });
      } else if (input.command !== undefined) {
        command = input.command;
      } else {
        throw new ExecutionError('spawn', 'spawnAgent requires command or prompt');
      }

      // Build the child env from the allowlist (NOT the full process.env), so no
      // inherited worker secret reaches the prompt-injectable agent. Operators can
      // extend it via TASCA_AGENT_ENV_PASSTHROUGH; caller-supplied input.env wins.
      const passthrough = (process.env.TASCA_AGENT_ENV_PASSTHROUGH ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n !== '');
      const allowedNames = [...AGENT_ENV_ALLOWLIST, ...passthrough];
      const agentEnv: Record<string, string> = {};
      for (const name of allowedNames) {
        const value = process.env[name];
        if (value !== undefined) agentEnv[name] = value;
      }
      // EPHEMERAL PER-TASK HOME — a fresh, empty home dir per spawn, overriding the
      // runner's shared HOME. Nothing persists across tasks: no shared ~/.claude session
      // map, no ~/.gitconfig / ~/.git-credentials. It also closes the login-shell residual:
      // the worker user's profiles live at the WORKER's HOME, not here, so even the vendor's
      // `$SHELL -ilc` sources none of them (only system /etc/profile, which the runner image
      // keeps secret-free) — an attacker's `export SECRET` in a prior run's ~/.bashrc can't
      // re-enter. An empty HOME breaks nothing downstream — git identity is injected inline
      // (commitAgentWork) and git/gh auth is env-based (GIT_CONFIG_*/GH_TOKEN), neither reads
      // ~/.gitconfig. Removed when the agent exits (HOME isn't needed post-run; commit +
      // openPr don't touch it). Created OUTSIDE the env scrub (mkdtemp reads TMPDIR); 0700.
      const agentHome = mkdtempSync(path.join(tmpdir(), 'tasca-agent-home-'));
      agentEnv.HOME = agentHome;
      agentEnv.CLAUDE_CONFIG_DIR = path.join(agentHome, '.claude');
      // input.env still wins (a test/operator escape hatch); no production caller sets HOME.
      Object.assign(agentEnv, input.env ?? {});
      // Anthropic credential, two modes (NEVER the real key to a proxied agent):
      //  - PROXY mode (ANTHROPIC_BASE_URL set → the runner points the agent at the keyless
      //    bridge): inject only a placeholder; the real key is supplied worker-side by the
      //    proxy. The real ANTHROPIC_API_KEY is never read into the agent env here.
      //  - DIRECT mode (no base url → dev/no-queue in-process): pass the real key through,
      //    an explicit legacy passthrough (the allowlist no longer carries it).
      if (agentEnv.ANTHROPIC_BASE_URL && agentEnv.ANTHROPIC_API_KEY === undefined) {
        agentEnv.ANTHROPIC_API_KEY = ANTHROPIC_PROXY_PLACEHOLDER_KEY;
      } else if (!agentEnv.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY) {
        agentEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }
      let homeRemoved = false;
      const cleanupHome = (): void => {
        if (homeRemoved) return;
        homeRemoved = true;
        // Best-effort, like reap(): a failed cleanup leaks a tmp dir but must never
        // break the run or mask the agent's real outcome. (No logger in this factory.)
        try {
          rmSync(agentHome, { recursive: true, force: true });
        } catch {
          /* leaked tmp HOME — tolerated over a thrown teardown */
        }
      };
      // The scrub keeps exactly the allowlist (so the vendor's process.env reads —
      // happy-path SSH_AUTH_SOCK/display + fallback's full spread — can only surface
      // allowlisted vars) plus the vendor's own PTY control flag.
      const scrubKeep = new Set([...allowedNames, ...VENDOR_CONTROL_ENV]);

      // Resolve the vendor services OUTSIDE the scrub: the lazy bridge load reads
      // EMDASH_* (which the scrub strips) and must not run under the reduced env. In
      // production initDb() already warmed this at boot; hoisting keeps the scrub
      // window to exactly the startLifecyclePty call regardless.
      const ptyManager = getServices().ptyManager;

      let handle: VendorPtyHandle;
      try {
        // startLifecyclePty can throw SYNCHRONOUSLY (before any handle exists,
        // so the failure can't be delivered via onError) — wrap it. The spawn runs
        // under spawnWithScrubbedEnv so the vendor cannot re-add a worker secret
        // (or SSH_AUTH_SOCK) from the global process.env it reads directly.
        handle = spawnWithScrubbedEnv(scrubKeep, () =>
          ptyManager.startLifecyclePty({
            id: input.id,
            command,
            cwd: input.cwd,
            env: agentEnv,
          })
        );
      } catch (err) {
        cleanupHome(); // the spawn never started — don't leak the per-task HOME
        throw new ExecutionError('spawn', `spawnAgent failed for ${input.id}: ${errMessage(err)}`, {
          cause: err,
        });
      }

      // Register as live (dedupe by id: a re-spawn under the same id replaces the
      // prior entry). Deregister on terminal events so close() won't kill a
      // finished agent — but ONLY if THIS handle is still the registered one. A
      // re-spawn replaces the map entry; without the identity check, the OLD
      // handle's late onExit/onError would delete the replacement and orphan it.
      liveHandles.set(input.id, handle);
      const deregisterSelf = (): void => {
        if (liveHandles.get(input.id) === handle) liveHandles.delete(input.id);
      };
      handle.onExit(deregisterSelf);
      handle.onError(deregisterSelf);
      // Tear down the ephemeral HOME on any terminal event (normal exit, error, or a
      // kill via reap()/killAgent → the PTY fires exit). Idempotent.
      handle.onExit(cleanupHome);
      handle.onError(cleanupHome);

      return {
        pid: handle.pid,
        onData: (l) => handle.onData(l),
        onExit: (l) => handle.onExit(l),
        onError: (l) => handle.onError(l),
        kill: (signal) => handle.kill(signal),
      };
    },

    killAgent(id: string): void {
      const handle = liveHandles.get(id);
      if (handle) reap(id, handle);
    },

    openPr(input: OpenPrInput): Promise<OpenPrResult> {
      return openPrImpl(input);
    },

    async commitAgentWork(input: CommitAgentWorkInput): Promise<CommitAgentWorkResult> {
      return commitAgentWorkImpl(input);
    },

    async close(): Promise<void> {
      // Reap every still-live agent BEFORE closing the DB. Snapshot first so
      // deregistration during iteration can't disturb the walk.
      for (const [id, handle] of [...liveHandles]) reap(id, handle);
      await services?.databaseService.close?.();
    },
  };
}

/** Extract a short message from an unknown thrown value, for ExecutionError messages. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Minimal git exec surface, injectable so commitAgentWork is unit-testable. */
export type GitExecFn = (args: string[], cwd: string) => Promise<{ stdout: string }>;

const defaultGitExec: GitExecFn = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return { stdout };
};

/**
 * Stage all, commit if anything is staged, and report whether a real change
 * landed. git runs via execFile argv (no shell), so `message`/`baseRef` are safe.
 * When `baseRef` is empty, `changed` falls back to whether THIS call committed
 * (the no-base path); otherwise it counts commits ahead of `baseRef`.
 *
 * @rejects {ExecutionError} kind `'commit'` on any git failure.
 */
export async function commitAgentWorkImpl(
  input: CommitAgentWorkInput,
  git: GitExecFn = defaultGitExec
): Promise<CommitAgentWorkResult> {
  const { cwd, message, baseRef } = input;
  try {
    await git(['add', '-A'], cwd);
    const { stdout: status } = await git(['status', '--porcelain'], cwd);
    let didCommit = false;
    if (status.trim() !== '') {
      // A fresh clone has no committer identity (no global ~/.gitconfig in the
      // container), so `git commit` would abort with "Please tell me who you are".
      // Supply it inline (env-overridable) so the commit works off ANY clone.
      const name = process.env.TASCA_GIT_AUTHOR_NAME ?? 'Tasca Agent';
      const email = process.env.TASCA_GIT_AUTHOR_EMAIL ?? 'agent@tasca.dev';
      await git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message], cwd);
      didCommit = true;
    }
    if (!baseRef) {
      // No explicit base to count ahead of (no-provisioner path). A real change is
      // one this call committed OR — if the agent committed on its own, leaving a
      // clean tree — the branch being ahead of its upstream. Missing upstream → 0.
      if (didCommit) return { changed: true };
      let aheadOfUpstream = 0;
      try {
        const { stdout } = await git(['rev-list', '--count', '@{u}..HEAD'], cwd);
        aheadOfUpstream = Number(stdout.trim()) || 0;
      } catch {
        // no upstream configured — treat as not-ahead
      }
      return { changed: aheadOfUpstream > 0 };
    }
    const { stdout: count } = await git(['rev-list', '--count', `${baseRef}..HEAD`], cwd);
    return { changed: Number(count.trim()) > 0 };
  } catch (err) {
    throw new ExecutionError('commit', `commitAgentWork failed: ${errMessage(err)}`, {
      cause: err,
    });
  }
}
