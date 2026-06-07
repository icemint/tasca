// The Shortcut webhook verifier, wired from the real @tasca/adapters ShortcutAdapter.
// Extracted from main.ts so the parse/dedupe wiring is unit-testable (main.ts runs
// main() on import and can't be imported by a test).
//
//   verify : HMAC-SHA-256 over the raw body; the envelope `id` is the idempotency key.
//   parse  : owner_ids.adds ∩ registered agent personas → AdapterEvents, then drop
//            envelopes whose ACTOR member_id is one of our own agent personas
//            (a round-tripped write) via parseAndDedupe.
//
// In Tasca's native-identity model an agent's assignee id and its actor id on its
// OWN writes are the same Shortcut member UUID, so `registeredAgentIds` serves as
// both the assignee set (parseEvent matches owner_ids.adds against it) and the self
// set (dedupeBySelf drops envelopes whose actor is in it). Because dedupe keys on
// the ACTOR, a human assignment (actor = the human, not an agent) is never dropped.
// The dedupe is moot today — write-back is gated, so no self-writes round-trip yet —
// but it is correct and active for when write-back lands.

import { ShortcutAdapter } from '@tasca/adapters';
import type { AdapterEvent, VerifiedEvent } from '@tasca/contracts';
import type { WebhookVerifier, RawWebhook, VerifiedWebhook } from './ports';

/**
 * Build the Shortcut webhook verifier. `registeredAgentIds` is a boot-time snapshot
 * of the active shortcut identity bindings; a roster change requires a worker
 * restart (dynamic reload is a Stage-1 follow-up, out of scope).
 */
export function shortcutVerifier(
  secret: string,
  registeredAgentIds: ReadonlySet<string>
): WebhookVerifier {
  const adapter = new ShortcutAdapter({ webhookSecret: secret, selfMemberIds: registeredAgentIds });
  return {
    verify(raw: RawWebhook): VerifiedWebhook | null {
      const v = adapter.verifyWebhook(raw.rawBody, raw.headers);
      if (!v.ok) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.rawBody);
      } catch {
        return null;
      }
      const id = (payload as { id?: unknown }).id;
      if (id === undefined || id === null) return null;
      // Carry the VerifiedEvent through so parse re-uses the verified raw body.
      return { platform: 'shortcut', externalEventId: String(id), payload: v };
    },
    parse(verified: VerifiedWebhook): AdapterEvent[] {
      return adapter.parseAndDedupe(verified.payload as VerifiedEvent, registeredAgentIds);
    },
  };
}
