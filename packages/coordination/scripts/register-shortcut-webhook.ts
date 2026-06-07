// One-shot operator CLI: register Tasca's outgoing webhook with Shortcut.
//
// Run once post-deploy (deploy spec §7), e.g.:
//   SHORTCUT_API_TOKEN=… SHORTCUT_WEBHOOK_SECRET=… \
//     pnpm --filter @tasca/coordination shortcut:register-webhook
//
// Thin shell: all logic + validation lives in the testable core module. UNGATED
// (workspace admin token); provisioning / write-back remain stubbed behind the
// Shortcut token-issuance gate.

import { registerShortcutWebhook } from '../src/shortcut-webhook-registration';

registerShortcutWebhook({
  apiToken: process.env.SHORTCUT_API_TOKEN,
  webhookSecret: process.env.SHORTCUT_WEBHOOK_SECRET,
  webhookUrl: process.env.SHORTCUT_WEBHOOK_URL,
})
  .then((webhookId) => {
    console.log(JSON.stringify({ ok: true, webhookId, message: 'shortcut outgoing webhook registered' }));
  })
  .catch((err: unknown) => {
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
