// Shortcut outgoing-webhook self-registration (intake-side, UNGATED).
//
// Shortcut's Outgoing Webhook v1 must POST to the worker's /webhooks/shortcut with
// the same HMAC secret the worker verifies against. This wires the adapter's
// registerWebhook (REST v3) into a single operator command run once post-deploy
// (deploy spec §7). It uses a WORKSPACE ADMIN token (Shortcut-Token header), which
// is distinct from — and not blocked by — the gated per-persona write-back tokens
// (Tasca-Shortcut-Kickoff-Brief item 2). Provisioning / status-back stay stubbed.
//
// The core is a plain function (resolved env + optional fetch) so the CLI shell in
// scripts/ stays thin and the env validation + call shape are unit-testable.

import { ShortcutAdapter } from '@tasca/adapters';

/** Default target — the worker's public Shortcut webhook route. */
export const DEFAULT_SHORTCUT_WEBHOOK_URL = 'https://api.tasca.dev/webhooks/shortcut';

export interface RegisterEnv {
  /** Workspace admin token for the `Shortcut-Token` header (NOT a per-persona token). */
  apiToken?: string | undefined;
  /** HMAC secret Shortcut signs payloads with — MUST match the worker's SHORTCUT_WEBHOOK_SECRET. */
  webhookSecret?: string | undefined;
  /** Target URL; defaults to the worker's /webhooks/shortcut route. */
  webhookUrl?: string | undefined;
}

/**
 * Register the outgoing webhook and return its (deletable) id. Throws a clear
 * error when a required value is missing — before any network call. `fetchImpl` is
 * injectable for tests; production uses the adapter's default `fetch`.
 */
export async function registerShortcutWebhook(
  env: RegisterEnv,
  fetchImpl?: typeof fetch
): Promise<string> {
  const apiToken = env.apiToken?.trim();
  const webhookSecret = env.webhookSecret?.trim();
  const webhookUrl = env.webhookUrl?.trim() || DEFAULT_SHORTCUT_WEBHOOK_URL;
  if (!apiToken) {
    throw new Error('SHORTCUT_API_TOKEN is required (workspace admin token for the Shortcut-Token header)');
  }
  if (!webhookSecret) {
    throw new Error('SHORTCUT_WEBHOOK_SECRET is required and must match the worker that verifies the signature');
  }

  const adapter = new ShortcutAdapter({
    webhookSecret,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    return await adapter.registerWebhook({ webhookUrl, secret: webhookSecret, token: apiToken });
  } catch (err) {
    // The adapter's failure message appends Shortcut's raw response body, which on a
    // 422 can echo the rejected `secret` field. Scrub the secret (and token, defensively)
    // before the error propagates to the CLI's stderr / CI logs.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(raw.split(webhookSecret).join('***').split(apiToken).join('***'));
  }
}
