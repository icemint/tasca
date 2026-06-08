// @tasca/execution — headless, Electron-free execution core.
//
// A soft-fork overlay over the vendored Emdash execution core (git submodule at
// vendor/emdash, pinned to v0.4.48). Exposes a clean ExecutionPort and a
// createExecution() factory. Self-contained: it declares no @tasca/* runtime
// dependency and imports none (the Stage-1 scaffold §1.3 boundary permits only
// @tasca/domain / @tasca/contracts, but it needs neither).

export { ExecutionError } from './port.js';
export type {
  ExecutionPort,
  Worktree,
  ReserveWorktreeInput,
  AgentProcessHandle,
  SpawnAgentInput,
  OpenPrInput,
  OpenPrResult,
  CommitAgentWorkInput,
  CommitAgentWorkResult,
} from './port.js';

export { createExecution } from './factory.js';
export type { CreateExecutionOptions, VendorServices } from './factory.js';

export { buildClaudeCommand, shellQuote, DEFAULT_AGENT_ALLOWED_TOOLS } from './agent-command.js';

export { makeSecretStore } from './secret-store.js';
export type { SecretStore, SecretBackend, MakeSecretStoreOptions } from './secret-store.js';

export { openPr } from './open-pr.js';

export {
  prepareScopedWorktree,
  removeScopedWorktree,
  gitAuthEnv,
  redactToken,
  type PrepareWorktreeInput,
  type PreparedWorktree,
  type GitRunner,
} from './prepare-worktree.js';
