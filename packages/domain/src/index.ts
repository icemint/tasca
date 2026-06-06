// @tasca/domain — pure domain types & helpers. No I/O, no Node APIs.

// ── Tiers ───────────────────────────────────────────────────────────────────
export const TIERS = ['basic', 'low', 'medium', 'hard', 'ultra'] as const;
export type Tier = (typeof TIERS)[number];

const TIER_RANK: Record<Tier, number> = { basic: 0, low: 1, medium: 2, hard: 3, ultra: 4 };

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

// ── Claim (CAS) ─────────────────────────────────────────────────────────────
export interface ClaimResult {
  won: boolean;
  /** New version after a winning claim (was expectedVersion + 1). */
  newVersion: number | null;
}

export interface ClaimOutcome {
  won: boolean;
  newVersion: number | null;
}

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
