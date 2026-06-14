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

// ── PM-assistant (advisory, Wave-3 W3-S1) ─────────────────────────────────────
// The proposer's output is validated here at the trust boundary, exactly like the
// classifier: a malformed/over-long suggestion is rejected → no proposal (never a
// throw, never a binding write). The PM-assistant only ever PROPOSES; acceptance
// routes through the existing org-scoped CAS-guarded binding methods.

/** A routing proposal's payload: which agent to route to, why, and how confident. The
 *  agentName is resolved to a HIRED agent only at ACCEPT time (fail-closed if unhired) —
 *  storing it here is advisory, never binding. Bounded lengths keep an LLM (later kinds)
 *  from persisting unbounded text. */
export const RoutingProposalSchema = z.object({
  agentName: z.string().min(1).max(120),
  why: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
export type RoutingProposal = z.infer<typeof RoutingProposalSchema>;

/** A triage proposal's payload (slice W3-S1b): a suggested tier for a task, with a plain-English
 *  rationale + confidence. Accepting it applies the tier via overrideTierEstimate (version-fenced,
 *  done-guarded) — never a status/claim/routing write. The tier is validated here at the boundary. */
export const TriageProposalSchema = z.object({
  tier: TierSchema,
  why: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
export type TriageProposal = z.infer<typeof TriageProposalSchema>;

/** A decomposition proposal's payload (slice W3-S1c): a draft split of a parent task into smaller
 *  child tasks. Accepting it creates each child via getOrCreateTask (deterministic synthetic story
 *  id → idempotent re-accept) — never a status/claim/routing write on the parent. Bounded sizes keep
 *  an LLM from persisting unbounded text or an unbounded child count. */
export const DecompositionChildSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(4000).default(''),
});
export type DecompositionChild = z.infer<typeof DecompositionChildSchema>;

export const DecompositionProposalSchema = z.object({
  children: z.array(DecompositionChildSchema).min(1).max(10),
  why: z.string().min(1).max(2000),
});
export type DecompositionProposal = z.infer<typeof DecompositionProposalSchema>;

/** An injectable LLM decomposer — splits a parent task into child tasks. The seam both the routing
 *  proposer (consumer) and an LLM client (implementer) share; lives here in contracts so neither has
 *  to depend on the other. No deterministic fallback (a split needs a model), so without one the
 *  decomposition kind yields no suggestion. */
export interface DecomposerPort {
  decompose(input: { title: string; body: string }): Promise<DecompositionProposal | null>;
}

/** Normalized inbound platform event (adapters emit this; coordination consumes it). */
export const AdapterEventSchema = z.object({
  type: z.literal('task.assigned'),
  platform: z.enum(['shortcut', 'github', 'linear']),
  externalStoryId: z.string().min(1),
  agentExternalId: z.string().min(1),
  repoHint: z.string().optional(),
  // Stamped (post-parse, like repoHint) by the connection-scoped Shortcut route (slice SC-1/SC-2) so the
  // content source can resolve THIS connection's read token to fetch the story. Optional + adapter-internal:
  // adapters never emit it; it rides the validated event from the route to content.fetch. A re-driven task
  // that reconstructs the event without it falls back to the stub content (safe/degraded).
  shortcutConnectionId: z.string().optional(),
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

// ── GitHub webhook payload (issues / issue_comment) ──────────────────────────
// The wire shape GitHub POSTs for the two intake events: `issues` (action
// `assigned`) and `issue_comment` (action `created`). Validated at the trust
// boundary before parseEvent inspects it. Only the fields the intake needs are
// modeled; `.passthrough()` tolerates the large remainder GitHub sends. The
// idempotency key is the `X-GitHub-Delivery` HEADER (not a body field), so it is
// not modeled here — the verifier reads it off the headers.

/** A GitHub user (actor / assignee / commenter). Identified by numeric id + login. */
export const GitHubUserSchema = z
  .object({
    id: z.number(),
    login: z.string(),
  })
  .passthrough();

/** The repository the event occurred in. `full_name` is `owner/repo`. */
export const GitHubRepositorySchema = z
  .object({
    full_name: z.string(),
  })
  .passthrough();

/** The issue an event targets. `number` is per-repo; the parser composes a global id. */
export const GitHubIssueSchema = z
  .object({
    number: z.number(),
    node_id: z.string().optional(),
    assignees: z.array(GitHubUserSchema).optional(),
  })
  .passthrough();

/** A comment body — scanned for @-mentions of registered agents. */
export const GitHubCommentSchema = z
  .object({
    id: z.number(),
    body: z.string(),
  })
  .passthrough();

/**
 * The top-level GitHub webhook envelope (issues + issue_comment subset).
 *
 * `sender` is the ACTOR (who triggered the event) — used for self-dedupe, NEVER
 * as an assignee. On an `issues` action `assigned`, the just-assigned user is the
 * top-level `assignee` (distinct from the full `issue.assignees` list). Treating
 * `sender` as the assignee is the same easy bug as Shortcut's `member_id`.
 */
export const GitHubWebhookSchema = z
  .object({
    action: z.string(),
    sender: GitHubUserSchema.optional(),
    repository: GitHubRepositorySchema.optional(),
    issue: GitHubIssueSchema.optional(),
    /** The user just assigned on `issues.assigned` (the assignment signal). */
    assignee: GitHubUserSchema.optional(),
    comment: GitHubCommentSchema.optional(),
  })
  .passthrough();
export type GitHubWebhook = z.infer<typeof GitHubWebhookSchema>;

// ── GitHub App install events (installation / installation_repositories) ──────
// When an org installs (or reconfigures) the App, GitHub delivers an
// `installation` (or `installation_repositories`) event carrying the installation
// id + the installing account login. That mapping (account → installation id) is
// what write-back needs to act under the right installation, so we model just
// those fields here (passthrough tolerates the rest) and expose a parse helper.

/** The installation object: its numeric id + the account it belongs to. */
export const GitHubInstallationSchema = z
  .object({
    id: z.number(),
    account: z
      .object({ login: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ── GitHub pull_request merge events (board auto-complete) ────────────────────
// When an agent's PR is merged, GitHub delivers a `pull_request` event with action
// `closed` and `pull_request.merged === true`. That is the signal to auto-advance
// the linked task to `done` (the board's PR Opened → Completed transition). Only the
// fields the merge detector needs are modeled — the merged flag + the PR's html_url,
// the globally-unique key the store resolves back to an org/task. Distinct from the
// issues/issue_comment intake schema (this is an OUTPUT signal, not a work source).

/** The pull_request object on a `closed` event: was it merged, and its canonical url. */
export const GitHubPullRequestSchema = z
  .object({
    merged: z.boolean().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

/** The `pull_request` event envelope: top-level `action` + the `pull_request` object. */
export const GitHubPullRequestEventSchema = z
  .object({
    action: z.string(),
    pull_request: GitHubPullRequestSchema,
  })
  .passthrough();
export type GitHubPullRequestEvent = z.infer<typeof GitHubPullRequestEventSchema>;

/** The install-event envelope: top-level `action` + the `installation` object. */
export const GitHubInstallationEventSchema = z
  .object({
    action: z.string(),
    installation: GitHubInstallationSchema,
  })
  .passthrough();
export type GitHubInstallationEvent = z.infer<typeof GitHubInstallationEventSchema>;

/** The account→installation mapping an install event carries (or null if absent). */
export interface InstallationMapping {
  installationId: string;
  /** The installing account/org login — the `owner` half of `owner/repo`. */
  accountLogin: string;
  /** The webhook action: `created`/`deleted` (install/uninstall) etc. Drives the connect handler
   *  (slice 5c) — confirm an install, revoke on uninstall. */
  action: string;
}

/**
 * Parse a verified GitHub webhook body into the install mapping it carries, or
 * null when the payload is not an install event with a resolvable account. Pure +
 * total: a malformed or non-install body returns null (never throws), so the
 * server can call it unconditionally and act only on a non-null result.
 */
export function parseInstallationEvent(rawBody: string): InstallationMapping | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = GitHubInstallationEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const login = parsed.data.installation.account?.login;
  if (!login) return null;
  return { installationId: String(parsed.data.installation.id), accountLogin: login, action: parsed.data.action };
}
