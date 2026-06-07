// @tasca/domain — pure domain types & helpers. No I/O, no Node APIs.

// ── Tiers ───────────────────────────────────────────────────────────────────
export const TIERS = ['basic', 'low', 'medium', 'hard', 'ultra'] as const;
export type Tier = (typeof TIERS)[number];

// Derived from TIERS order (the single source of truth) so rank can't drift from
// the list — adding/reordering a tier updates the rank automatically.
const TIER_RANK: Record<Tier, number> = Object.fromEntries(
  TIERS.map((t, i) => [t, i])
) as Record<Tier, number>;

/** True when `have` is at least as capable as `need` (ultra ≥ hard ≥ … ≥ basic). */
export function tierAtLeast(have: Tier, need: Tier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need];
}

export function tierRank(t: Tier): number {
  return TIER_RANK[t];
}

// ── Task state machine ──────────────────────────────────────────────────────
// ingested → routable → claimed → executing → in_review → done
//                          │           │
//                          └───────────┴──► failed ──(breaker N)──► needs_attention
export const TASK_STATUSES = [
  'ingested',
  'routable',
  'claimed',
  'executing',
  'in_review',
  'done',
  'failed',
  'needs_attention',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * The legal status transitions — the state machine's edges, made explicit so a
 * transition can be validated instead of any status being writable over any other.
 * `done` is terminal (the post-merge state; not yet driven by the Stage-1 loop).
 * Retry resets land on `routable`; the breaker trips to `needs_attention`, from
 * which a human can re-drive back to `routable`.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  ingested: ['routable'],
  routable: ['claimed'],
  claimed: ['executing', 'routable', 'needs_attention'],
  executing: ['in_review', 'routable', 'needs_attention'],
  in_review: ['done'],
  done: [],
  failed: ['routable', 'needs_attention'],
  needs_attention: ['routable'],
};

/** True when `to` is a legal next status from `from` (per TASK_TRANSITIONS). */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export interface Task {
  id: string;
  externalStoryId: string;
  platform: 'shortcut' | 'github' | 'linear';
  status: TaskStatus;
  /** Optimistic-lock counter; every transition increments it. CAS operates on (status, version). */
  version: number;
  claimedBy: string | null;
  failureCount: number;
  repoRef: string | null;
  tierEstimate: TierEstimate | null;
}

// ── Tier estimation ─────────────────────────────────────────────────────────
export interface TierFeatures {
  wordCount: number;
  hasReasoningVerb: boolean;
  scopeHint: 'single-file' | 'multi-file' | 'unknown';
  labelTier: Tier | null;
}

export interface TierEstimate {
  tier: Tier;
  /** 0..1 */
  confidence: number;
  signals: TierFeatures;
  classifierUsed: boolean;
}

// ── Agents & capability ─────────────────────────────────────────────────────
export type AgentState = 'idle' | 'working' | 'awaiting_input' | 'blocked' | 'shipped';

export interface CapabilityProfile {
  agentId: string;
  maxTier: Tier;
  tiersCovered: Tier[];
  languageSpecialties: string[];
  frameworkSpecialties: string[];
  concurrencyLimit: number;
  costCeiling: number;
  /** Measured success rate 0..1; null until enough history. */
  successRate: number | null;
  avgLatencyMs: number | null;
}

export interface Agent {
  id: string;
  name: string;
  vendor: 'claude' | 'openai' | 'local';
  model: string;
  state: AgentState;
}

export interface CapabilityMatch {
  agentId: string;
  /** Higher is better. capability-fit × domain-history × availability. */
  score: number;
  eligible: boolean;
  reasons: string[];
}

// ── Agent-identity primitive (Devin-modeled) ──────────────────────────────────
// Every agent is a ServiceUser (a credential-bearing principal, never a fake
// human account) with an internal stable `principalId`, an RBAC role, a
// capability profile, delegation/attribution, and per-platform identity
// bindings. The shared entity *types* live here in domain (alongside Agent /
// CapabilityProfile); the Postgres schema + repositories live in @tasca/identity.

export const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PLATFORMS = ['shortcut', 'github', 'linear'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * The internal credential-bearing principal for an agent (1:1 with `agent`).
 *
 * `principalId` is the internal "who did this" anchor for audit attribution and
 * is **stable across external-credential rotation** — it never depends on any
 * one platform token. This mirrors the Shortcut warning that a `Shortcut-Token`
 * dies when the creating user is removed: the internal principal must outlive
 * any external secret, so audit history stays continuous through re-provisioning.
 */
export interface ServiceUser {
  id: string;
  agentId: string;
  /** Internal stable id used for audit attribution. Survives token rotation. */
  principalId: string;
}

/** Reusable least-privilege role: internal capabilities + per-platform scopes. */
export interface RbacRole {
  id: string;
  name: string;
  /** Internal capabilities, e.g. `task.claim`, `pr.create`, `status.post`. */
  permissions: string[];
  /** Least-privilege scopes to request per platform, keyed by platform. */
  downstreamScopes: Record<string, string[]>;
}

export const IDENTITY_BINDING_STATES = ['provisioned', 'active', 'revoked'] as const;
export type IdentityBindingState = (typeof IDENTITY_BINDING_STATES)[number];

/**
 * One row per platform an agent is deployed into — maps the agent to its NATIVE
 * identity there (Shortcut agent-user in Stage 1; GitHub App / Linear actor=app
 * later).
 *
 * `credentialRef` is a **pointer** into the secret store (NOT the secret).
 * Crucially it is **per-binding**: whether Shortcut resolves to one token per
 * agent or one workspace token acting-as a chosen agent-user is a binding-layer
 * detail, absorbed here without any model change. The stable `principalId` on
 * the agent's `service_user` is unaffected when this `credentialRef` rotates.
 */
export interface IdentityBinding {
  id: string;
  agentId: string;
  platform: Platform;
  /** Native external id, e.g. the Shortcut agent-user id. */
  externalId: string;
  /** Mentionable @handle on the platform. */
  externalHandle: string | null;
  /** Pointer to the secret store — never the secret itself. Per-binding. */
  credentialRef: string | null;
  state: IdentityBindingState;
}

/** Human-of-record / attribution (Devin `create_as_user_id` analogue). */
export interface Delegation {
  agentId: string;
  onBehalfOfUserId: string;
  attributionLabel: string;
}

/**
 * An immutable record of a privileged action, attributed to a stable
 * `principalId` (never to an external credential).
 */
export interface AuditEvent {
  id: string;
  /** The acting agent's stable service-user principal id. */
  principalId: string;
  agentId: string;
  action: string;
  /** Optional target (task / story / PR id). */
  target: string | null;
  platform: Platform | null;
  payload: Record<string, unknown>;
  at: Date;
}

// ── Claim (CAS) ─────────────────────────────────────────────────────────────
// On a LOSS the conditional UPDATE affects 0 rows for three distinct reasons —
// another worker claimed it (lost race), the expectedVersion was stale, or the
// task doesn't exist. `won:false` alone can't tell a retryable loss from a
// terminal one, so the outcome also surfaces the row's CURRENT state (`found` +
// `currentStatus` + `currentVersion`) — enough to build a correct re-query/retry
// loop. On a WIN these describe the post-claim row.
export interface ClaimOutcome {
  won: boolean;
  /** New version after a winning claim (was expectedVersion + 1). */
  newVersion: number | null;
  /** False when no task row exists for the id. */
  found?: boolean;
  /** The row's current status (on loss: why the CAS missed; on win: 'claimed'). */
  currentStatus?: TaskStatus | null;
  /** The row's current version (lets a retry re-issue with the right expectedVersion). */
  currentVersion?: number | null;
}

/**
 * The result of `atomicClaim`. Structurally identical to the port's `ClaimOutcome`
 * (the engine adds no fields) — kept as an alias so the routing layer can name its
 * return without re-declaring the shape and risking drift.
 */
export type ClaimResult = ClaimOutcome;

// ── Ports ───────────────────────────────────────────────────────────────────
// Defined in domain so the engine (consumer) and db/adapters (implementers) can
// each depend on the interface without importing one another — the dependency
// rule (arrows point inward to domain) holds.

/** Persistence port for the atomic single-claim. Implemented by `@tasca/db`. */
export interface ClaimPort {
  /** CAS: claim `taskId` for `agentId` iff still `routable` at `expectedVersion`. */
  tryClaim(taskId: string, agentId: string, expectedVersion: number): Promise<ClaimOutcome>;
}

/** The lightweight LLM tier classifier — one budgeted call returning tier + confidence. */
export interface LlmClassifierPort {
  classify(input: {
    title: string;
    body: string;
    features: TierFeatures;
  }): Promise<{ tier: Tier; confidence: number }>;
}
