import { z } from 'zod';
import { TIERS } from '@tasca/domain';
import type { IdentityBinding, Platform } from '@tasca/domain';

// @tasca/contracts — Zod schemas at every trust boundary; TS types are inferred
// from them (schema is the source of truth). Stage-1 slice: the classifier I/O
// the routing engine validates (reject/fallback on malformed LLM output).

export const TierSchema = z.enum(TIERS);

export const ClassifierOutputSchema = z.object({
  tier: TierSchema,
  confidence: z.number().min(0).max(1),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

/** Normalized inbound platform event (adapters emit this; coordination consumes it). */
export const AdapterEventSchema = z.object({
  type: z.literal('task.assigned'),
  platform: z.enum(['shortcut', 'github', 'linear']),
  externalStoryId: z.string().min(1),
  agentExternalId: z.string().min(1),
  repoHint: z.string().optional(),
});
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;

// ── Platform-adapter seam (scaffold §4.1) ─────────────────────────────────────
// The shared interface both the Shortcut adapter (now) and GitHub/Linear
// adapters (later) implement, and that `@tasca/coordination` consumes. It lives
// here in contracts — not in `@tasca/adapters` — so a consumer can depend on the
// *seam* without importing any concrete adapter, and so adapters don't import
// each other. Adapters emit the normalized `AdapterEvent` above, keeping the
// coordination loop platform-agnostic.

/** A webhook whose signature verified — carries the raw body forward to parse. */
export interface VerifiedEvent {
  ok: true;
  /** The raw UTF-8 request body, verified intact. parseEvent re-parses it. */
  rawBody: string;
}

/** A rejected webhook (bad/absent signature, or unparseable). Never throws. */
export interface Reject {
  ok: false;
  reason: string;
}

/** A status-back update an adapter posts under an agent's native identity. */
export interface StatusUpdate {
  /** Free-text progress comment (e.g. "PR opened"). */
  comment?: string;
  /** Target platform workflow-state id to move the story to (e.g. In Review). */
  workflowStateId?: string;
  /** URL of the opened PR to link/attach. */
  prUrl?: string;
}

/**
 * The platform-adapter seam. Stage-1 ungated halves (`verifyWebhook`,
 * `parseEvent`, `registerWebhook`) are implementable today against documented
 * Shortcut surfaces; the gated halves (`provisionIdentity`, `postStatus`) are
 * typed here but throw until the kickoff confirmations land (see
 * docs/Tasca-Shortcut-Kickoff-Brief.md).
 */
export interface PlatformAdapter {
  readonly platform: Platform;

  /**
   * Verify a webhook signature over the RAW body (constant-time). Pure +
   * synchronous; returns a discriminated result rather than throwing so the
   * caller can fast-ack/reject without exception flow.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): VerifiedEvent | Reject;

  /**
   * Parse a verified webhook into zero or more normalized `AdapterEvent`s.
   * `agentExternalIds` is the registered agent-user id set to match assignments
   * against (only owner-adds intersecting it produce events).
   */
  parseEvent(verified: VerifiedEvent, agentExternalIds: ReadonlySet<string>): AdapterEvent[];

  /** Self-register the outgoing webhook at install; resolves to the webhook id. */
  registerWebhook(input: { webhookUrl: string; secret: string; token: string }): Promise<string>;

  /** GATED: provision/link the agent's native identity. Throws until confirmed. */
  provisionIdentity(agentId: string, workspaceConn: unknown): Promise<IdentityBinding>;

  /** GATED: post status-back (comment + state + PR link). Throws until confirmed. */
  postStatus(binding: IdentityBinding, update: StatusUpdate): Promise<void>;
}

// ── Shortcut Outgoing Webhook v1 payload (scaffold §4.2) ─────────────────────
// The wire shape Shortcut POSTs to our endpoint. Validated at the trust boundary
// before parseEvent inspects it. Only the fields the intake needs are modeled;
// `.passthrough()` tolerates the many other fields Shortcut sends (the schema is
// a guard, not an exhaustive mirror of an undocumented-in-full payload).

/** `changes.owner_ids` on a story update — the assignment signal. */
export const ShortcutOwnerIdsChangeSchema = z.object({
  adds: z.array(z.string()).optional(),
  removes: z.array(z.string()).optional(),
});

/** One entry in `actions[]`. We care about story updates whose owner_ids gained ids. */
export const ShortcutActionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    entity_type: z.string(),
    action: z.string(),
    changes: z
      .object({
        owner_ids: ShortcutOwnerIdsChangeSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ShortcutAction = z.infer<typeof ShortcutActionSchema>;

/**
 * The top-level Outgoing Webhook v1 envelope.
 *
 * `member_id` is the ACTOR (who made the change) — NOT the assignee. The
 * assignee(s) live in `actions[].changes.owner_ids.adds`. Conflating the two is
 * the documented easy bug (brief, item "Assignment intake"); the parser must
 * never treat `member_id` as an assignment target.
 */
export const ShortcutWebhookV1Schema = z
  .object({
    id: z.string(),
    changed_at: z.string(),
    primary_id: z.union([z.string(), z.number()]).optional(),
    /** The ACTOR member UUID. Used for self-dedupe, never as an assignee. */
    member_id: z.string().optional(),
    version: z.string().optional(),
    actions: z.array(ShortcutActionSchema).default([]),
    references: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type ShortcutWebhookV1 = z.infer<typeof ShortcutWebhookV1Schema>;
