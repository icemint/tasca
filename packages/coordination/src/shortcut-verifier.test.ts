import { describe, it, expect } from 'vitest';
import type { VerifiedEvent } from '@tasca/contracts';
import { shortcutVerifier } from './shortcut-verifier';
import type { VerifiedWebhook } from './ports';

// Proves the coordination-layer WIRING: the verifier constructs the adapter with
// selfMemberIds = the registered agent set, so parseAndDedupe actually dedupes our
// own personas' round-tripped writes (not a no-op). The adapter's parse/dedupe
// behavior itself is covered in @tasca/adapters; here we assert the integration.

const SECRET = 'whsec_test';
const ELVIS = '11111111-1111-1111-1111-111111111111';
const HUMAN = '99999999-9999-9999-9999-999999999999';
const REGISTERED = new Set([ELVIS]);

/** Build the VerifiedWebhook the verifier's parse() consumes (verify() already ran). */
function verified(actorMemberId: string): VerifiedWebhook {
  const rawBody = JSON.stringify({
    id: 'whv1-evt-1',
    changed_at: '2026-06-07T12:00:00Z',
    primary_id: 5001,
    member_id: actorMemberId, // the ACTOR
    version: 'v1',
    actions: [
      { id: 5001, entity_type: 'story', action: 'update', changes: { owner_ids: { adds: [ELVIS], removes: [] } } },
    ],
    references: [],
  });
  return { platform: 'shortcut', externalEventId: 'whv1-evt-1', payload: { ok: true, rawBody } as VerifiedEvent };
}

describe('shortcutVerifier.parse (dedupe wiring)', () => {
  it('keeps a human-actored assignment to a registered agent', () => {
    const events = shortcutVerifier(SECRET, REGISTERED).parse(verified(HUMAN));
    expect(events).toEqual([
      { type: 'task.assigned', platform: 'shortcut', externalStoryId: '5001', agentExternalId: ELVIS },
    ]);
  });

  it('drops a round-tripped write whose actor is one of our own agent personas', () => {
    // actor == ELVIS, which is in the registered (== self) set → deduped. If
    // selfMemberIds were not wired, this would wrongly return the assignment.
    const events = shortcutVerifier(SECRET, REGISTERED).parse(verified(ELVIS));
    expect(events).toEqual([]);
  });
});
