// @tasca/adapters — the PlatformAdapter seam's concrete implementations.
// Stage 1: the Shortcut + GitHub adapters, ungated intake only (HMAC verify,
// assignment/mention parse, webhook self-registration, self-dedupe). The
// PlatformAdapter interface + webhook Zod schemas live in @tasca/contracts (the
// shared seam); the gated write-back/provisioning halves are stubbed (throw) here.
//
// Boundary: imports ONLY @tasca/{domain,contracts} + node builtins.
// No routing/execution/coordination. No new runtime deps (node:crypto/https/fetch).

export { ShortcutAdapter } from './shortcut';
export type { ShortcutAdapterConfig } from './shortcut';

export { GitHubAdapter } from './github';
export type { GitHubAdapterConfig } from './github';
