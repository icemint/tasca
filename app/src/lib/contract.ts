// The read-API response contract — a PROJECTION of @tasca/domain, copied (not
// imported) so the static Astro app builds without pulling the workspace in.
// These shapes mirror exactly what packages/coordination/src/read-api.ts
// serializes; keep them in sync if that module's wire shapes change.

export const TIERS = ['basic', 'low', 'medium', 'hard', 'ultra'] as const;
export type Tier = (typeof TIERS)[number];

export type TaskStatus =
  | 'ingested'
  | 'routable'
  | 'awaiting_clarification'
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
  /** The story title (QA item 325); null until the task has been orchestrated. The UI renders it in
   *  place of the raw task UUID, falling back to the story ref when null. */
  title: string | null;
  platform: Platform;
  status: TaskStatus;
  /** The estimated tier, or null until estimation runs. */
  tierEstimate: Tier | null;
  repoRef: string | null;
  claimedBy: string | null;
  failureCount: number;
  /** Human-readable reason for the current state (e.g. why it's blocked / needs a human).
   *  Null unless set — the no-execution-capacity / failure paths write it. Surfaced on the
   *  board's Blocked column. */
  lastError: string | null;
}

export interface AgentDetail extends Agent {
  /** Instructions/definition (agent.md markdown). Stored; not yet wired into the run — see issue 362. */
  description: string | null;
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
  /** Which policy routed: 'em' (the EM's autonomous pick) or 'rank' (legacy / operator override). */
  policy: 'em' | 'rank';
  createdAt: string;
}

export interface PullRequest {
  url: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
}

export interface TaskDetail extends TaskSummary {
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

// ── projects (slice Project-B: the project switcher) ──────────────────────────
/** A project in the active org (GET /api/projects) — a finer task-view filter WITHIN the org. */
export interface ProjectSummary {
  id: string;
  name: string;
  repoRef: string | null;
}

/** The org's projects + which one is active (null = the cross-project "All projects" view). */
export interface ProjectsResponse {
  projects: ProjectSummary[];
  activeProjectId: string | null;
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

// ── PM-assistant proposals (slice W3-S1) ──────────────────────────────────────
/** A routing proposal's payload. */
export interface RoutingProposalPayload {
  agentName: string;
  why: string;
  confidence: number;
}

/** A triage proposal's payload (W3-S1b): a suggested tier + rationale. */
export interface TriageProposalPayload {
  tier: Tier;
  why: string;
  confidence: number;
}

/** A decomposition proposal's payload (W3-S1c): a draft split into child tasks. */
export interface DecompositionProposalPayload {
  children: Array<{ title: string; body?: string }>;
  why: string;
}

export interface ProposalSummary {
  id: string;
  kind: 'triage' | 'decomposition' | 'routing' | 'standup';
  targetTaskId: string | null;
  targetVersion: number | null;
  payload: RoutingProposalPayload | TriageProposalPayload | DecompositionProposalPayload | Record<string, unknown>;
  status: 'pending' | 'accepted' | 'dismissed';
  version: number;
  createdAt: string;
}

export interface ProposalsResponse {
  proposals: ProposalSummary[];
  /** The PM-assistant feature flag — drives the off/on view state. */
  enabled: boolean;
}

/** A read-only standup snapshot (W3-S1d) — org task-state counts; never persisted, no accept. */
export interface StandupSummary {
  shipped: number;
  inFlight: number;
  needsYou: number;
  queued: number;
  total: number;
}

// ── org roster + role (slice W4-S3: self-serve connect + hire) ─────────────────
/** Org roles, ordered least→most privileged. manage-connections / manage-roster = admin+. */
export type OrgRole = 'viewer' | 'member' | 'admin' | 'owner';

/** One of the caller's orgs (GET /api/orgs) — carries the caller's role + which is active. */
export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
  active: boolean;
}

export interface OrgsResponse {
  orgs: OrgSummary[];
}

// ── workspace settings (slice 3.5-B.2: instance name + members/roles) ──────────
/** The caller's ACTIVE org (GET /api/org) — its name + the caller's role in it. */
export interface OrgInfo {
  id: string;
  name: string;
  role: OrgRole;
}
export type OrgInfoResponse = OrgInfo;

/** A member of the active org (GET /api/orgs/members). */
export interface OrgMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
}

export interface MembersResponse {
  members: OrgMember[];
}

// ── invites (slice 3.5-B.3: invite a teammate by email + role) ─────────────────
/** A pending invite (GET /api/invites) — admin+. The list NEVER carries the token. */
export interface PendingInvite {
  id: string;
  email: string;
  role: OrgRole;
  createdAt: string;
  expiresAt: string;
}

export interface InvitesResponse {
  invites: PendingInvite[];
}

/** An agent hired into the active org (GET /api/orgs/agents). */
export interface HiredAgent {
  agentId: string;
  name: string;
  status: 'active' | 'paused' | 'retired';
}

export interface HiredAgentsResponse {
  agents: HiredAgent[];
}

// ── create agent (slice Wizard-B: the create-agent wizard) ─────────────────────
// POST /api/agents — member+ (any org member). On success the agent is created AND
// auto-hired into the caller's active org. `maxTier` is optional on the wire (the
// backend derives it from the model when omitted), but the UI always sends one.
export interface NewAgentInput {
  name: string;
  vendor: string;
  model: string;
  avatarUrl?: string;
  maxTier?: string;
}

/** The POST /api/agents 200 body — the created agent's identity + resolved tier. */
export interface NewAgentResponse {
  id: string;
  name: string;
  vendor: string;
  model: string;
  maxTier: string;
}

// ── per-org vendor credentials (slice 3.5-A.2c.2: Settings "Vendor keys") ───────
// The stored key is WRITE-ONLY — the read shape NEVER carries it, only a status +
// a non-reversible fingerprint. `status` is 'active' when a key is sealed for the
// provider, 'unconfigured' when none is set.
export type VendorCredentialState = 'active' | 'unconfigured';

export interface VendorCredentialStatus {
  provider: string;
  status: VendorCredentialState;
  /** A short non-reversible fingerprint of the sealed key (never the key itself). */
  fingerprint: string | null;
  lastValidatedAt: string | null;
}

export interface VendorCredentialsResponse {
  credentials: VendorCredentialStatus[];
}

/** A governance event from GET /api/orgs/credentials/audit. The payload carries only a
 *  fingerprint + status — never a key. */
export interface CredentialAuditEvent {
  id: string;
  actorUserId: string | null;
  action: 'credential.set' | 'credential.delete';
  target: string | null;
  payload: { fingerprint?: string; status?: string };
  at: string;
}

export interface CredentialAuditResponse {
  events: CredentialAuditEvent[];
}

// ── per-agent platform credentials (slice SC-3-B / Slice D: agent-detail "Platform credentials") ──
// An agent's OWN platform token (its GitHub token, its Shortcut Agent-User token) so it acts on a
// ticket/PR AS ITSELF. WRITE-ONLY, exactly like the vendor key: the read shape NEVER carries a token,
// only a status + a non-reversible fingerprint. The provider taxonomy is 'github' | 'shortcut'
// (mirrors the server's isAgentCredentialProvider — anthropic/linear are NOT agent-credential providers).
export type AgentCredentialProvider = 'github' | 'shortcut';

/** One agent platform-credential status (GET .../credentials) — status + fingerprint only, never a token.
 *  `status` is 'active' when a token is sealed for the provider, 'invalid' when the last validation failed. */
export interface AgentCredentialStatus {
  provider: AgentCredentialProvider;
  status: 'active' | 'invalid';
  /** A short non-reversible fingerprint of the sealed token (never the token itself). */
  fingerprint: string | null;
  lastValidatedAt: string | null;
}

export interface AgentCredentialsResponse {
  credentials: AgentCredentialStatus[];
}
