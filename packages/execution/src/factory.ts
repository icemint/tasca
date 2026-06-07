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

import {
  ExecutionError,
  type AgentProcessHandle,
  type ExecutionPort,
  type OpenPrInput,
  type OpenPrResult,
  type ReserveWorktreeInput,
  type SpawnAgentInput,
  type Worktree,
} from './port.js';
import { openPr as openPrImpl } from './open-pr.js';

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
      let handle: VendorPtyHandle;
      try {
        // startLifecyclePty can throw SYNCHRONOUSLY (before any handle exists,
        // so the failure can't be delivered via onError) — wrap it.
        handle = getServices().ptyManager.startLifecyclePty({
          id: input.id,
          command: input.command,
          cwd: input.cwd,
          // Merge over the parent env (PATH/HOME/...) per the ExecutionPort
          // contract — passing only input.env strips PATH and breaks CLI spawns
          // (exit 127, command not found).
          env: { ...process.env, ...(input.env ?? {}) } as Record<string, string>,
        });
      } catch (err) {
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
