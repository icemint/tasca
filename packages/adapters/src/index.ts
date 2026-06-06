// @tasca/adapters — the PlatformAdapter seam's concrete implementations.
// Stage 1: the Shortcut adapter, ungated intake only (HMAC verify, owner-add
// parse, webhook self-registration, self-dedupe). The PlatformAdapter interface
// + Shortcut webhook Zod schemas live in @tasca/contracts (the shared seam);
// the gated write-back/provisioning halves are stubbed (throw) here.
//
// Boundary: imports ONLY @tasca/{domain,contracts,identity} + node builtins.
// No routing/execution/coordination. No new runtime deps (node:crypto/https/fetch).

export { ShortcutAdapter } from './shortcut';
export type { ShortcutAdapterConfig } from './shortcut';
