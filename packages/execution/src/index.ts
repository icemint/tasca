// @tasca/execution — headless, Electron-free execution core.
//
// A soft-fork overlay over the vendored Emdash execution core (git submodule at
// vendor/emdash, pinned to v0.4.48). Exposes a clean ExecutionPort and a
// createExecution() factory; depends only on @tasca/domain / @tasca/contracts
// (Stage-1 scaffold §1.3 boundary).

export type {
  ExecutionPort,
  Worktree,
  ReserveWorktreeInput,
  AgentProcessHandle,
  SpawnAgentInput,
  OpenPrInput,
  OpenPrResult,
  ExecutionTaskRef,
} from './port.js';

export { createExecution } from './factory.js';
export type { CreateExecutionOptions } from './factory.js';

export { makeSecretStore } from './secret-store.js';
export type { SecretStore, SecretBackend, MakeSecretStoreOptions } from './secret-store.js';

export { openPr } from './open-pr.js';
