import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ShortcutWebhookV1Schema,
  type AdapterEvent,
  type PlatformAdapter,
  type Reject,
  type StatusUpdate,
  type VerifiedEvent,
} from '@tasca/contracts';
import type { IdentityBinding, Platform } from '@tasca/domain';

// @tasca/adapters — the Shortcut platform adapter (scaffold §4.2; brief
// "Buildable NOW"). Implements ONLY the ungated intake half against the
// documented Outgoing Webhook v1 + REST v3 surfaces:
//   - verifyWebhook : HMAC-SHA-256 of the raw body vs the Payload-Signature header
//   - parseEvent    : story.update owner_ids.adds ∩ registered agents → AdapterEvent
//   - registerWebhook: POST /api/v3/integrations/webhook → webhook id
//   - dedupeBySelf  : drop our own round-tripped writes (actor == our persona)
// The gated halves (provisionIdentity / postStatus) are typed but THROW — they
// depend on kickoff confirmations #2/#4 (see docs/Tasca-Shortcut-Kickoff-Brief.md).
//
// Boundary: imports only @tasca/{domain,contracts} + node builtins.
// NO new runtime deps — node:crypto / node:fetch only.

const GATED_MESSAGE =
  'gated: pending Shortcut confirmation — see docs/Tasca-Shortcut-Kickoff-Brief.md item 2 (token-issuance model)';

/** The header Shortcut signs the raw body into (HMAC-SHA-256, hex). */
const SIGNATURE_HEADER = 'payload-signature';

/** Shortcut REST v3 base. Overridable for tests; no trailing slash. */
const DEFAULT_API_BASE = 'https://api.app.shortcut.com';

export interface ShortcutAdapterConfig {
  /** The workspace webhook secret used to verify the Payload-Signature HMAC. */
  webhookSecret: string;
  /**
   * Our own persona member UUIDs. Events whose ACTOR `member_id` is in this set
   * are our writes round-tripping back through the stream — dedupeBySelf drops
   * them. Distinct from the *assignee* agent ids passed to parseEvent.
   */
  selfMemberIds?: ReadonlySet<string>;
  /** REST v3 base override (tests). Defaults to the public Shortcut API. */
  apiBase?: string;
  /** fetch override (tests). Defaults to global fetch (node:fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * Look up a header case-insensitively (Node lowercases incoming header names,
 * but callers may forward a mixed-case map — normalize defensively).
 */
function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/**
 * Constant-time compare of two hex signatures. Returns false (never throws) on
 * any length mismatch or non-hex input, so a malformed signature is a clean
 * reject rather than an exception. timingSafeEqual requires equal-length
 * buffers, so the length guard precedes it — but the actual byte comparison
 * stays constant-time for equal-length inputs (the only case an attacker
 * controls once a length is fixed).
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Case-insensitivity is a property of the hex→byte DECODE (Buffer.from(..,'hex')
  // is case-insensitive) plus timingSafeEqual on the resulting bytes — NOT of the
  // length guard above. A future refactor must not "optimize" this into a raw
  // string compare: that would be case-sensitive and non-constant-time.
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  // Buffer.from('zz','hex') yields an empty/short buffer silently — guard length.
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class ShortcutAdapter implements PlatformAdapter {
  readonly platform: Platform = 'shortcut';

  private readonly webhookSecret: string;
  private readonly selfMemberIds: ReadonlySet<string>;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ShortcutAdapterConfig) {
    if (!config.webhookSecret) {
      // An empty secret would make verifyWebhook accept any body signed with the
      // empty-key HMAC — i.e. a forgeable signature. Refuse to construct.
      throw new Error('ShortcutAdapter: webhookSecret is required and must be non-empty');
    }
    this.webhookSecret = config.webhookSecret;
    this.selfMemberIds = config.selfMemberIds ?? new Set();
    this.apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Verify HMAC-SHA-256 over the RAW UTF-8 body keyed by the workspace secret,
   * compared CONSTANT-TIME against the `Payload-Signature` header. Rejects on a
   * missing or mismatched signature. Never throws — returns a discriminated
   * VerifiedEvent | Reject so the endpoint can fast-ack/reject without exception
   * flow. The signature MUST be computed over the exact bytes received (the raw
   * body), not a re-serialized JSON object.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>
  ): VerifiedEvent | Reject {
    const provided = getHeader(headers, SIGNATURE_HEADER);
    if (!provided) {
      return { ok: false, reason: 'missing Payload-Signature header' };
    }
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody, 'utf8').digest('hex');
    if (!constantTimeHexEqual(provided.trim(), expected)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    return { ok: true, rawBody };
  }

  /**
   * Parse a verified webhook into normalized `AdapterEvent`s. Validates the
   * payload with the Zod schema FIRST (malformed → []), then scans `actions[]`:
   *
   *   - `entity_type:'story'` && `action:'update'` whose `changes.owner_ids.adds`
   *     intersects the registered `agentExternalIds` set → one `task.assigned` per
   *     matching owner-add UUID (the assignment signal).
   *   - a story-comment CREATE (`entity_type` `'story-comment'` or `'story_comment'`
   *     — accepted both spellings defensively — && `action:'create'`) → one
   *     `task.clarification_reply` (EM v1 slice 3). The parent story is the id of the
   *     COMPANION `entity_type:'story', action:'update'` action (Shortcut pairs the
   *     comment-create with a story update linking it via `changes.comment_ids.adds`)
   *     — NOT `primary_id`, which on a comment webhook is the COMMENT id. The commenter
   *     is the comment action's own `author_id`, carried as `replierMemberId` so the
   *     resume handler drops the EM's OWN round-tripped questions (replier == the
   *     project manager's member id) and re-triggers only on a real human reply.
   *
   * The top-level `member_id` is the ACTOR. For `task.assigned` it is the assignER,
   * never the assignee, so it is not consulted there (self-dedupe is a SEPARATE
   * concern; see `dedupeBySelf`).
   */
  parseEvent(verified: VerifiedEvent, agentExternalIds: ReadonlySet<string>): AdapterEvent[] {
    let raw: unknown;
    try {
      raw = JSON.parse(verified.rawBody);
    } catch {
      return [];
    }
    const parsed = ShortcutWebhookV1Schema.safeParse(raw);
    if (!parsed.success) return [];
    const payload = parsed.data;

    const events: AdapterEvent[] = [];
    // De-dup by (story, agent): the same pair can recur within one adds[] or
    // across multiple story.update actions in a single envelope — emit at most
    // one event per pair so the coordination loop never double-dispatches.
    const seen = new Set<string>();
    const envelopeStoryId = payload.primary_id !== undefined ? String(payload.primary_id) : undefined;
    // The PARENT story of a comment is NOT the envelope/comment `primary_id` (on a comment webhook that is
    // the COMMENT id), and the comment action carries no story id of its own. Shortcut pairs the
    // story-comment CREATE with a companion `entity_type:'story', action:'update'` whose `id` IS the story
    // (its `changes.comment_ids.adds` link the two). So resolve the reply's story from that story action.
    const commentParentStoryId = payload.actions.find(
      (a) => a.entity_type === 'story' && a.id !== undefined
    )?.id;
    const replyStoryId = commentParentStoryId !== undefined ? String(commentParentStoryId) : undefined;
    // Emit at most one clarification-reply per story per envelope (a single comment
    // create can recur if Shortcut splits an envelope) so the resume isn't re-triggered twice.
    const seenReplyStories = new Set<string>();

    for (const action of payload.actions) {
      // (2) Story-comment CREATE → a clarification reply (EM v1 slice 3). Both `story-comment` and
      // `story_comment` spellings are accepted (the outgoing-webhook docs are not explicit on which).
      if (
        (action.entity_type === 'story-comment' || action.entity_type === 'story_comment') &&
        action.action === 'create'
      ) {
        // The parent story is the companion story action's id (resolved above) — never the comment's own
        // id / the envelope primary_id. Skip if no story action is present (nothing to re-trigger).
        if (!replyStoryId || seenReplyStories.has(replyStoryId)) continue;
        seenReplyStories.add(replyStoryId);
        // The commenter is THIS comment action's `author_id` (the human's member id, or the EM's own when
        // the EM's questions round-trip). The resume dedup compares it to the manager's Shortcut member id
        // so the EM never re-triggers itself. Fall back to the envelope actor if author_id is absent.
        const replier = action.author_id ?? payload.member_id;
        events.push({
          type: 'task.clarification_reply',
          platform: 'shortcut',
          externalStoryId: replyStoryId,
          ...(replier !== undefined ? { replierMemberId: String(replier) } : {}),
        });
        continue;
      }

      // (1) Story UPDATE owner_ids.adds ∩ registered agents → task.assigned.
      if (action.entity_type !== 'story' || action.action !== 'update') continue;
      const adds = action.changes?.owner_ids?.adds;
      if (!adds || adds.length === 0) continue;

      // The story id is the action's own id when present, else the envelope's
      // primary_id. Skip if neither is resolvable (no story to route to).
      const storyId = action.id !== undefined ? String(action.id) : envelopeStoryId;
      if (!storyId) continue;

      for (const ownerId of adds) {
        // Only owner-adds that match a REGISTERED agent-user become events.
        // A non-registered owner add (a human teammate) is ignored.
        if (!agentExternalIds.has(ownerId)) continue;
        const key = `${storyId} ${ownerId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          type: 'task.assigned',
          platform: 'shortcut',
          externalStoryId: storyId,
          agentExternalId: ownerId,
        });
      }
    }
    return events;
  }

  /**
   * Drop events that originated from our OWN writes round-tripping through the
   * outgoing stream. The webhook envelope's actor `member_id` is matched against
   * our persona member UUIDs; if it is one of ours, every event from that
   * envelope is our echo and must not be re-dispatched.
   *
   * Because `parseEvent` discards `member_id` (correctly — it is the actor, not
   * the assignee), the actor must be supplied here explicitly. Callers pass the
   * `member_id` they read off the same verified payload they parsed.
   */
  dedupeBySelf(events: AdapterEvent[], actorMemberId: string | undefined): AdapterEvent[] {
    if (actorMemberId !== undefined && this.selfMemberIds.has(actorMemberId)) {
      return [];
    }
    return events;
  }

  /**
   * Convenience wrapper: parse the verified envelope AND self-dedupe in one call,
   * reading the actor `member_id` ONCE off the same payload so the caller does not
   * have to re-extract it. Equivalent to
   * `dedupeBySelf(parseEvent(verified, agentExternalIds), <member_id>)`.
   * `parseEvent` / `dedupeBySelf` remain the public primitives.
   */
  parseAndDedupe(verified: VerifiedEvent, agentExternalIds: ReadonlySet<string>): AdapterEvent[] {
    const events = this.parseEvent(verified, agentExternalIds);
    let actorMemberId: string | undefined;
    try {
      const raw = JSON.parse(verified.rawBody);
      const parsed = ShortcutWebhookV1Schema.safeParse(raw);
      if (parsed.success) actorMemberId = parsed.data.member_id;
    } catch {
      // A non-JSON / malformed body yields no events from parseEvent above; the
      // actor stays undefined and dedupeBySelf is a no-op on the empty list.
    }
    return this.dedupeBySelf(events, actorMemberId);
  }

  /**
   * Self-register the outgoing webhook at install:
   * `POST /api/v3/integrations/webhook {webhook_url, secret}` with the
   * `Shortcut-Token` header (REST v3). Resolves to the created webhook id (a
   * string) so it can be deleted later. Uses node:fetch — no new deps.
   */
  async registerWebhook(input: {
    webhookUrl: string;
    secret: string;
    token: string;
  }): Promise<string> {
    const res = await this.fetchImpl(`${this.apiBase}/api/v3/integrations/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shortcut-Token': input.token,
      },
      body: JSON.stringify({ webhook_url: input.webhookUrl, secret: input.secret }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`shortcut registerWebhook failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    const json = (await res.json()) as { id?: string | number };
    if (json.id === undefined || json.id === null) {
      throw new Error('shortcut registerWebhook: response missing webhook id');
    }
    return String(json.id);
  }

  /**
   * Post a comment onto a Shortcut story under the AGENT'S OWN Agent-User token
   * (slice SC-3): `POST /api/v3/stories/:storyId/comments {text}` with the
   * per-agent `Shortcut-Token` header — so the comment is attributed to the
   * agent's native Shortcut identity. Throws on a non-2xx (the coordination
   * status reporter swallows it; the PR is already open). The token rides ONLY in
   * the header — it is never logged here or by the reporter.
   */
  async postStoryComment(input: { token: string; storyId: string; text: string }): Promise<void> {
    const res = await this.fetchImpl(
      `${this.apiBase}/api/v3/stories/${encodeURIComponent(input.storyId)}/comments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Shortcut-Token': input.token,
        },
        body: JSON.stringify({ text: input.text }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`shortcut postStoryComment failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
  }

  /**
   * Read a story's title + body for tier estimation (slice SC-2):
   * `GET /api/v3/stories/:storyId` with the connection's workspace READ token in
   * the `Shortcut-Token` header. Returns the story `name` (title) + `description`
   * (body, null when empty). Throws on a non-2xx so the content source can fall
   * back to the stub. The token rides ONLY in the header — never logged here. The
   * response shape is minimally validated (it is external input): a missing/wrong-
   * typed `name` is a malformed story → throw.
   */
  async fetchStory(input: { token: string; storyId: string }): Promise<{
    name: string;
    description: string | null;
  }> {
    const res = await this.fetchImpl(
      `${this.apiBase}/api/v3/stories/${encodeURIComponent(input.storyId)}`,
      {
        method: 'GET',
        headers: { 'Shortcut-Token': input.token },
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`shortcut fetchStory failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    const json = (await res.json()) as { name?: unknown; description?: unknown };
    if (typeof json.name !== 'string') {
      throw new Error('shortcut fetchStory: response missing story name');
    }
    return {
      name: json.name,
      description: typeof json.description === 'string' ? json.description : null,
    };
  }

  /**
   * Read a story's comment thread (EM v1 slice 3) for the EM's conversation-aware re-review:
   * `GET /api/v3/stories/:storyId` returns the story WITH its `comments` array, each `{ text, author_id }`.
   * Returns the comments in document order as `{ author?, text }` (the author is the commenter's member id
   * when present — names aren't on the story object). Throws on a non-2xx so the gate can fall back to
   * judging on the story alone (fail-soft). The token rides ONLY in the header — never logged. The shape
   * is external input: each comment is minimally validated (a non-string/empty `text` is skipped), so a
   * malformed entry degrades to fewer comments rather than throwing.
   */
  async fetchStoryComments(input: { token: string; storyId: string }): Promise<
    Array<{ author?: string; text: string }>
  > {
    const res = await this.fetchImpl(
      `${this.apiBase}/api/v3/stories/${encodeURIComponent(input.storyId)}`,
      {
        method: 'GET',
        headers: { 'Shortcut-Token': input.token },
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`shortcut fetchStoryComments failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    const json = (await res.json()) as { comments?: unknown };
    if (!Array.isArray(json.comments)) return [];
    const out: Array<{ author?: string; text: string }> = [];
    for (const raw of json.comments) {
      const c = raw as { text?: unknown; author_id?: unknown };
      if (typeof c.text !== 'string' || c.text.trim().length === 0) continue;
      out.push({
        text: c.text,
        ...(typeof c.author_id === 'string' && c.author_id.length > 0 ? { author: c.author_id } : {}),
      });
    }
    return out;
  }

  /**
   * GATED — write-back identity / provisioning. Throws until the token-issuance
   * model (Shortcut-side token vs Devin-style partner trust) is confirmed. Do
   * NOT implement here; see docs/Tasca-Shortcut-Kickoff-Brief.md item 2.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async provisionIdentity(_agentId: string, _workspaceConn: unknown): Promise<IdentityBinding> {
    throw new Error(GATED_MESSAGE);
  }

  /**
   * GATED — status-back (comment + state + PR link) under the agent's native
   * Shortcut identity. Throws until the token-issuance model is confirmed; the
   * attribution path depends on whether writes carry a per-persona token or an
   * act-as mechanism. See docs/Tasca-Shortcut-Kickoff-Brief.md item 2.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async postStatus(_binding: IdentityBinding, _update: StatusUpdate): Promise<void> {
    throw new Error(GATED_MESSAGE);
  }
}
