import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ShortcutWebhookV1Schema, type AdapterEvent, type TaskAssignedEvent } from '@tasca/contracts';
import { ShortcutAdapter } from './index';

/** Narrow the parsed union to the task.assigned events (the owner-add path) so a test can read
 *  `agentExternalId`. A clarification-reply event would be filtered out. */
function assigned(events: AdapterEvent[]): TaskAssignedEvent[] {
  return events.filter((e): e is TaskAssignedEvent => e.type === 'task.assigned');
}

// Pure unit tests for the ungated Shortcut intake — no live Shortcut. Covers:
//   - HMAC verify: valid passes, tampered body fails, missing/!= sig rejects
//   - parseEvent against the published Outgoing Webhook v1 sample from the brief
//   - actor member_id is NOT treated as an assignee
//   - multiple owner_ids.adds; a non-registered owner UUID is ignored
//   - removes-only → no event
//   - dedupeBySelf drops our own round-tripped writes
//   - Zod rejects a malformed payload

const SECRET = 'whsec_test_workspace_secret';

// Registered agent-user UUIDs (our personas, e.g. Elvis + Mona).
const ELVIS = '11111111-1111-1111-1111-111111111111';
const MONA = '22222222-2222-2222-2222-222222222222';
// A human teammate's UUID — NOT registered; owner-adds for it must be ignored.
const HUMAN = '99999999-9999-9999-9999-999999999999';
// The ACTOR who made the change in Shortcut (the human assigner). NOT an assignee.
const ACTOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
// One of OUR persona member UUIDs as it appears as the actor on a round-tripped write.
const SELF_MEMBER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/**
 * The published Outgoing Webhook v1 sample shape from the kickoff brief: a story
 * update where `changes.owner_ids.adds` gains Elvis. `member_id` is the ACTOR
 * (the human who assigned), deliberately distinct from the assignee.
 */
function samplePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'whv1-evt-0001',
    changed_at: '2026-06-06T12:00:00Z',
    primary_id: 5001,
    member_id: ACTOR,
    version: 'v1',
    actions: [
      {
        id: 5001,
        entity_type: 'story',
        action: 'update',
        changes: { owner_ids: { adds: [ELVIS], removes: [] } },
      },
    ],
    references: [],
    ...overrides,
  };
}

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function adapter(opts: Partial<ConstructorParameters<typeof ShortcutAdapter>[0]> = {}) {
  return new ShortcutAdapter({ webhookSecret: SECRET, ...opts });
}

const REGISTERED = new Set([ELVIS, MONA]);

describe('ShortcutAdapter.verifyWebhook (HMAC-SHA-256, constant-time)', () => {
  it('accepts a body signed with the workspace secret', () => {
    const body = JSON.stringify(samplePayload());
    const res = adapter().verifyWebhook(body, { 'Payload-Signature': sign(body) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rawBody).toBe(body);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const body = JSON.stringify(samplePayload());
    const signature = sign(body);
    const tampered = body.replace('5001', '5002');
    const res = adapter().verifyWebhook(tampered, { 'Payload-Signature': signature });
    expect(res).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects when the Payload-Signature header is absent', () => {
    const body = JSON.stringify(samplePayload());
    const res = adapter().verifyWebhook(body, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/missing/i);
  });

  it('rejects a present-but-wrong signature (different secret)', () => {
    const body = JSON.stringify(samplePayload());
    const wrong = sign(body, 'whsec_other_secret');
    const res = adapter().verifyWebhook(body, { 'Payload-Signature': wrong });
    expect(res).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a non-hex / wrong-length signature without throwing (constant-time path guard)', () => {
    const body = JSON.stringify(samplePayload());
    expect(() =>
      adapter().verifyWebhook(body, { 'Payload-Signature': 'not-a-valid-hex-signature' })
    ).not.toThrow();
    const res = adapter().verifyWebhook(body, { 'Payload-Signature': 'zz' });
    expect(res.ok).toBe(false);
  });

  it('rejects a correct-LENGTH but non-hex signature (past the length guard, into the buffer guard)', () => {
    // A SHA-256 hex digest is 64 chars. Forge one that is 64 chars but not hex:
    // it survives the `a.length !== b.length` guard and must be rejected by the
    // empty/short-buffer guard inside constantTimeHexEqual — never throwing.
    const body = JSON.stringify(samplePayload());
    const sixtyFourNonHex = 'z'.repeat(64);
    expect(sixtyFourNonHex.length).toBe(sign(body).length);
    let res: ReturnType<ReturnType<typeof adapter>['verifyWebhook']>;
    expect(() => {
      res = adapter().verifyWebhook(body, { 'Payload-Signature': sixtyFourNonHex });
    }).not.toThrow();
    expect(res!.ok).toBe(false);
  });

  it('reads the signature header case-insensitively', () => {
    const body = JSON.stringify(samplePayload());
    const res = adapter().verifyWebhook(body, { 'payload-signature': sign(body) });
    expect(res.ok).toBe(true);
  });

  it('verifies over the EXACT raw bytes (re-serialized JSON would not match)', () => {
    // A body with non-canonical spacing; signing the raw string is what counts.
    const body = '{ "id":"x", "changed_at":"t", "actions":[], "references":[] }';
    const res = adapter().verifyWebhook(body, { 'Payload-Signature': sign(body) });
    expect(res.ok).toBe(true);
    // The same object re-serialized compactly produces a different signature.
    const compact = JSON.stringify(JSON.parse(body));
    const res2 = adapter().verifyWebhook(body, { 'Payload-Signature': sign(compact) });
    expect(res2.ok).toBe(false);
  });
});

describe('ShortcutAdapter.parseEvent (owner_ids.adds → AdapterEvent)', () => {
  it('detects an owner-add of a registered agent on the sample payload', () => {
    const body = JSON.stringify(samplePayload());
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([
      {
        type: 'task.assigned',
        platform: 'shortcut',
        externalStoryId: '5001',
        agentExternalId: ELVIS,
      },
    ]);
  });

  it('does NOT treat the actor member_id as an assignee', () => {
    // member_id is the actor; only owner_ids.adds is the assignee. Here the
    // actor is Elvis-the-registered-agent but no owner was added → no event.
    const body = JSON.stringify(
      samplePayload({
        member_id: ELVIS,
        actions: [{ id: 5001, entity_type: 'story', action: 'update', changes: {} }],
      })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('handles multiple owner_ids.adds (one event per registered agent)', () => {
    const body = JSON.stringify(
      samplePayload({
        actions: [
          {
            id: 5001,
            entity_type: 'story',
            action: 'update',
            changes: { owner_ids: { adds: [ELVIS, MONA] } },
          },
        ],
      })
    );
    const events = assigned(adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED));
    expect(events.map((e) => e.agentExternalId)).toEqual([ELVIS, MONA]);
    expect(events.every((e) => e.externalStoryId === '5001')).toBe(true);
  });

  it('ignores a non-registered owner UUID (human teammate)', () => {
    const body = JSON.stringify(
      samplePayload({
        actions: [
          {
            id: 5001,
            entity_type: 'story',
            action: 'update',
            changes: { owner_ids: { adds: [HUMAN, ELVIS] } },
          },
        ],
      })
    );
    const events = assigned(adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED));
    expect(events.map((e) => e.agentExternalId)).toEqual([ELVIS]);
  });

  it('emits no event for a removes-only owner change', () => {
    const body = JSON.stringify(
      samplePayload({
        actions: [
          {
            id: 5001,
            entity_type: 'story',
            action: 'update',
            changes: { owner_ids: { removes: [ELVIS] } },
          },
        ],
      })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('ignores non-story / non-update actions', () => {
    const body = JSON.stringify(
      samplePayload({
        actions: [
          { id: 7, entity_type: 'story', action: 'create', changes: { owner_ids: { adds: [ELVIS] } } },
          { id: 8, entity_type: 'epic', action: 'update', changes: { owner_ids: { adds: [ELVIS] } } },
        ],
      })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('falls back to envelope primary_id when an action carries no id', () => {
    const body = JSON.stringify(
      samplePayload({
        primary_id: 'story-xyz',
        actions: [
          { entity_type: 'story', action: 'update', changes: { owner_ids: { adds: [ELVIS] } } },
        ],
      })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([
      { type: 'task.assigned', platform: 'shortcut', externalStoryId: 'story-xyz', agentExternalId: ELVIS },
    ]);
  });

  it('returns [] for a malformed (Zod-rejected) payload', () => {
    // Missing required top-level `id` / `changed_at`.
    const body = JSON.stringify({ actions: 'not-an-array' });
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('returns [] for non-JSON raw body', () => {
    const events = adapter().parseEvent({ ok: true, rawBody: 'not json {' }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('emits at most one event per (story, agent) — dedupes a repeated owner-add across actions', () => {
    // The same (story 5001, Elvis) pair recurs: once via a duplicate inside one
    // adds[], once via a second story.update action on the same story. The
    // coordination loop must not double-dispatch → exactly one event.
    const body = JSON.stringify(
      samplePayload({
        actions: [
          { id: 5001, entity_type: 'story', action: 'update', changes: { owner_ids: { adds: [ELVIS, ELVIS] } } },
          { id: 5001, entity_type: 'story', action: 'update', changes: { owner_ids: { adds: [ELVIS] } } },
        ],
      })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([
      { type: 'task.assigned', platform: 'shortcut', externalStoryId: '5001', agentExternalId: ELVIS },
    ]);
  });
});

describe('ShortcutAdapter.parseEvent — story-comment CREATE → task.clarification_reply (EM v1 slice 3)', () => {
  // The parent story id is the action's primary_id; the commenter is the envelope member_id (the actor),
  // carried as replierMemberId so the resume handler can drop the EM's OWN posted questions.
  function commentPayload(entityType: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify(
      samplePayload({
        actions: [{ id: 9001, entity_type: entityType, action: 'create', primary_id: 5001 }],
        ...overrides,
      })
    );
  }

  it("recognizes entity_type 'story-comment'", () => {
    const events = adapter().parseEvent({ ok: true, rawBody: commentPayload('story-comment') }, REGISTERED);
    expect(events).toEqual([
      { type: 'task.clarification_reply', platform: 'shortcut', externalStoryId: '5001', replierMemberId: ACTOR },
    ]);
  });

  it("recognizes the alternate spelling 'story_comment'", () => {
    const events = adapter().parseEvent({ ok: true, rawBody: commentPayload('story_comment') }, REGISTERED);
    expect(events).toEqual([
      { type: 'task.clarification_reply', platform: 'shortcut', externalStoryId: '5001', replierMemberId: ACTOR },
    ]);
  });

  it('falls back to the envelope primary_id when the action carries no primary_id', () => {
    const body = JSON.stringify(
      samplePayload({ primary_id: 7777, actions: [{ id: 9001, entity_type: 'story-comment', action: 'create' }] })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([
      { type: 'task.clarification_reply', platform: 'shortcut', externalStoryId: '7777', replierMemberId: ACTOR },
    ]);
  });

  it('emits at most one reply per story across a split envelope', () => {
    const body = JSON.stringify(
      samplePayload({
        actions: [
          { id: 9001, entity_type: 'story-comment', action: 'create', primary_id: 5001 },
          { id: 9002, entity_type: 'story-comment', action: 'create', primary_id: 5001 },
        ],
      })
    );
    expect(adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED)).toHaveLength(1);
  });

  it('does NOT emit a reply for a comment UPDATE (only create)', () => {
    const body = JSON.stringify(
      samplePayload({ actions: [{ id: 9001, entity_type: 'story-comment', action: 'update', primary_id: 5001 }] })
    );
    expect(adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED)).toEqual([]);
  });

  it('does NOT emit a reply for a story update (the owner-add path is unaffected)', () => {
    // The default sample is a story update → a task.assigned, never a clarification reply.
    const events = adapter().parseEvent({ ok: true, rawBody: JSON.stringify(samplePayload()) }, REGISTERED);
    expect(events.every((e) => e.type === 'task.assigned')).toBe(true);
  });
});

describe('ShortcutAdapter constructor (secret guard)', () => {
  it('refuses to construct with an empty webhook secret (forgeable signature)', () => {
    expect(() => new ShortcutAdapter({ webhookSecret: '' })).toThrow(/webhookSecret/);
  });
});

describe('ShortcutAdapter.dedupeBySelf', () => {
  it('drops events whose actor is one of our own persona member UUIDs', () => {
    const a = adapter({ selfMemberIds: new Set([SELF_MEMBER]) });
    const events = [
      { type: 'task.assigned' as const, platform: 'shortcut' as const, externalStoryId: '1', agentExternalId: ELVIS },
    ];
    expect(a.dedupeBySelf(events, SELF_MEMBER)).toEqual([]);
  });

  it('keeps events whose actor is an external member (a real human assignment)', () => {
    const a = adapter({ selfMemberIds: new Set([SELF_MEMBER]) });
    const events = [
      { type: 'task.assigned' as const, platform: 'shortcut' as const, externalStoryId: '1', agentExternalId: ELVIS },
    ];
    expect(a.dedupeBySelf(events, ACTOR)).toEqual(events);
  });

  it('keeps events when the actor is undefined', () => {
    const a = adapter({ selfMemberIds: new Set([SELF_MEMBER]) });
    const events = [
      { type: 'task.assigned' as const, platform: 'shortcut' as const, externalStoryId: '1', agentExternalId: ELVIS },
    ];
    expect(a.dedupeBySelf(events, undefined)).toEqual(events);
  });
});

describe('ShortcutAdapter.parseAndDedupe', () => {
  it('drops an envelope whose actor member_id is one of our personas', () => {
    // The same owner-add that parseEvent would emit, but the actor is OUR persona
    // (a round-tripped write) → parseAndDedupe reads member_id off the payload and
    // drops it.
    const body = JSON.stringify(samplePayload({ member_id: SELF_MEMBER }));
    const a = adapter({ selfMemberIds: new Set([SELF_MEMBER]) });
    expect(a.parseAndDedupe({ ok: true, rawBody: body }, REGISTERED)).toEqual([]);
  });

  it('returns the normal events when the actor is an external member', () => {
    const body = JSON.stringify(samplePayload({ member_id: ACTOR }));
    const a = adapter({ selfMemberIds: new Set([SELF_MEMBER]) });
    expect(a.parseAndDedupe({ ok: true, rawBody: body }, REGISTERED)).toEqual([
      {
        type: 'task.assigned',
        platform: 'shortcut',
        externalStoryId: '5001',
        agentExternalId: ELVIS,
      },
    ]);
  });
});

describe('ShortcutWebhookV1Schema (Zod boundary guard)', () => {
  it('accepts the published sample payload', () => {
    expect(ShortcutWebhookV1Schema.safeParse(samplePayload()).success).toBe(true);
  });

  it('rejects a malformed payload (actions not an array)', () => {
    expect(ShortcutWebhookV1Schema.safeParse({ id: 'x', changed_at: 't', actions: 5 }).success).toBe(false);
  });

  it('tolerates unknown extra fields (passthrough)', () => {
    const parsed = ShortcutWebhookV1Schema.safeParse(samplePayload({ unknown_field: { nested: true } }));
    expect(parsed.success).toBe(true);
  });
});

describe('ShortcutAdapter.registerWebhook (REST v3, injected fetch)', () => {
  it('POSTs to /api/v3/integrations/webhook with the Shortcut-Token and returns the id', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ id: 778899 }), { status: 201 });
    }) as unknown as typeof fetch;

    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    const id = await a.registerWebhook({
      webhookUrl: 'https://tasca.example/hooks/shortcut',
      secret: SECRET,
      token: 'tok_admin_123',
    });

    expect(id).toBe('778899');
    expect(captured?.url).toBe('https://api.example.test/api/v3/integrations/webhook');
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Shortcut-Token']).toBe('tok_admin_123');
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      webhook_url: 'https://tasca.example/hooks/shortcut',
      secret: SECRET,
    });
  });

  it('throws on a non-2xx response', async () => {
    const fakeFetch = (async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(
      a.registerWebhook({ webhookUrl: 'https://x', secret: SECRET, token: 't' })
    ).rejects.toThrow(/403/);
  });

  it('throws on a 2xx response that omits the webhook id', async () => {
    // A success status with no `id` would otherwise yield the string "undefined"
    // as a webhook id — refuse it so the caller cannot store a bogus handle.
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 201 })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(
      a.registerWebhook({ webhookUrl: 'https://x', secret: SECRET, token: 't' })
    ).rejects.toThrow(/missing webhook id/i);
  });
});

describe('ShortcutAdapter.postStoryComment (REST v3, injected fetch — slice SC-3)', () => {
  it('POSTs to /api/v3/stories/:id/comments with the agent token + {text}', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as unknown as typeof fetch;

    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    await a.postStoryComment({ token: 'tok_agent_elvis', storyId: '778899', text: 'PR opened\nPR: https://x/pull/1' });

    expect(captured?.url).toBe('https://api.example.test/api/v3/stories/778899/comments');
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Shortcut-Token']).toBe('tok_agent_elvis');
    expect(JSON.parse(String(captured?.init.body))).toEqual({ text: 'PR opened\nPR: https://x/pull/1' });
  });

  it('url-encodes the story id', async () => {
    let captured: string | undefined;
    const fakeFetch = (async (url: string | URL | Request) => {
      captured = String(url);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    await a.postStoryComment({ token: 't', storyId: 'a/b', text: 'x' });
    expect(captured).toBe('https://api.example.test/api/v3/stories/a%2Fb/comments');
  });

  it('throws on a non-2xx response (the reporter swallows it)', async () => {
    const fakeFetch = (async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(
      a.postStoryComment({ token: 't', storyId: '1', text: 'x' })
    ).rejects.toThrow(/403/);
  });
});

describe('ShortcutAdapter.fetchStory (REST v3, injected fetch — slice SC-2)', () => {
  it('GETs /api/v3/stories/:id with the read token and maps name/description', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({ name: 'Fix the parser', description: 'It crashes on empty input.' }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    const story = await a.fetchStory({ token: 'tok_read_workspace', storyId: '778899' });

    expect(story).toEqual({ name: 'Fix the parser', description: 'It crashes on empty input.' });
    expect(captured?.url).toBe('https://api.example.test/api/v3/stories/778899');
    expect(captured?.init.method).toBe('GET');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Shortcut-Token']).toBe('tok_read_workspace');
    expect(captured?.init.body).toBeUndefined(); // a read carries no body
  });

  it('url-encodes the story id', async () => {
    let captured: string | undefined;
    const fakeFetch = (async (url: string | URL | Request) => {
      captured = String(url);
      return new Response(JSON.stringify({ name: 'x', description: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    await a.fetchStory({ token: 't', storyId: 'a/b' });
    expect(captured).toBe('https://api.example.test/api/v3/stories/a%2Fb');
  });

  it('maps a missing/null description to null', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ name: 'No body story' }), { status: 200 })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    const story = await a.fetchStory({ token: 't', storyId: '1' });
    expect(story).toEqual({ name: 'No body story', description: null });
  });

  it('throws on a non-2xx response (the content source falls back)', async () => {
    const fakeFetch = (async () =>
      new Response('not found', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(a.fetchStory({ token: 't', storyId: '1' })).rejects.toThrow(/404/);
  });

  it('throws on a 2xx response missing the story name (malformed external input)', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ description: 'no name' }), { status: 200 })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(a.fetchStory({ token: 't', storyId: '1' })).rejects.toThrow(/missing story name/i);
  });
});

describe('ShortcutAdapter.fetchStoryComments (REST v3, injected fetch — slice 3)', () => {
  it('reads the story comments (text + author_id), in order, with the token in the header', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          name: 'Story',
          comments: [
            { text: 'Which service?', author_id: 'em-id' },
            { text: 'The billing service.', author_id: 'human-id' },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    const out = await a.fetchStoryComments({ token: 'tok_em_SECRET', storyId: '5001' });
    expect(out).toEqual([
      { text: 'Which service?', author: 'em-id' },
      { text: 'The billing service.', author: 'human-id' },
    ]);
    expect(captured?.url).toBe('https://api.example.test/api/v3/stories/5001');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Shortcut-Token']).toBe('tok_em_SECRET');
  });

  it('skips malformed comments (non-string/empty text) and tolerates a missing author', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ comments: [{ text: '' }, { text: 42 }, { text: 'ok, no author' }] }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    expect(await a.fetchStoryComments({ token: 't', storyId: '1' })).toEqual([{ text: 'ok, no author' }]);
  });

  it('returns [] when the story has no comments array', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ name: 'no comments' }), { status: 200 })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    expect(await a.fetchStoryComments({ token: 't', storyId: '1' })).toEqual([]);
  });

  it('throws on a non-2xx (the gate falls back to the story alone)', async () => {
    const fakeFetch = (async () =>
      new Response('boom', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(a.fetchStoryComments({ token: 't', storyId: '1' })).rejects.toThrow(/500/);
  });
});

describe('ShortcutAdapter gated halves (stubbed)', () => {
  it('provisionIdentity throws the gated error citing the brief', async () => {
    await expect(adapter().provisionIdentity('agent_elvis', {})).rejects.toThrow(
      /gated: pending Shortcut confirmation.*item 2/
    );
  });

  it('postStatus throws the gated error citing the brief', async () => {
    const binding = {
      id: 'b1',
      agentId: 'agent_elvis',
      platform: 'shortcut' as const,
      externalId: ELVIS,
      externalHandle: '@elvis',
      credentialRef: 'secret://x',
      state: 'active' as const,
    };
    await expect(adapter().postStatus(binding, { comment: 'hi' })).rejects.toThrow(/gated/);
  });
});
