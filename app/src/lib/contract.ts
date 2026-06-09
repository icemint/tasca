// The read-API response contract — a PROJECTION of @tasca/domain, copied (not
// imported) so the static Astro app builds without pulling the workspace in.
// These shapes mirror exactly what packages/coordination/src/read-api.ts
// serializes; keep them in sync if that module's wire shapes change.

export const TIERS = ['basic', 'low', 'medium', 'hard', 'ultra'] as const;
export type Tier = (typeof TIERS)[number];

export type TaskStatus =
  | 'ingested'
  | 'routable'
  | 'claimed'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'failed'
  | 'needs_attention';

export type AgentState = 'idle' | 'working' | 'awaiting_input' | 'blocked' | 'shipped';
export type AgentStatus = 'active' | 'paused' | 'retired';
export type Vendor = 'claude' | 'openai' | 'local';
export type Platform = 'shortcut' | 'github' | 'linear';
export type BindingState = 'provisioned' | 'active' | 'revoked';

export interface Capability {
  maxTier: Tier | null;
  tiersCovered: Tier[];
  languageSpecialties: string[];
  frameworkSpecialties: string[];
  concurrencyLimit: number | null;
  costCeiling: number | null;
  successRate: number | null;
}

export interface Agent {
  id: string;
  name: string;
  vendor: Vendor | string;
  model: string;
  status: AgentStatus;
  /** Optimistic-concurrency token echoed on writes (pause/resume/edit). */
  version: number;
  avatarUrl: string | null;
  capability: Capability;
  currentTaskId: string | null;
  state: AgentState;
}

export interface Binding {
  platform: Platform;
  externalHandle: string | null;
  state: BindingState;
}

export interface TaskSummary {
  id: string;
  externalStoryId: string;
  platform: Platform;
  status: TaskStatus;
  /** The estimated tier, or null until estimation runs. */
  tierEstimate: Tier | null;
  repoRef: string | null;
  claimedBy: string | null;
  failureCount: number;
}

export interface AgentDetail extends Agent {
  bindings: Binding[];
  recentTasks: TaskSummary[];
}

export interface RoutingCandidate {
  agentId: string;
  score: number;
  eligible: boolean;
  reasons: string[];
}

export interface RoutingDecision {
  taskId: string;
  tierEstimate: Tier;
  candidates: RoutingCandidate[];
  winnerAgentId: string | null;
  createdAt: string;
}

export interface PullRequest {
  url: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
}

export interface TaskDetail extends TaskSummary {
  /** Human-readable reason for the current state (e.g. why it's in needs_attention).
   *  Null unless set — today the no-execution-capacity path writes it. */
  lastError: string | null;
  routingDecision: RoutingDecision | null;
  pullRequests: PullRequest[];
}

export interface ConnectionPlatform {
  platform: Platform;
  workspaceId: string;
  health: 'healthy' | 'degraded' | 'revoked';
  webhook: {
    received24h: number;
    processed24h: number;
    lastReceivedAt: string | null;
  };
}

export interface ConnectionsResponse {
  platforms: ConnectionPlatform[];
}

// ── session (the Auth track's published contract) ─────────────────────────────
export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
}

export type SessionResponse =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false };
