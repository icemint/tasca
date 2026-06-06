// The injected seams the coordination loop depends on (scaffold §3). Two of
// these — StatusReporter and WebhookVerifier — are the adapter's job, but
// @tasca/adapters is built on a sibling branch, so we define them HERE as ports
// and inject concrete impls at the composition root LATER. This keeps this
// branch independent of the adapter build (no @tasca/adapters import).
//
// The routing ClaimPort / LlmClassifierPort and the ExecutionPort already exist
// as interfaces in their own packages; we consume those types directly.

import type { AdapterEvent } from '@tasca/contracts';

/**
 * Status-back seam (scaffold §4.1 `postStatus`). The real Shortcut adapter posts
 * a comment + workflow-state change + PR link under the agent's native identity;
 * here it is an injected port so the loop can drive it without importing the
 * adapter. The agent's binding (which native identity to act as) is resolved by
 * the concrete impl from the `agentId`.
 */
export interface StatusUpdate {
  /** The platform story/issue the update targets (Task.externalStoryId). */
  externalStoryId: string;
  /** The agent whose native identity authors the update. */
  agentId: string;
  /** Workflow-state transition to apply on the platform (e.g. 'in_review'). */
  state?: string;
  /** Human-readable progress comment. */
  comment?: string;
  /** PR URL to attach/link, when one exists. */
  prUrl?: string;
}

export interface StatusReporter {
  /** Post a status update to the platform under the agent's native identity. */
  postStatus(update: StatusUpdate): Promise<void>;
}

/** Raw inbound HTTP request material handed to the verifier. */
export interface RawWebhook {
  /** The raw request body bytes/string — verified BEFORE any JSON parse. */
  rawBody: string;
  headers: Record<string, string | undefined>;
}

/** A verified webhook: the platform, its dedupe id, and the validated payload. */
export interface VerifiedWebhook {
  platform: 'shortcut' | 'github' | 'linear';
  /** The platform's event id — the idempotency key for `webhook_event`. */
  externalEventId: string;
  /** Opaque verified payload, handed back to `parse`. */
  payload: unknown;
}

/**
 * Webhook verify + parse seam (scaffold §4.1 `verifyWebhook`/`parseEvent`). The
 * Shortcut adapter does HMAC-SHA-256 over the raw body and normalizes actions[]
 * into AdapterEvents; injected here so the server can stay adapter-agnostic.
 */
export interface WebhookVerifier {
  /** Verify the signature over the RAW body; return null/throw to reject. */
  verify(raw: RawWebhook): VerifiedWebhook | null;
  /** Normalize a verified payload into zero or more internal events. */
  parse(verified: VerifiedWebhook): AdapterEvent[];
}

/**
 * Minimal structured-logging seam. The post-ack orchestration runs detached from
 * the HTTP response, so a rejection there has no caller to surface it — it MUST
 * be logged with context rather than swallowed. Defaults to `console` at the
 * composition root; injectable so a host can route it to its real logger.
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  info?(message: string, context?: Record<string, unknown>): void;
}

// Re-export the proven ports the composition root wires, so consumers import the
// whole coordination seam-set from one place.
export type { ClaimPort, LlmClassifierPort } from '@tasca/routing';
export type { ExecutionPort } from '@tasca/execution';
