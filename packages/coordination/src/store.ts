// The coordination persistence seam. The orchestration loop reads/writes the
// coordination store through this interface; the Postgres impl below is the
// composition-root wiring, and tests inject an in-memory fake.
//
// CAS-claim persistence is NOT here — it rides @tasca/routing's ClaimPort
// (PgClaimRepository). This store owns the surrounding task lifecycle rows.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PgDispatchQueue } from '@tasca/db';
import type {
  SealedCredential,
  VendorProvider,
  VendorCredentialStatus,
  VendorCredentialStore,
  AgentCredentialProvider,
  AgentCredentialStatus,
  AgentCredentialStore,
  ConnectionCredentialKind,
  ConnectionCredentialStore,
  ManagerCredentialProvider,
  ManagerCredentialStore,
} from './vendor-credential';
import type { GovernanceAuditEvent, GovernanceAuditSink } from './governance-audit';
import type { CreateInviteInput, InviteSummary, AcceptInviteResult, InviteStore } from './invite';
import type { OrgRole } from './membership';
import {
  TASK_TRANSITIONS,
  type CapabilityMatch,
  type Task,
  type TaskStatus,
  type Tier,
  type TierEstimate,
} from '@tasca/domain';

/**
 * Outcome of a human write-API task intervention. `ok` carries the resulting status.
 * The failure reasons are deliberately distinct so the UI can reconcile to the TRUTH of
 * what happened rather than collapsing everything into one "conflict":
 *   - 'not_found'   — no such task (HTTP 404).
 *   - 'conflict'    — the task exists but its current status forbids the action (HTTP 409),
 *                     e.g. interrupting a task that isn't running, or reassigning a `done` one.
 *   - 'too_late'    — a cancel lost the race: the runner had already passed its point of no
 *                     return and is finishing. The task is UNTOUCHED (the reaper finalizes it).
 *                     The UI must say "already finished", never a false "interrupted".
 *   - 'no_inflight' — the task is executing but has NO cancellable runner job (it is running
 *                     in-process via the coordination fallback, which this seam can't
 *                     interrupt). Surfaced honestly; a Wave-2 residual.
 */
export type TaskWriteOutcome =
  | { ok: true; status: TaskStatus }
  | { ok: false; reason: 'not_found' | 'conflict' | 'too_late' | 'no_inflight' };

// ── PM-assistant proposals (slice W3-S1) ──────────────────────────────────────
export type ProposalKind = 'triage' | 'decomposition' | 'routing' | 'standup';
export type ProposalStatus = 'pending' | 'accepted' | 'dismissed';

/** A persisted advisory suggestion. `payload` is kind-specific and validated at the API
 *  boundary (the proposer's output is validated before it is stored). */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  targetTaskId: string | null;
  targetVersion: number | null;
  payload: unknown;
  status: ProposalStatus;
  version: number;
  createdAt: string;
}

export interface CreateProposalInput {
  kind: ProposalKind;
  targetTaskId: string | null;
  targetVersion: number | null;
  payload: unknown;
}

/** Outcome of an accept/dismiss. `agent_not_hired` is the routing-accept fail-closed branch
 *  (the proposed agent isn't in the org's hired set — never routed to an unhired agent). */
export type ProposalWriteOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'conflict' | 'agent_not_hired' };

// ── LLM usage metering (slice W3-S4a) ─────────────────────────────────────────
/** Why an LLM call was made. `agent` is the agent-execution path (reserved for S4b). */
export type UsageSource = 'classifier' | 'triage' | 'decomposition' | 'agent' | 'manager';

export interface UsageRecordInput {
  taskId: string | null;
  source: UsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The Anthropic response id — UNIQUE, so a retried report is a no-op (no double-count). */
  idempotencyKey: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  bySource: Record<string, { inputTokens: number; outputTokens: number }>;
}

/**
 * Inverse of TASK_TRANSITIONS: for each status, the statuses it may legally be
 * reached FROM. Derived once so the write-path guard (setStatus) enforces the
 * domain's transition rules atomically, instead of any status overwriting any
 * other. (The CAS claim routable→claimed rides @tasca/routing's ClaimPort, not
 * this; setStatus owns the post-claim lifecycle writes.)
 */
const VALID_PREDECESSORS: Record<TaskStatus, TaskStatus[]> = (() => {
  const inv = {} as Record<TaskStatus, TaskStatus[]>;
  for (const status of Object.keys(TASK_TRANSITIONS) as TaskStatus[]) inv[status] = [];
  for (const from of Object.keys(TASK_TRANSITIONS) as TaskStatus[]) {
    for (const to of TASK_TRANSITIONS[from]) inv[to].push(from);
  }
  return inv;
})();

// ── Read-side projections (the read-only API surface, app/ UI track) ──────────
// These are query-only shapes the read API serves; they project existing rows
// (task / routing_decision / pull_request) — no aggregate columns the schema
// doesn't carry (throughput, cost-burn, success-over-time) are invented here.

/** A project as the project list / switcher needs it (slice Project-A). repoRef is the single repo
 *  tasks execute against; null = the org's Unassigned project. */
export interface ProjectSummary {
  id: string;
  name: string;
  repoRef: string | null;
}

/** An Engineering Manager as the manager list / lookup needs it (EM v1 slice 1). The Shortcut identity
 *  fields are null until set via the identity endpoint; the member id is what later slices match the
 *  EM's own comments against. NEVER carries any token/credential — that lives sealed in the vault. */
export interface ManagerSummary {
  id: string;
  name: string;
  shortcutMemberId: string | null;
  shortcutHandle: string | null;
}

/** A task as the roster / monitoring lists need it (no per-attempt detail). */
export interface TaskSummary {
  id: string;
  externalStoryId: string;
  /** The story title (QA item 325); null until the task has been orchestrated. The UI renders it
   *  in place of the raw task UUID, falling back to the story ref when null. */
  title: string | null;
  platform: 'shortcut' | 'github' | 'linear';
  status: TaskStatus;
  tierEstimate: TierEstimate | null;
  repoRef: string | null;
  claimedBy: string | null;
  failureCount: number;
  /** The why-blocked reason (set when a task is failed/needs_attention); null otherwise.
   *  Surfaced on the board's Blocked column so an operator sees what needs a human. */
  lastError: string | null;
}

/** A persisted routing decision, projected for the inspector. */
export interface RoutingDecisionRecord {
  id: string;
  taskId: string;
  tierEstimate: TierEstimate;
  candidates: CapabilityMatch[];
  winnerAgentId: string | null;
  createdAt: string;
}

/** A pull request linked to a task. */
export interface PullRequestRecord {
  url: string;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
}

/** Per-platform connection health + webhook delivery counters (last 24h). */
export interface ConnectionSummary {
  platform: 'shortcut' | 'github' | 'linear';
  workspaceId: string;
  health: 'healthy' | 'degraded' | 'revoked';
  webhook: {
    received24h: number;
    processed24h: number;
    lastReceivedAt: string | null;
  };
}

/** A pool or a single checked-out connection — both expose `.query`. */
export type Queryable = Pool | PoolClient;

export interface CreateTaskInput {
  externalStoryId: string;
  platform: 'shortcut' | 'github' | 'linear';
  repoRef?: string | null;
  /** Decomposition child (slice W3-S1c): the child's own content (it has no platform story to
   *  fetch). Absent/null for a normal task. */
  content?: { title: string; body: string } | null;
  /** Decomposition child: the parent task it was split from (status posts back there). */
  parentTaskId?: string | null;
}

/** Where a task's content + status come from (slice W3-S1c). For a normal task both are null
 *  (content fetched from the platform; status posts to its own story). For a decomposition child,
 *  `content` is its stored content and `parentExternalStoryId` is the parent's platform story
 *  (resolved via the FK) — the child routes from `content` and posts status to the parent. */
export interface TaskOrigin {
  content: { title: string; body: string } | null;
  parentTaskId: string | null;
  parentExternalStoryId: string | null;
}

export interface RecordWebhookResult {
  /** True when this insert created the ledger row (first delivery of this id). */
  fresh: boolean;
  /**
   * True when a row for this (platform, externalEventId) already exists AND it is
   * `processed` — i.e. orchestration durably completed for it, so a redelivery is
   * a genuine duplicate and must be dropped. A row that exists but is still
   * `received` (a prior attempt recorded the event then crashed before finishing)
   * is NOT alreadyProcessed: redelivery should re-drive it.
   */
  alreadyProcessed: boolean;
}

/**
 * The coordination store seam. Every method maps onto a §7 table; the loop
 * depends only on this interface so it is unit-testable with an in-memory fake.
 */
export interface CoordinationStore {
  /**
   * Idempotency ledger: record an inbound event as `received`. `fresh:true` when
   * this delivery created the row; `alreadyProcessed:true` when an existing row is
   * already `processed` (a true duplicate to drop). An existing-but-`received` row
   * returns `{fresh:false, alreadyProcessed:false}` so a crashed prior attempt is
   * re-driven on redelivery.
   */
  recordWebhookEvent(
    orgId: string,
    input: {
      platform: 'shortcut' | 'github' | 'linear';
      externalEventId: string;
      payload?: unknown;
    }
  ): Promise<RecordWebhookResult>;

  /** Flip a ledger row to `processed` once orchestration has durably completed. */
  markWebhookProcessed(
    orgId: string,
    input: {
      platform: 'shortcut' | 'github' | 'linear';
      externalEventId: string;
    }
  ): Promise<void>;

  /**
   * Get-or-create the task for a source story. A task is identified by
   * (platform, external_story_id): the first delivery creates it at status
   * `routable`, version 0; a later delivery / re-assignment returns the EXISTING
   * row as-is (whatever its current status, version, failure_count). This is what
   * lets a re-assigned story re-drive the same task and accumulate failures.
   */
  getOrCreateTask(orgId: string, input: CreateTaskInput): Promise<Task>;

  /**
   * Get-or-create the project for `(orgId, repoRef)` (slice Project-A): the per-repo project, or
   * the org's single Unassigned project for a null repo. Idempotent — concurrent get-or-creates of
   * the same (org, repo) converge to ONE project via the partial unique indexes + ON CONFLICT.
   * Returns the project id. Name is the repo's last path segment (or 'Unassigned').
   */
  getOrCreateProject(orgId: string, repoRef: string | null): Promise<string>;

  /** The org's projects (slice Project-A), name-ordered. Org-scoped — never another org's projects. */
  listProjects(orgId: string): Promise<ProjectSummary[]>;

  /** Whether a project exists in THIS org (slice SC-1). Org-scoped: a foreign-org project id and a
   *  nonexistent id both return false — no cross-tenant existence oracle. Used by the connection
   *  set-API to 404 a projectId that isn't this org's. */
  projectExistsInOrg(orgId: string, projectId: string): Promise<boolean>;

  /** The user's active project (slice Project-A) — the finer task-view filter WITHIN their active
   *  org — VALIDATED against that org at read time, or null (= the cross-project "all projects" view).
   *  A stale active project whose org is no longer the user's active org resolves to null, never a
   *  foreign tenant's project. */
  getActiveProject(userId: string): Promise<string | null>;

  /** Set the user's active project (slice Project-A). VALIDATES the project exists IN the user's active
   *  org — a foreign-org id and a nonexistent id both return `not_found` (no cross-tenant existence
   *  oracle), and a foreign-org project is never activated. `ok` on success. */
  setActiveProject(userId: string, projectId: string): Promise<'ok' | 'not_found'>;

  /** Clear the user's active project (slice Project-B) — back to the cross-project "all projects" view.
   *  Idempotent: clearing when none is set is a no-op (getActiveProject then resolves null). No org
   *  validation needed — a delete narrows nothing, it widens to the org's full task set. */
  clearActiveProject(userId: string): Promise<void>;

  // ── Engineering Manager entity (EM v1 slice 1) — a DISTINCT entity, never an agent. Org-scoped. ──

  /** Create a manager in THIS org (EM v1 slice 1). Returns the new manager id. Org-scoped — the manager
   *  is born owned by the caller's org and never references the agent model. */
  createManager(orgId: string, name: string): Promise<{ managerId: string }>;

  /** Get a manager by id WITHIN this org, or null (a foreign-org id is indistinguishable from a missing
   *  one — no cross-tenant existence oracle). */
  getManager(orgId: string, managerId: string): Promise<ManagerSummary | null>;

  /** This org's managers (EM v1 slice 1), name-ordered. Org-scoped — never another org's managers. */
  listManagers(orgId: string): Promise<ManagerSummary[]>;

  /** Set the manager's NATIVE Shortcut identity (EM v1 slice 1): writes shortcut_member_id + handle onto
   *  the manager row AND seals the token into manager_credential. The manager-row write lands FIRST (the
   *  load-bearing projection for self-comment dedupe / lookup), then the credential — mirroring the SC-3
   *  ordering lesson. org-scoped: both writes are scoped to THIS org's manager. NEVER stores plaintext. */
  setManagerShortcutIdentity(
    orgId: string,
    managerId: string,
    memberId: string,
    handle: string | null,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void>;

  /** Assign a project to a manager (EM v1 slice 1). VERIFIES BOTH the project and the manager are in
   *  THIS org before linking — a foreign-org project id OR manager id yields `not_found` (no
   *  cross-tenant existence oracle); a foreign-org entity is never linked. `ok` on success. */
  setProjectManager(orgId: string, projectId: string, managerId: string): Promise<'ok' | 'not_found'>;

  /** The manager assigned to a project WITHIN this org, or null (no manager / foreign-org / missing).
   *  Org-scoped — never reveals another tenant's project→manager link. */
  getManagerForProject(orgId: string, projectId: string): Promise<string | null>;

  getTask(orgId: string, taskId: string): Promise<Task | null>;

  /** A task's content/status origin (slice W3-S1c): stored content + the parent's platform story
   *  for a decomposition child, both null for a normal task. Org-scoped; null if the task is absent.
   *  Routing reads `content` (falls back to the platform fetch when null); status-back posts to
   *  `parentExternalStoryId` when present (the child has no native story). */
  getTaskOrigin(orgId: string, taskId: string): Promise<TaskOrigin | null>;

  /** Persist the inspectable tier estimate onto the task. */
  setTierEstimate(orgId: string, taskId: string, estimate: TierEstimate): Promise<void>;

  /** Persist the story title onto the task (QA item 325), org+task-scoped. Called best-effort at
   *  orchestration once the content is fetched; the caller must keep a failure non-fatal. */
  setTaskTitle(orgId: string, taskId: string, title: string): Promise<void>;

  /** Move a task to a new status, incrementing its version. */
  setStatus(orgId: string, taskId: string, status: TaskStatus): Promise<void>;

  /**
   * Record one failed attempt and transition the task in a SINGLE atomic UPDATE
   * (failure path, §6.14). Increments failure_count and, in the same write,
   * either trips the breaker (→ `needs_attention`, claim retained for the human)
   * or resets the task to a re-claimable state (→ `routable`, `claimed_by`
   * cleared, version bumped so the next CAS uses a fresh expected version). Doing
   * both in one statement removes the crash window between the increment and the
   * transition that could otherwise strand a task (count bumped, status never
   * reset). Returns the new failure_count and whether the breaker tripped.
   */
  recordFailureAndTransition(
    orgId: string,
    taskId: string,
    breakerThreshold: number
  ): Promise<{ failureCount: number; tripped: boolean }>;

  /**
   * Like recordFailureAndTransition, but ONLY when the task is still in a live
   * post-claim state (`executing`/`claimed`). Used by the reaper to finalize a
   * runner-FAILED job: because the reaper's claimFinished lease is at-least-once (a
   * job can be re-leased after a crash / a failed markReaped), a blind increment
   * would DOUBLE-COUNT the breaker. Guarding on the post-claim status makes it
   * idempotent — the first finalize transitions the task out of `executing`, so a
   * re-finalize matches no rows and is a no-op. `acted` is false on that no-op.
   * (The in-process path keeps recordFailureAndTransition: it must also count
   * PRE-claim failures, where the task is still `routable`.)
   */
  recordRunnerFailure(
    orgId: string,
    taskId: string,
    breakerThreshold: number
  ): Promise<{ acted: boolean; failureCount: number; tripped: boolean }>;

  /**
   * Retire a dispatched task to `needs_attention` because no execution capacity was
   * available (no agent-runner claimed the job within the wait bound). DELIBERATELY does
   * NOT touch the breaker / failure_count: runner-unavailability is infra, not an agent
   * failure, and must not burn the task's retry budget. Records the human-readable reason
   * in `last_error` so the state is actionable. Guarded to a still-dispatched status
   * (`executing`/`claimed`) so it can't fight a concurrent operator cancel/reassign that
   * already moved the task. Returns true if it acted.
   */
  failNoCapacity(orgId: string, taskId: string, reason: string): Promise<boolean>;

  /** Retire a task to `needs_attention` because the agent ran but produced NO committed changes — a
   *  DETERMINISTIC no-op (re-running yields the same), so it must NOT drive the breaker or re-route.
   *  Same atomic guard as `failNoCapacity` (executing/claimed → needs_attention, reason in last_error,
   *  failure_count untouched). Returns true if it transitioned. */
  retireNoChanges(orgId: string, taskId: string, reason: string): Promise<boolean>;

  /**
   * Retire a still-`routable` task to `needs_attention` with a human-readable reason, WITHOUT
   * touching the breaker (slice 5d routing fail-close: "no agents hired" / "agent X not hired").
   * Guarded to `routable` so it only fires pre-claim and can't fight a concurrent claim. Returns
   * true if it acted.
   */
  retireUnroutable(orgId: string, taskId: string, reason: string): Promise<boolean>;

  /** EM requirements gate (EM v1 slice 2): mark a task EM-cleared (em_cleared=true) so the gate is
   *  skipped on any later re-drive of the SAME row (e.g. an execution-failure auto-recover). Does NOT
   *  touch status/version — clearing is orthogonal to the lifecycle; the task proceeds to routing in
   *  the same orchestration pass. org-scoped. */
  markEmCleared(orgId: string, taskId: string): Promise<void>;

  /** EM requirements gate (EM v1 slice 2): park a still-`routable` task at `awaiting_clarification`
   *  (the EM posted clarifying questions on the story) and record the clarification round. Guarded to
   *  `routable` (mirrors retireUnroutable) so a concurrent claim that already moved the task wins and
   *  this no-ops. Breaker untouched — an unclear story is not an agent failure. Returns true if it
   *  acted. */
  parkAwaitingClarification(orgId: string, taskId: string, round: number): Promise<boolean>;

  /** EM block-explanation (EM v1 slice 4): replace a blocked task's `last_error` with a human-readable
   *  rephrase of the raw reason. Updates ONLY `last_error` (no status change, no breaker). GUARDED to a
   *  still-blocked status (`needs_attention`/`failed`) so a task that moved on (resumed / re-driven)
   *  between the block and the rephrase is NOT overwritten with a stale reason. org-scoped. Returns true
   *  if it acted. */
  updateBlockReason(orgId: string, taskId: string, humanReason: string): Promise<boolean>;

  /** EM reply-resume (EM v1 slice 3): the org-scoped task currently parked at `awaiting_clarification` for
   *  a source story, or null. A reply comment on a story with no parked task (already routable / cleared /
   *  dispatched / done, or never parked) returns null → the resume handler no-ops. Status-filtered so a
   *  redelivered or late reply can't re-trigger a task that has already moved on. */
  getAwaitingClarificationTask(
    orgId: string,
    platform: 'shortcut' | 'github' | 'linear',
    externalStoryId: string
  ): Promise<Task | null>;

  /** EM reply-resume (EM v1 slice 3): transition a parked task back to `routable` so the orchestration
   *  re-runs the EM gate. Guarded to `awaiting_clarification` (so a concurrent move wins and this no-ops).
   *  Leaves `em_cleared` false (the gate must re-judge) AND `em_clarification_round` intact (the cap still
   *  counts across resumes). Bumps version. Returns true if it acted. */
  resumeFromClarification(orgId: string, taskId: string): Promise<boolean>;

  /** Persist the routing decision (estimate + candidates + winner) for the inspector. */
  recordRoutingDecision(
    orgId: string,
    input: {
      taskId: string;
      tierEstimate: TierEstimate;
      candidates: CapabilityMatch[];
      winnerAgentId: string | null;
    }
  ): Promise<void>;

  /** Persist the PR a run opened and link it to the task. */
  recordPullRequest(orgId: string, input: { taskId: string; url: string }): Promise<void>;

  /** Mark a recorded PR `merged` (the GitHub merge webhook). Org-scoped: the caller
   *  resolves the org from the PR row (via getTaskIdByPullRequestUrl) before calling,
   *  so this only ever flips a row this org owns. A url with no row is a silent no-op. */
  markPullRequestMerged(orgId: string, url: string): Promise<void>;

  // ── Human write-API: PM/operator task interventions ──────────────────────────
  // These are deliberate ADMIN overrides invoked from the app (session-gated), so
  // they bypass the normal routing-flow guard (TASK_TRANSITIONS) with their own
  // explicit state guards. Each bumps `version` (so an in-flight CAS sees the change)
  // and returns a typed outcome the write-API maps to an HTTP status. They are split-
  // independent: none cancels a LIVE run (that needs the execution cancel seam) —
  // hence the guards reject actions that would race an executing dispatch.

  /** Force a task to `needs_attention` (human review). Allowed from any non-terminal
   *  status OTHER than `needs_attention`; a `conflict` when already `needs_attention`
   *  (avoids a spurious version bump that would needlessly fail an in-flight CAS) or
   *  `done` (terminal). */
  escalateTask(orgId: string, taskId: string): Promise<TaskWriteOutcome>;

  /** Manually override the routing tier (sets `tier_estimate.tier`, preserving any
   *  other estimate fields). Rejected (`conflict`) once the task is `done`. */
  overrideTierEstimate(orgId: string, taskId: string, tier: Tier): Promise<TaskWriteOutcome>;

  /** Release a task's claim so it re-routes from a clean slate (status → `routable`,
   *  `claimed_by` cleared, `failure_count` reset). Works from the non-executing reassignable
   *  states (`routable`/`claimed`/`needs_attention`/`failed`) AND from `executing`: an
   *  executing task's live runner job is cancelled first (the #244 exactly-one seam),
   *  atomically with the task transition, then re-routed. `too_late` if the runner had
   *  already committed to finishing; `no_inflight` if it is running in-process (no job to
   *  cancel); `conflict` if `done`/`in_review`; `not_found` if absent. */
  reassignTask(orgId: string, taskId: string): Promise<TaskWriteOutcome>;

  /** Interrupt a LIVE run and flag the task for a human (status → `needs_attention`).
   *  Cancels the executing task's runner job (the #244 seam) atomically with the task
   *  transition. `too_late` if the runner had already committed to finishing; `no_inflight`
   *  if it is running in-process; `conflict` if the task isn't executing (nothing live to
   *  interrupt); `not_found` if absent. */
  interruptTask(orgId: string, taskId: string): Promise<TaskWriteOutcome>;

  /** Operator escape hatch for a STUCK task (issue 317): force a task that is `executing`
   *  or `claimed` to `needs_attention`, clearing `claimed_by` and resetting `failure_count`
   *  so the agent un-pins (its `working` pill is derived purely from `claimed_by`) and
   *  unhire/UI reconcile. Unlike `interrupt`/`reassign`, it does NOT depend on a live runner
   *  job — it is the recovery for when the run vanished (paused/dead PTY/reaped job) and no
   *  job remains to cancel, so `interrupt` dead-ends with `no_inflight`. It need not kill any
   *  process: the runner fence + the bumped version reject a late zombie finalize. Idempotent —
   *  a second call finds no `executing`/`claimed` row → `conflict` (no spurious version bump);
   *  `conflict` from any other status; `not_found` if absent. */
  forceResetTask(orgId: string, taskId: string): Promise<TaskWriteOutcome>;

  // ── PM-assistant proposals (slice W3-S1) — advisory; accept routes through a binding method ──

  /** List the org's proposals (newest first), optionally filtered by status/kind. Org-scoped. */
  listProposals(
    orgId: string,
    opts?: { status?: ProposalStatus; kind?: ProposalKind; limit?: number }
  ): Promise<Proposal[]>;

  /** Fetch one proposal in the org, or null. */
  getProposal(orgId: string, id: string): Promise<Proposal | null>;

  /** Persist a generated proposal (status `pending`). Org-scoped. */
  createProposal(orgId: string, input: CreateProposalInput): Promise<Proposal>;

  /** Dismiss a pending proposal (CAS pending→dismissed). `not_found` if absent/another org;
   *  `conflict` if already accepted/dismissed (a true duplicate dismiss). No binding effect. */
  dismissProposal(orgId: string, id: string): Promise<ProposalWriteOutcome>;

  /**
   * Accept a ROUTING proposal: atomically (one tx) CAS the proposal pending→accepted AND set the
   * task's routing PREFERENCE to `preferredAgentId` + re-route it (status→`routable`, claim cleared)
   * — the SAME binding write a reassign performs, never a direct claim/assign. The preferred id is
   * resolved to a HIRED agent by the caller BEFORE this runs (so an unhired name never reaches here).
   * Fenced to a non-executing reassignable status AND the `target_version` the proposal was generated
   * against (a task that moved since → `conflict`, the proposal is stale). On any task-side failure the
   * whole tx rolls back, so the proposal stays `pending` (no half-applied accept). At-most-once: only
   * the CAS winner proceeds to the binding write.
   */
  acceptRoutingProposal(
    orgId: string,
    id: string,
    preferredAgentId: string
  ): Promise<ProposalWriteOutcome>;

  /**
   * Accept a TRIAGE proposal: atomically (one tx) CAS the proposal pending→accepted AND apply the
   * tier via the overrideTierEstimate write (version-fenced to the proposal's target_version,
   * done-guarded) — never a status/claim/routing write. A task that moved since (or is `done`) →
   * `conflict`, and the whole tx rolls back so the proposal stays `pending` (no half-applied accept).
   * At-most-once under a double-accept race (the proposal CAS serializes).
   */
  acceptTriageProposal(orgId: string, id: string, tier: Tier): Promise<ProposalWriteOutcome>;

  /**
   * Accept a DECOMPOSITION proposal: atomically (one tx) CAS the proposal pending→accepted AND
   * create each child via getOrCreateTask (the ONLY binding write — no status/claim/routing write on
   * the parent). Children get a DETERMINISTIC synthetic story id (parent story + index) so a re-run
   * after a rolled-back tx re-creates the SAME children with NO duplicates (the (org,platform,
   * external_story_id) unique dedups). Each child inherits the parent's org/platform/repo and carries
   * its own content + a parent pointer. Version-fenced to the parent's target_version + parent-not-
   * done; a parent that moved/finished → conflict and the whole tx rolls back (all-or-nothing — no
   * partial child set, proposal stays pending). At-most-once under a double-accept race.
   */
  acceptDecompositionProposal(
    orgId: string,
    id: string,
    children: Array<{ title: string; body: string }>
  ): Promise<ProposalWriteOutcome>;

  // ── GitHub App installation (write-back installation resolution) ──────────────

  /**
   * Record (or update) the GitHub App installation for a workspace. The
   * `workspaceId` is the GitHub account/org login (the `owner` half of an
   * `owner/repo`); upserts on the org-scoped platform_connection
   * UNIQUE(org_id, platform, workspace_id) with platform='github'. The install
   * webhook is the source of this mapping; `orgId` is resolved at the install edge.
   */
  upsertGitHubInstallation(
    orgId: string,
    input: { workspaceId: string; installationId: string }
  ): Promise<void>;

  /**
   * Resolve the GitHub App installation id for a repo owner (account/org login),
   * or null when no install is recorded for it. The status reporter splits
   * `externalStoryId` ("owner/repo#number") to get the owner.
   *
   * CROSS-ORG resolver: an installation is keyed by (platform, workspace_id) across
   * all tenants, so this deliberately does NOT take an orgId — it is one of the three
   * unscoped tenant paths (with getOrgForConnection / getOrgForTask). A worker uses it
   * to mint a repo-scoped token; the org-scoped task writes happen separately.
   */
  getInstallationIdForOwner(owner: string): Promise<string | null>;

  /**
   * Confirm an install (slice 5c install webhook): update the GitHub connection's installation_id +
   * mark it healthy, matched by account login. CROSS-ORG by account (the account is globally unique
   * across tenants — a GitHub account installs the App once); it does NOT bind org_id (the connect
   * CALLBACK owns the org binding via the nonce). A no-op when no connection exists yet (the callback
   * will create it). Returns true if it updated a row.
   */
  updateInstallationByAccount(account: string, installationId: string): Promise<boolean>;

  /**
   * Revoke a GitHub connection on uninstall (slice 5c): mark it `revoked`, matched by account login.
   * Cross-org by account. The org binding row stays (auditable) but health=revoked stops resolution.
   */
  revokeInstallationByAccount(account: string): Promise<boolean>;

  // ── Shortcut connection ↔ project binding (slice SC-1) ────────────────────────

  /**
   * Upsert a Shortcut connection bound to a project (slice SC-1). Idempotent on the org-scoped
   * UNIQUE(org_id, platform, workspace_id): a re-configure of the same workspace updates its
   * project_id in place (so the operator's webhook URL stays stable). Returns the connection id.
   * org-scoped — a connection can only land in THIS org.
   */
  upsertShortcutConnection(
    orgId: string,
    input: { workspaceId: string; projectId: string }
  ): Promise<{ connectionId: string }>;

  /**
   * Resolve a Shortcut connection by id for the connection-scoped webhook route (slice SC-1):
   * the connection's org + its project's repo_ref, or null when there is no LIVE shortcut connection
   * for that id (unknown id, wrong platform, or revoked). CROSS-ORG by design — it is DISCOVERING which
   * org/repo the inbound delivery belongs to (the connection id is the routing key), so it cannot
   * itself be org-scoped; it joins to project IN the connection's own org. `repoRef` is null when the
   * bound project has no repo (the Unassigned bucket) or the connection has no project bound.
   */
  getShortcutConnectionById(
    connectionId: string
  ): Promise<{ orgId: string; repoRef: string | null } | null>;

  // ── Cross-org resolvers (the ONLY unscoped tenant reads — slice 3b-2) ──────────
  // These DISCOVER which org a request/job belongs to, so they cannot themselves be
  // org-scoped. Each returns null when nothing matches; the EDGE (orchestrate / reaper /
  // server) decides what to do with a miss (default-org for an unconnected workspace at
  // the webhook edge; skip for a vanished task in the reaper). They never default here.

  /**
   * The org that owns a platform connection (webhook → org). Looks up the
   * platform_connection by (platform, workspace_id) and returns its org_id, or null
   * when no connection is recorded for that workspace. The webhook edge maps a null to
   * the default org (an unconnected workspace is single-org until onboarding, slice 5).
   */
  getOrgForConnection(
    platform: 'shortcut' | 'github' | 'linear',
    workspaceId: string
  ): Promise<string | null>;

  /**
   * The org that owns a task (worker → org). The reaper finalizes runner jobs out of
   * band and has only a taskId; this resolves the task's org_id so the finalize writes
   * are scoped. Returns null when the task no longer exists (the reaper then just reaps
   * the job — there is nothing to finalize and no org to invent).
   */
  getOrgForTask(taskId: string): Promise<string | null>;

  /**
   * The org + task a recorded PR belongs to (GitHub merge webhook → org/task). The
   * merge webhook arrives at the edge with no org — only the PR's globally-unique
   * `html_url` — so this DISCOVERS the owning org/task by that url (pull_request.url is
   * UNIQUE(task_id, url) and indexed for this lookup). CROSS-ORG by design, like
   * getShortcutConnectionById: the url is the routing key, so the resolver cannot be
   * org-scoped. Returns null when no recorded PR matches the url — a PR Tasca did not
   * open — and the merge handler then no-ops (never touches an unrelated task/tenant).
   */
  getTaskIdByPullRequestUrl(url: string): Promise<{ orgId: string; taskId: string } | null>;

  // ── Read-side (the read-only API serves these; query-only, no writes) ───────

  /** List task summaries, newest first; optionally filtered by status and/or project, capped by
   *  limit. An absent `projectId` is the cross-project view (all of the org's projects). */
  listTasks(
    orgId: string,
    filter?: { status?: TaskStatus; projectId?: string; limit?: number }
  ): Promise<TaskSummary[]>;

  /** Aggregate count of the org's tasks by status (slice W3-S1d) — the standup's data source. Counts
   *  EVERY task (no pagination/cap, so a large org is never under-counted). Org-scoped. */
  getTaskStatusCounts(orgId: string): Promise<Record<string, number>>;

  /** Record one LLM call's usage (slice W3-S4a). Org-scoped + CAS-idempotent (ON CONFLICT on the
   *  unique idempotency_key) — a retried/concurrent report of the SAME call inserts at most one row,
   *  never a double-count. Returns nothing; metering is best-effort and must not affect the LLM call. */
  recordUsage(orgId: string, e: UsageRecordInput): Promise<void>;

  /** Sum the org's LLM usage (slice W3-S4a), optionally for one task / since a time. ORG-SCOPED — a
   *  query sums only this org's spend (a cross-org sum would be a billing leak). */
  getUsage(orgId: string, opts?: { taskId?: string; since?: string }): Promise<UsageTotals>;

  /** The most recent routing decision for a task, or null if none recorded yet. */
  getRoutingDecisionForTask(orgId: string, taskId: string): Promise<RoutingDecisionRecord | null>;

  /** Recent routing decisions across all tasks (in this org), newest first. */
  listRoutingDecisions(orgId: string, limit?: number): Promise<RoutingDecisionRecord[]>;

  /** Pull requests linked to a task, newest first. */
  listPullRequestsForTask(orgId: string, taskId: string): Promise<PullRequestRecord[]>;

  /** Per-platform connection summaries with 24h webhook delivery counters. */
  listConnections(orgId: string): Promise<ConnectionSummary[]>;
}

interface TaskRow {
  id: string;
  external_story_id: string;
  title: string | null;
  platform: string;
  status: string;
  version: number;
  claimed_by: string | null;
  failure_count: number;
  repo_ref: string | null;
  tier_estimate: TierEstimate | null;
  last_error: string | null;
  preferred_agent_id: string | null;
  em_cleared: boolean;
  em_clarification_round: number;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    externalStoryId: row.external_story_id,
    title: row.title ?? null,
    platform: row.platform as Task['platform'],
    status: row.status as TaskStatus,
    version: row.version,
    claimedBy: row.claimed_by,
    failureCount: row.failure_count,
    repoRef: row.repo_ref,
    tierEstimate: row.tier_estimate,
    lastError: row.last_error ?? null,
    preferredAgentId: row.preferred_agent_id ?? null,
    emCleared: row.em_cleared ?? false,
    emClarificationRound: row.em_clarification_round ?? 0,
  };
}

interface ProposalRow {
  id: string;
  kind: string;
  target_task_id: string | null;
  target_version: number | null;
  payload: unknown;
  status: string;
  version: number;
  created_at: Date | string;
}

function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    kind: row.kind as ProposalKind,
    targetTaskId: row.target_task_id,
    targetVersion: row.target_version,
    payload: row.payload,
    status: row.status as ProposalStatus,
    version: row.version,
    createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
  };
}

/** Thrown inside `acceptRoutingProposal`'s tx to roll back (undo the proposal CAS) while
 *  carrying the outcome to return — so a stale/missing target leaves the proposal `pending`. */
class RollbackProposal extends Error {
  constructor(public readonly outcome: ProposalWriteOutcome) {
    super('proposal rollback');
  }
}

/**
 * Postgres implementation of the coordination store (raw `pg`, mirrors the
 * PgClaimRepository / PgIdentityRepository style). Constructor takes a pool or a
 * single connection.
 */
export class PgCoordinationStore
  implements
    CoordinationStore,
    VendorCredentialStore,
    AgentCredentialStore,
    ConnectionCredentialStore,
    ManagerCredentialStore,
    GovernanceAuditSink,
    InviteStore
{
  constructor(private readonly db: Queryable) {}

  // ── Org invites (slice 3.5-B.3.1) — single-use, hashed-at-rest, expiring org-join capability ──
  async createInvite(orgId: string, input: CreateInviteInput): Promise<{ id: string }> {
    // Store ONLY the token HASH (the raw token leaves the server in the create response + email, never
    // here). org-scoped: org_id from the caller (the inviter's active org).
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO org_invite (id, org_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, orgId, input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt]
    );
    return { id };
  }

  async listPendingInvites(orgId: string): Promise<InviteSummary[]> {
    // ORG-SCOPED, pending + unexpired only, newest-first. Projects id/email/role/timestamps — NEVER the
    // token or its hash (the secret never leaves the create path).
    const res = await this.db.query<{ id: string; email: string; role: OrgRole; created_at: Date; expires_at: Date }>(
      `SELECT id, email, role, created_at, expires_at
         FROM org_invite
        WHERE org_id = $1 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      createdAt: toIso(r.created_at),
      expiresAt: toIso(r.expires_at),
    }));
  }

  async revokeInvite(orgId: string, id: string): Promise<boolean> {
    // ORG-SCOPED: a revoke can only touch THIS org's pending invites — org A can never revoke org B's.
    // Only a pending invite flips to revoked; returns whether a row changed (false → not found / not pending).
    const res = await this.db.query(
      `UPDATE org_invite SET status = 'revoked'
        WHERE org_id = $1 AND id = $2 AND status = 'pending'`,
      [orgId, id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async acceptInvite(tokenHash: string, acceptingUserId: string): Promise<AcceptInviteResult> {
    // Single-use accept in ONE transaction: lock the invite row by its token_hash (the global capability —
    // the org is unknown until found), validate it is still usable, mark it accepted, and enroll the user.
    // A second accept of the same token sees status='accepted' → 'consumed'. The failure outcomes are kept
    // generic ('invalid' vs 'consumed' — never WHY consumed) so the API can collapse both without enumeration.
    return this.withTaskTx(async (db) => {
      const found = await db.query<{ id: string; org_id: string; role: OrgRole; status: string; expired: boolean }>(
        `SELECT id, org_id, role, status, (expires_at <= now()) AS expired
           FROM org_invite WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash]
      );
      const invite = found.rows[0];
      if (!invite) return { kind: 'invalid' };
      if (invite.status !== 'pending' || invite.expired) return { kind: 'consumed' };

      await db.query(
        `UPDATE org_invite SET status = 'accepted', accepted_at = now(), accepted_by = $2 WHERE id = $1`,
        [invite.id, acceptingUserId]
      );
      // Enroll at the invited role using the SAME idempotent INSERT pattern ensureInstanceMembership uses:
      // a returning member keeps their existing role (no downgrade), a new member joins at `role`.
      await db.query(
        `INSERT INTO org_membership (user_id, org_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [acceptingUserId, invite.org_id, invite.role]
      );
      // Make the joined org their active one if they have none set yet (idempotent — a returning user keeps theirs).
      await db.query(
        `INSERT INTO user_active_org (user_id, org_id) VALUES ($1,$2)
         ON CONFLICT (user_id) DO NOTHING`,
        [acceptingUserId, invite.org_id]
      );
      return { kind: 'ok', orgId: invite.org_id, role: invite.role };
    });
  }

  // ── Governance audit trail (slice 3.5-A.2c.1) — append-only, org-scoped credential-mgmt ledger ──
  async recordGovernanceAudit(
    orgId: string,
    e: { actorUserId: string; action: string; target?: string; payload?: Record<string, unknown> }
  ): Promise<void> {
    // Append one row. The table's UPDATE/DELETE rules make the trail append-only; org_id scopes it.
    // payload carries {fingerprint,status} for a set / {} for a delete — NEVER the raw key.
    await this.db.query(
      `INSERT INTO governance_audit_event (id, org_id, actor_user_id, action, target, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [randomUUID(), orgId, e.actorUserId, e.action, e.target ?? null, JSON.stringify(e.payload ?? {})]
    );
  }

  async listGovernanceAudit(orgId: string, opts?: { limit?: number }): Promise<GovernanceAuditEvent[]> {
    // ORG-SCOPED, newest-first. The limit is clamped so a hostile/oversized request can't ask for
    // the whole trail.
    const limit = clampLimit(opts?.limit, 50, 200);
    const res = await this.db.query<GovernanceAuditRow>(
      `SELECT id, actor_user_id, action, target, payload, at
         FROM governance_audit_event WHERE org_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
      [orgId, limit]
    );
    return res.rows.map(mapGovernanceAudit);
  }

  // ── BYOK vendor credentials (slice 3.5-A) — sealed at rest; no method returns plaintext ──────────
  async setVendorCredential(
    orgId: string,
    provider: VendorProvider,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void> {
    // Upsert (org_id, provider): a replace re-validates → status active + fresh last_validated_at.
    await this.db.query(
      `INSERT INTO org_vendor_credential (org_id, provider, ciphertext, nonce, auth_tag, key_fingerprint, status, created_by, last_validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7, now())
       ON CONFLICT (org_id, provider) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag,
         key_fingerprint = EXCLUDED.key_fingerprint, status = 'active', last_validated_at = now()`,
      [orgId, provider, sealed.ciphertext, sealed.nonce, sealed.authTag, fingerprint, createdBy]
    );
  }

  async getVendorCredentialStatuses(orgId: string): Promise<VendorCredentialStatus[]> {
    // ORG-SCOPED; returns status + fingerprint ONLY (never the ciphertext/key).
    const res = await this.db.query<{ provider: string; status: string; key_fingerprint: string; last_validated_at: Date | null }>(
      `SELECT provider, status, key_fingerprint, last_validated_at
         FROM org_vendor_credential WHERE org_id = $1 ORDER BY provider`,
      [orgId]
    );
    return res.rows.map((r) => ({
      provider: r.provider as VendorProvider,
      status: r.status as 'active' | 'invalid',
      fingerprint: r.key_fingerprint,
      lastValidatedAt: r.last_validated_at ? toIso(r.last_validated_at) : null,
    }));
  }

  async getSealedVendorCredential(orgId: string, provider: VendorProvider): Promise<SealedCredential | null> {
    // The resolver's read — returns the SEALED blob (the master key to open it lives in env, not here).
    const res = await this.db.query<{ ciphertext: string; nonce: string; auth_tag: string }>(
      `SELECT ciphertext, nonce, auth_tag FROM org_vendor_credential
        WHERE org_id = $1 AND provider = $2 AND status = 'active'`,
      [orgId, provider]
    );
    const row = res.rows[0];
    return row ? { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag } : null;
  }

  async deleteVendorCredential(orgId: string, provider: VendorProvider): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM org_vendor_credential WHERE org_id = $1 AND provider = $2`,
      [orgId, provider]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Per-agent platform credentials (slice SC-3) — sealed at rest; no method returns plaintext ─────
  async setAgentCredential(
    orgId: string,
    agentId: string,
    provider: AgentCredentialProvider,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void> {
    // Upsert (org_id, agent_id, provider): a replace overwrites the sealed token + fingerprint and
    // refreshes status/last_validated_at. org-scoped — a set can only land on THIS org's agent.
    await this.db.query(
      `INSERT INTO org_agent_credential (org_id, agent_id, provider, ciphertext, nonce, auth_tag, key_fingerprint, status, created_by, last_validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8, now())
       ON CONFLICT (org_id, agent_id, provider) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag,
         key_fingerprint = EXCLUDED.key_fingerprint, status = 'active', last_validated_at = now()`,
      [orgId, agentId, provider, sealed.ciphertext, sealed.nonce, sealed.authTag, fingerprint, createdBy]
    );
  }

  async getSealedAgentCredential(
    orgId: string,
    agentId: string,
    provider: AgentCredentialProvider
  ): Promise<SealedCredential | null> {
    // The resolver's read — returns the SEALED blob (the master key to open it lives in env, not here).
    // ORG-SCOPED + agent-scoped: a cross-tenant token is unreachable from another org's context.
    const res = await this.db.query<{ ciphertext: string; nonce: string; auth_tag: string }>(
      `SELECT ciphertext, nonce, auth_tag FROM org_agent_credential
        WHERE org_id = $1 AND agent_id = $2 AND provider = $3 AND status = 'active'`,
      [orgId, agentId, provider]
    );
    const row = res.rows[0];
    return row ? { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag } : null;
  }

  async getAgentCredentialStatuses(orgId: string, agentId: string): Promise<AgentCredentialStatus[]> {
    // ORG+agent-SCOPED; returns status + fingerprint ONLY (never the ciphertext/token).
    const res = await this.db.query<{ provider: string; status: string; key_fingerprint: string; last_validated_at: Date | null }>(
      `SELECT provider, status, key_fingerprint, last_validated_at
         FROM org_agent_credential WHERE org_id = $1 AND agent_id = $2 ORDER BY provider`,
      [orgId, agentId]
    );
    return res.rows.map((r) => ({
      provider: r.provider as AgentCredentialProvider,
      status: r.status as 'active' | 'invalid',
      fingerprint: r.key_fingerprint,
      lastValidatedAt: r.last_validated_at ? toIso(r.last_validated_at) : null,
    }));
  }

  async deleteAgentCredential(orgId: string, agentId: string, provider: AgentCredentialProvider): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM org_agent_credential WHERE org_id = $1 AND agent_id = $2 AND provider = $3`,
      [orgId, agentId, provider]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Per-connection platform credentials (slice SC-1) — sealed at rest; no method returns plaintext ─
  async setConnectionCredential(
    orgId: string,
    connectionId: string,
    kind: ConnectionCredentialKind,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void> {
    // Upsert (org_id, connection_id, kind): a replace overwrites the sealed secret + fingerprint and
    // refreshes status/last_validated_at. org-scoped — a set can only land on THIS org's connection.
    await this.db.query(
      `INSERT INTO connection_credential (org_id, connection_id, kind, ciphertext, nonce, auth_tag, key_fingerprint, status, created_by, last_validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8, now())
       ON CONFLICT (org_id, connection_id, kind) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag,
         key_fingerprint = EXCLUDED.key_fingerprint, status = 'active', last_validated_at = now()`,
      [orgId, connectionId, kind, sealed.ciphertext, sealed.nonce, sealed.authTag, fingerprint, createdBy]
    );
  }

  async getSealedConnectionCredential(
    orgId: string,
    connectionId: string,
    kind: ConnectionCredentialKind
  ): Promise<SealedCredential | null> {
    // The resolver's read — returns the SEALED blob (the master key to open it lives in env, not here).
    // ORG-SCOPED + connection-scoped: a cross-tenant secret is unreachable from another org's context.
    const res = await this.db.query<{ ciphertext: string; nonce: string; auth_tag: string }>(
      `SELECT ciphertext, nonce, auth_tag FROM connection_credential
        WHERE org_id = $1 AND connection_id = $2 AND kind = $3 AND status = 'active'`,
      [orgId, connectionId, kind]
    );
    const row = res.rows[0];
    return row ? { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag } : null;
  }

  async recordWebhookEvent(
    orgId: string,
    input: {
      platform: 'shortcut' | 'github' | 'linear';
      externalEventId: string;
      payload?: unknown;
    }
  ): Promise<RecordWebhookResult> {
    // Insert the ledger row as `received`, scoped to org. ON CONFLICT DO NOTHING means a
    // fresh delivery returns a row (rowCount 1); a redelivery returns none. The conflict
    // target is the org-prefixed unique (org_id, platform, external_event_id) created by
    // ORG_CONTRACT_DDL, in lockstep with the column set below. For a redelivery we must
    // distinguish a genuine duplicate (existing row already `processed`) from a crashed
    // prior attempt (`received`) — so we read the existing status and re-drive only the
    // latter, scoped to the same org so it can't read another tenant's ledger.
    const inserted = await this.db.query(
      `INSERT INTO webhook_event (id, org_id, platform, external_event_id, payload, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'received')
       ON CONFLICT (org_id, platform, external_event_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), orgId, input.platform, input.externalEventId, JSON.stringify(input.payload ?? {})]
    );
    if (inserted.rowCount === 1) {
      return { fresh: true, alreadyProcessed: false };
    }
    const existing = await this.db.query<{ status: string }>(
      `SELECT status FROM webhook_event WHERE org_id = $1 AND platform = $2 AND external_event_id = $3`,
      [orgId, input.platform, input.externalEventId]
    );
    return { fresh: false, alreadyProcessed: existing.rows[0]?.status === 'processed' };
  }

  async markWebhookProcessed(
    orgId: string,
    input: {
      platform: 'shortcut' | 'github' | 'linear';
      externalEventId: string;
    }
  ): Promise<void> {
    await this.db.query(
      `UPDATE webhook_event SET status = 'processed', processed_at = now()
        WHERE org_id = $1 AND platform = $2 AND external_event_id = $3`,
      [orgId, input.platform, input.externalEventId]
    );
  }

  async getOrCreateTask(orgId: string, input: CreateTaskInput): Promise<Task> {
    return this.getOrCreateTaskOn(this.db, orgId, input);
  }

  /** Get-or-create on (org_id, platform, external_story_id), against a given Queryable so it can run
   *  inside the accept-decomposition tx (children share the parent's tx) AND standalone (webhook
   *  ingest). The no-op DO UPDATE makes RETURNING fire on conflict too, so we always get the live row
   *  back — a new one on first create, the EXISTING one on a re-create (a decomposition re-accept with
   *  the SAME deterministic child story id → the existing child, NO duplicate, NO content overwrite).
   *  content/parent_task_id are set only on first insert (decomposition children); a normal task
   *  passes neither. The conflict target is the org-prefixed unique (ORG_CONTRACT_DDL). */
  private async getOrCreateTaskOn(db: Queryable, orgId: string, input: CreateTaskInput): Promise<Task> {
    // Resolve (or create) the structured project for this task's repo BEFORE the insert, on the SAME
    // Queryable so a task created inside the accept-decomposition tx shares its project resolution.
    // repo_ref stays on the task (the provisioner reads it); project_id is the structured link.
    const projectId = await this.getOrCreateProjectOn(db, orgId, input.repoRef ?? null);
    const res = await db.query<TaskRow>(
      `INSERT INTO task (id, org_id, external_story_id, platform, status, version, failure_count, repo_ref, project_id, content, parent_task_id)
       VALUES ($1,$2,$3,$4,'routable',0,0,$5,$6,$7::jsonb,$8)
       ON CONFLICT (org_id, platform, external_story_id)
         DO UPDATE SET external_story_id = EXCLUDED.external_story_id, updated_at = now()
       RETURNING id, external_story_id, title, platform, status, version, claimed_by, failure_count, repo_ref, tier_estimate, last_error, preferred_agent_id, em_cleared, em_clarification_round`,
      [
        randomUUID(),
        orgId,
        input.externalStoryId,
        input.platform,
        input.repoRef ?? null,
        projectId,
        input.content ? JSON.stringify(input.content) : null,
        input.parentTaskId ?? null,
      ]
    );
    return mapTask(res.rows[0]!);
  }

  async getOrCreateProject(orgId: string, repoRef: string | null): Promise<string> {
    return this.getOrCreateProjectOn(this.db, orgId, repoRef);
  }

  /** Resolve the `(orgId, repoRef)` project against a given Queryable (so it can run inside the task-
   *  create tx). Deterministic id + last-segment name MATCH the migration's PROJECT_BACKFILL_DDL, so
   *  the boot-time backfill and a runtime get-or-create of the same repo converge on the SAME project.
   *  Idempotent: the partial unique indexes + ON CONFLICT DO NOTHING collapse a concurrent create to
   *  one row; the SELECT then reads back the (now-guaranteed) project. */
  private async getOrCreateProjectOn(db: Queryable, orgId: string, repoRef: string | null): Promise<string> {
    // '∅' sentinel disambiguates a null repo (the Unassigned bucket) from an empty-string repo, so
    // they never collapse to the same id — same seed the migration uses.
    const seed = repoRef ?? '∅';
    const name = repoRef === null ? 'Unassigned' : repoRef.slice(repoRef.lastIndexOf('/') + 1);
    const res = await db.query<{ id: string }>(
      `WITH ins AS (
         INSERT INTO project (id, org_id, name, repo_ref)
           VALUES ('proj_' || md5($1 || ' ' || $2), $1, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id
       )
       SELECT id FROM ins
       UNION ALL
       SELECT id FROM project
        WHERE org_id = $1 AND repo_ref IS NOT DISTINCT FROM $4
       LIMIT 1`,
      [orgId, seed, name, repoRef]
    );
    return res.rows[0]!.id;
  }

  async listProjects(orgId: string): Promise<ProjectSummary[]> {
    // ORG-SCOPED — never another org's projects. Name-ordered, with the Unassigned bucket (if any).
    const res = await this.db.query<{ id: string; name: string; repo_ref: string | null }>(
      `SELECT id, name, repo_ref FROM project WHERE org_id = $1 ORDER BY name, id`,
      [orgId]
    );
    return res.rows.map((r) => ({ id: r.id, name: r.name, repoRef: r.repo_ref }));
  }

  async projectExistsInOrg(orgId: string, projectId: string): Promise<boolean> {
    // ORG-SCOPED existence probe: a foreign-org id and a nonexistent id are INDISTINGUISHABLE (both
    // false) — no cross-tenant existence oracle. The connection set-API uses this to 404 a projectId
    // that isn't this org's, without leaking whether it exists in another tenant.
    const res = await this.db.query(`SELECT 1 FROM project WHERE id = $1 AND org_id = $2`, [projectId, orgId]);
    return (res.rowCount ?? 0) > 0;
  }

  async getActiveProject(userId: string): Promise<string | null> {
    // The user's active project IF it is still in their CURRENT active org, else null (= the cross-
    // project "all projects" view — never a foreign tenant's project). The JOIN to the resolved active
    // org is what stops a stale active project (its org no longer active, or its membership revoked)
    // from leaking another org's tasks. A user with no membership / no selection resolves to null.
    const res = await this.db.query<{ project_id: string }>(
      `SELECT ap.project_id
         FROM user_active_project ap
         JOIN project p ON p.id = ap.project_id
        WHERE ap.user_id = $1
          AND p.org_id = COALESCE(
            (SELECT a.org_id FROM user_active_org a
               JOIN org_membership m ON m.user_id = a.user_id AND m.org_id = a.org_id
              WHERE a.user_id = $1),
            (SELECT org_id FROM org_membership WHERE user_id = $1 ORDER BY created_at, org_id LIMIT 1)
          )`,
      [userId]
    );
    return res.rows[0]?.project_id ?? null;
  }

  async setActiveProject(userId: string, projectId: string): Promise<'ok' | 'not_found'> {
    // ONE org-scoped existence probe (in the upsert's tx): the project must exist AND belong to the
    // user's CURRENT active org. A foreign-org id and a nonexistent id are INDISTINGUISHABLE — both
    // 'not_found' — so there is no cross-tenant existence oracle. (Project ids are deterministic
    // 'proj_'||md5(org_id||' '||repo_ref), so a separate 403-for-foreign would let a member enumerate
    // another org's repos by id.) A foreign-org project is therefore never activated. Mirrors
    // setActiveOrg's isMember discipline (one outcome for unknown/foreign).
    return this.withTaskTx(async (db) => {
      const found = await db.query(
        `SELECT 1 FROM project
          WHERE id = $2
            AND org_id = COALESCE(
              (SELECT a.org_id FROM user_active_org a
                 JOIN org_membership m ON m.user_id = a.user_id AND m.org_id = a.org_id
                WHERE a.user_id = $1),
              (SELECT org_id FROM org_membership WHERE user_id = $1 ORDER BY created_at, org_id LIMIT 1)
            )`,
        [userId, projectId]
      );
      if (!found.rowCount) return 'not_found';
      await db.query(
        `INSERT INTO user_active_project (user_id, project_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET project_id = EXCLUDED.project_id, updated_at = now()`,
        [userId, projectId]
      );
      return 'ok';
    });
  }

  async clearActiveProject(userId: string): Promise<void> {
    // Drop the user's selection → getActiveProject resolves null = the cross-project "all projects"
    // view. Keyed on user_id only: a delete narrows nothing (no cross-tenant concern), and clearing
    // when none is set deletes no row — idempotent.
    await this.db.query(`DELETE FROM user_active_project WHERE user_id = $1`, [userId]);
  }

  // ── Engineering Manager entity (EM v1 slice 1) — DISTINCT entity; never the agent tables. Org-scoped ──
  async createManager(orgId: string, name: string): Promise<{ managerId: string }> {
    // The manager is born owned by THIS org (org_id from the caller). It does NOT reference `agent`, so
    // it can never enter the routing roster. Shortcut identity is set later via the identity endpoint.
    const id = randomUUID();
    await this.db.query(`INSERT INTO manager (id, org_id, name) VALUES ($1,$2,$3)`, [id, orgId, name]);
    return { managerId: id };
  }

  async getManager(orgId: string, managerId: string): Promise<ManagerSummary | null> {
    // ORG-SCOPED: a foreign-org id and a missing one are INDISTINGUISHABLE (both null) — no
    // cross-tenant existence oracle. Never returns any credential material.
    const res = await this.db.query<{ id: string; name: string; shortcut_member_id: string | null; shortcut_handle: string | null }>(
      `SELECT id, name, shortcut_member_id, shortcut_handle
         FROM manager WHERE org_id = $1 AND id = $2`,
      [orgId, managerId]
    );
    const row = res.rows[0];
    return row
      ? { id: row.id, name: row.name, shortcutMemberId: row.shortcut_member_id, shortcutHandle: row.shortcut_handle }
      : null;
  }

  async listManagers(orgId: string): Promise<ManagerSummary[]> {
    // ORG-SCOPED — never another org's managers. Name-ordered (then id for stability).
    const res = await this.db.query<{ id: string; name: string; shortcut_member_id: string | null; shortcut_handle: string | null }>(
      `SELECT id, name, shortcut_member_id, shortcut_handle
         FROM manager WHERE org_id = $1 ORDER BY name, id`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      shortcutMemberId: r.shortcut_member_id,
      shortcutHandle: r.shortcut_handle,
    }));
  }

  async setManagerShortcutIdentity(
    orgId: string,
    managerId: string,
    memberId: string,
    handle: string | null,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void> {
    // Two writes (the manager row's identity projection + the sealed credential) in ONE transaction so
    // a partial failure can't leave a credential pointing at a manager with no identity. MANAGER ROW
    // FIRST: shortcut_member_id is the load-bearing projection (later slices match the EM's own comments
    // against it), so it lands before the credential — mirroring the SC-3 binding-first ordering lesson.
    // Both writes are org-scoped (the credential carries org_id; the UPDATE filters org_id + id), so a
    // set can only land on THIS org's manager. NEVER persists plaintext (the sealed blob only).
    await this.withTaskTx(async (db) => {
      await db.query(
        `UPDATE manager SET shortcut_member_id = $3, shortcut_handle = $4 WHERE org_id = $1 AND id = $2`,
        [orgId, managerId, memberId, handle]
      );
      await db.query(
        `INSERT INTO manager_credential (org_id, manager_id, provider, ciphertext, nonce, auth_tag, key_fingerprint, status, created_by, last_validated_at)
         VALUES ($1,$2,'shortcut',$3,$4,$5,$6,'active',$7, now())
         ON CONFLICT (org_id, manager_id, provider) DO UPDATE SET
           ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag,
           key_fingerprint = EXCLUDED.key_fingerprint, status = 'active', last_validated_at = now()`,
        [orgId, managerId, sealed.ciphertext, sealed.nonce, sealed.authTag, fingerprint, createdBy]
      );
    });
  }

  async getSealedManagerCredential(
    orgId: string,
    managerId: string,
    provider: ManagerCredentialProvider
  ): Promise<SealedCredential | null> {
    // The resolver's read — returns the SEALED blob (the master key to open it lives in env, not here).
    // ORG-SCOPED + manager-scoped: a cross-tenant token is unreachable from another org's context.
    const res = await this.db.query<{ ciphertext: string; nonce: string; auth_tag: string }>(
      `SELECT ciphertext, nonce, auth_tag FROM manager_credential
        WHERE org_id = $1 AND manager_id = $2 AND provider = $3 AND status = 'active'`,
      [orgId, managerId, provider]
    );
    const row = res.rows[0];
    return row ? { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag } : null;
  }

  async setManagerCredential(
    orgId: string,
    managerId: string,
    provider: ManagerCredentialProvider,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void> {
    // The ManagerCredentialStore seam (parallel to setAgentCredential). The identity endpoint uses the
    // transactional setManagerShortcutIdentity above; this standalone setter exists for symmetry with the
    // other credential stores + a token-only re-seal. Upsert (org_id, manager_id, provider). org-scoped.
    await this.db.query(
      `INSERT INTO manager_credential (org_id, manager_id, provider, ciphertext, nonce, auth_tag, key_fingerprint, status, created_by, last_validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8, now())
       ON CONFLICT (org_id, manager_id, provider) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag,
         key_fingerprint = EXCLUDED.key_fingerprint, status = 'active', last_validated_at = now()`,
      [orgId, managerId, provider, sealed.ciphertext, sealed.nonce, sealed.authTag, fingerprint, createdBy]
    );
  }

  async setProjectManager(orgId: string, projectId: string, managerId: string): Promise<'ok' | 'not_found'> {
    // Link a project → manager, BOTH verified in THIS org in ONE transaction. A foreign-org project id
    // OR manager id is INDISTINGUISHABLE from a missing one ('not_found') — no cross-tenant existence
    // oracle, and a foreign-org entity is never linked. The UPDATE is itself org-scoped (org_id + id), so
    // even the write can only touch this org's project.
    return this.withTaskTx(async (db) => {
      const proj = await db.query(`SELECT 1 FROM project WHERE org_id = $1 AND id = $2`, [orgId, projectId]);
      if (!proj.rowCount) return 'not_found';
      const mgr = await db.query(`SELECT 1 FROM manager WHERE org_id = $1 AND id = $2`, [orgId, managerId]);
      if (!mgr.rowCount) return 'not_found';
      await db.query(`UPDATE project SET manager_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, projectId, managerId]);
      return 'ok';
    });
  }

  async getManagerForProject(orgId: string, projectId: string): Promise<string | null> {
    // ORG-SCOPED: returns this org's project's assigned manager id, or null (no manager / foreign-org /
    // missing project — all indistinguishable). Never reveals another tenant's link.
    const res = await this.db.query<{ manager_id: string | null }>(
      `SELECT manager_id FROM project WHERE org_id = $1 AND id = $2`,
      [orgId, projectId]
    );
    return res.rows[0]?.manager_id ?? null;
  }

  async getTaskOrigin(orgId: string, taskId: string): Promise<TaskOrigin | null> {
    // One org-scoped read: the task's stored content + its parent's platform story (the status
    // target). The JOIN is org-scoped on both sides — a child can only resolve a parent in its OWN
    // org (parent_task_id FKs the same org-scoped task table), so no cross-org parent leak.
    const res = await this.db.query<{ content: { title: string; body: string } | null; parent_task_id: string | null; parent_story: string | null }>(
      `SELECT t.content, t.parent_task_id, p.external_story_id AS parent_story
         FROM task t
         LEFT JOIN task p ON p.id = t.parent_task_id AND p.org_id = t.org_id
        WHERE t.org_id = $1 AND t.id = $2`,
      [orgId, taskId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { content: row.content, parentTaskId: row.parent_task_id, parentExternalStoryId: row.parent_story };
  }

  async getTask(orgId: string, taskId: string): Promise<Task | null> {
    const res = await this.db.query<TaskRow>(
      `SELECT id, external_story_id, title, platform, status, version, claimed_by, failure_count, repo_ref, tier_estimate, last_error, preferred_agent_id, em_cleared, em_clarification_round
         FROM task WHERE org_id = $1 AND id = $2`,
      [orgId, taskId]
    );
    const row = res.rows[0];
    return row ? mapTask(row) : null;
  }

  async setTierEstimate(orgId: string, taskId: string, estimate: TierEstimate): Promise<void> {
    await this.db.query(
      `UPDATE task SET tier_estimate = $3::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, taskId, JSON.stringify(estimate)]
    );
  }

  async setTaskTitle(orgId: string, taskId: string, title: string): Promise<void> {
    // No version bump (a display label, not a state transition — it must not race the CAS).
    await this.db.query(
      `UPDATE task SET title = $3, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, taskId, title]
    );
  }

  /** Map a guarded UPDATE that RETURNs the new status to a TaskWriteOutcome: a row
   *  returned → ok; else a PK probe distinguishes `not_found` from `conflict`
   *  (exists but its status failed the guard). The probe is org-scoped, so a task in
   *  ANOTHER org reads as `not_found` — never `conflict` (which would leak its existence). */
  private async taskWrite(
    sql: string,
    params: unknown[],
    orgId: string,
    taskId: string
  ): Promise<TaskWriteOutcome> {
    return this.taskWriteOn(this.db, sql, params, orgId, taskId);
  }

  /** taskWrite against a specific Queryable (the tx client for the cancel-coupled path). */
  private async taskWriteOn(
    db: Queryable,
    sql: string,
    params: unknown[],
    orgId: string,
    taskId: string
  ): Promise<TaskWriteOutcome> {
    const res = await db.query<{ status: string }>(sql, params);
    if (res.rowCount && res.rows[0]) return { ok: true, status: res.rows[0].status as TaskStatus };
    const exists = await db.query(`SELECT 1 FROM task WHERE org_id = $1 AND id = $2`, [orgId, taskId]);
    return { ok: false, reason: exists.rowCount ? 'conflict' : 'not_found' };
  }

  /** Run `fn` in a transaction so a coupled write (job cancel + task transition, or proposal CAS +
   *  task re-route) commits together or not at all — a crash between them would orphan state. Mirrors
   *  PgIdentityRepository: a Pool owns a FRESH tx (BEGIN/COMMIT/ROLLBACK here); a single already-
   *  checked-out client reuses the CALLER's tx, so the caller's COMMIT/ROLLBACK is the atomic boundary.
   *  NOTE: when `this.db` is a bare client (NOT a Pool), this method adds no BEGIN/ROLLBACK of its own —
   *  atomicity then depends on the caller having opened a tx. Every method that needs all-or-nothing
   *  (cancelCoupledWrite, acceptRoutingProposal) is constructed against the Pool at the composition root,
   *  so the fresh-tx path is the one that runs in production and integration tests. */
  private async withTaskTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    if (!isPool(this.db)) return fn(this.db);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The shared cancel-coupled write: cancel the task's live runner job, then transition the
   * task — atomically. LOCK ORDER is dispatch_job (requestCancelForTask's FOR UPDATE) BEFORE
   * task (the transition UPDATE); every path that touches both tables uses this order, so
   * there is no deadlock. `target` is the post-cancel task status (routable=reassign,
   * needs_attention=interrupt). `nonExecuting` handles a task with no live job that is NOT
   * executing (reassign re-routes it; interrupt rejects it).
   */
  private async cancelCoupledWrite(
    orgId: string,
    taskId: string,
    target: 'routable' | 'needs_attention',
    nonExecuting: (db: Queryable) => Promise<TaskWriteOutcome>
  ): Promise<TaskWriteOutcome> {
    return this.withTaskTx(async (db) => {
      // ORG-OWNERSHIP GATE — first, inside the tx, BEFORE requestCancelForTask. A task in
      // another org (or absent) is `not_found`, and a cross-org request must NOT cancel its
      // runner job as a side effect. dispatch_job carries no org filter yet (slice 3c), so
      // gating on the task's org here is what keeps the job cancel from crossing tenants.
      const owned = await db.query(`SELECT 1 FROM task WHERE org_id = $1 AND id = $2`, [orgId, taskId]);
      if (!owned.rowCount) return { ok: false, reason: 'not_found' };

      const cancel = await new PgDispatchQueue(db).requestCancelForTask(taskId);
      if (cancel === 'too_late') return { ok: false, reason: 'too_late' };
      if (cancel === 'removed' || cancel === 'signalled') {
        // Cancel won → the task is executing and its run is being torn down (the runner
        // aborts + revokes its token). Move it to the target, fenced to `executing` so this
        // fires only on the run we just cancelled. claimed_by/failure_count reset: the claim
        // is gone and a cancel is not a failure.
        return this.taskWriteOn(
          db,
          `UPDATE task
              SET status = $3, claimed_by = NULL, failure_count = 0,
                  version = version + 1, updated_at = now()
            WHERE org_id = $1 AND id = $2 AND status = 'executing'
           RETURNING status`,
          [orgId, taskId, target],
          orgId,
          taskId
        );
      }
      // cancel === 'no_job': no runner job. An executing/in_review task is running in-process
      // (this seam can't interrupt it) → no_inflight; otherwise defer to the non-executing path.
      const cur = await db.query<{ status: string }>(
        `SELECT status FROM task WHERE org_id = $1 AND id = $2`,
        [orgId, taskId]
      );
      if (!cur.rowCount) return { ok: false, reason: 'not_found' };
      const status = cur.rows[0]!.status;
      if (status === 'executing' || status === 'in_review') return { ok: false, reason: 'no_inflight' };
      return nonExecuting(db);
    });
  }

  async escalateTask(orgId: string, taskId: string): Promise<TaskWriteOutcome> {
    // Admin override: force needs_attention from any non-terminal status.
    return this.taskWrite(
      `UPDATE task
          SET status = 'needs_attention', version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status <> 'done' AND status <> 'needs_attention'
       RETURNING status`,
      [orgId, taskId],
      orgId,
      taskId
    );
  }

  async overrideTierEstimate(orgId: string, taskId: string, tier: Tier): Promise<TaskWriteOutcome> {
    return this.tierEstimateWrite(this.db, orgId, taskId, tier, null);
  }

  /** The tier-override write, shared by overrideTierEstimate (no fence) and acceptTriageProposal
   *  (version-fenced, run inside the accept tx). Sets ONLY tier_estimate.tier (+ version bump),
   *  preserving other estimate fields; done-guarded so a finished task can't be re-tiered. When
   *  `expectedVersion` is non-null, also fences on it (a task that moved since → no row → conflict). */
  private async tierEstimateWrite(
    db: Queryable,
    orgId: string,
    taskId: string,
    tier: Tier,
    expectedVersion: number | null
  ): Promise<TaskWriteOutcome> {
    const fence = expectedVersion === null ? '' : ` AND version = ${expectedVersion}`;
    return this.taskWriteOn(
      db,
      `UPDATE task
          SET tier_estimate = jsonb_set(
                COALESCE(tier_estimate, '{"confidence":1,"signals":{},"classifierUsed":false}'::jsonb),
                '{tier}', to_jsonb($3::text)),
              version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status <> 'done'${fence}
       RETURNING status`,
      [orgId, taskId, tier],
      orgId,
      taskId
    );
  }

  async reassignTask(orgId: string, taskId: string): Promise<TaskWriteOutcome> {
    // Cancel any live run, then release the claim → re-route from a clean slate. For an
    // executing task the #244 cancel seam runs first (atomically with the transition); for
    // the non-executing reassignable states it is a plain guarded CAS.
    return this.cancelCoupledWrite(orgId, taskId, 'routable', (db) =>
      this.taskWriteOn(
        db,
        // Clean slate: also clear any Tasca-side routing preference (an accepted PM-assistant
        // proposal). A human reassign overrides a prior suggestion, so a stale preference must
        // not silently re-bias the re-route.
        `UPDATE task
            SET status = 'routable', claimed_by = NULL, failure_count = 0, preferred_agent_id = NULL,
                version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status IN ('routable','claimed','needs_attention','failed')
         RETURNING status`,
        [orgId, taskId],
        orgId,
        taskId
      )
    );
  }

  async interruptTask(orgId: string, taskId: string): Promise<TaskWriteOutcome> {
    // Halt a live run and flag for a human (→ needs_attention). Only meaningful while
    // executing; a non-executing task has nothing live to interrupt → conflict.
    return this.cancelCoupledWrite(orgId, taskId, 'needs_attention', () =>
      Promise.resolve({ ok: false, reason: 'conflict' })
    );
  }

  async forceResetTask(orgId: string, taskId: string): Promise<TaskWriteOutcome> {
    // Stuck-task recovery (#317): clear a task wedged in executing/claimed with no live job.
    // Unlike escalateTask, this ALSO clears claimed_by + failure_count so the agent releases
    // (its "working" pill is derived purely from claimed_by) and unhire/UI reconcile. Guarding
    // to executing/claimed makes it idempotent — a second call matches no row → conflict, never
    // a spurious version bump. Does NOT touch any runner job: the fence + version bump fence out
    // a late zombie finalize, and this is precisely the path for when no job remains to cancel.
    return this.taskWrite(
      `UPDATE task
          SET status = 'needs_attention', claimed_by = NULL, failure_count = 0,
              last_error = 'force-reset by operator (stuck run cleared)',
              version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('executing','claimed')
       RETURNING status`,
      [orgId, taskId],
      orgId,
      taskId
    );
  }

  // ── PM-assistant proposals (slice W3-S1) ────────────────────────────────────

  async listProposals(
    orgId: string,
    opts: { status?: ProposalStatus; kind?: ProposalKind; limit?: number } = {}
  ): Promise<Proposal[]> {
    const where = ['org_id = $1'];
    const params: unknown[] = [orgId];
    if (opts.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts.kind) {
      params.push(opts.kind);
      where.push(`kind = $${params.length}`);
    }
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    const res = await this.db.query<ProposalRow>(
      `SELECT id, kind, target_task_id, target_version, payload, status, version, created_at
         FROM proposal WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return res.rows.map(mapProposal);
  }

  async getProposal(orgId: string, id: string): Promise<Proposal | null> {
    const res = await this.db.query<ProposalRow>(
      `SELECT id, kind, target_task_id, target_version, payload, status, version, created_at
         FROM proposal WHERE org_id = $1 AND id = $2`,
      [orgId, id]
    );
    const row = res.rows[0];
    return row ? mapProposal(row) : null;
  }

  async createProposal(orgId: string, input: CreateProposalInput): Promise<Proposal> {
    const res = await this.db.query<ProposalRow>(
      `INSERT INTO proposal (id, org_id, kind, target_task_id, target_version, payload, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending')
       RETURNING id, kind, target_task_id, target_version, payload, status, version, created_at`,
      [
        randomUUID(),
        orgId,
        input.kind,
        input.targetTaskId,
        input.targetVersion,
        JSON.stringify(input.payload ?? {}),
      ]
    );
    return mapProposal(res.rows[0]!);
  }

  async dismissProposal(orgId: string, id: string): Promise<ProposalWriteOutcome> {
    // CAS pending→dismissed; loser (already accepted/dismissed, or another org) gets the
    // exists-check verdict. No binding effect — a dismiss only marks the suggestion handled.
    const res = await this.db.query(
      `UPDATE proposal SET status = 'dismissed', version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status = 'pending'`,
      [orgId, id]
    );
    if (res.rowCount === 1) return { ok: true };
    return this.proposalMissOutcome(orgId, id);
  }

  async acceptRoutingProposal(
    orgId: string,
    id: string,
    preferredAgentId: string
  ): Promise<ProposalWriteOutcome> {
    return this.withTaskTx<ProposalWriteOutcome>(async (db) => {
      // 1) CAS the proposal pending→accepted, scoped to org + kind='routing'. Only the winner
      //    proceeds to the binding write — this is what makes the binding run AT MOST ONCE under
      //    a double-accept race.
      const claimed = await db.query<{ target_task_id: string | null; target_version: number | null }>(
        `UPDATE proposal SET status = 'accepted', version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'pending' AND kind = 'routing'
        RETURNING target_task_id, target_version`,
        [orgId, id]
      );
      if (claimed.rowCount !== 1) return this.proposalMissOutcome(orgId, id, db);
      const targetTaskId = claimed.rows[0]!.target_task_id;
      const targetVersion = claimed.rows[0]!.target_version;
      if (!targetTaskId) {
        // A routing proposal with no target task is malformed — roll back so it stays pending.
        throw new RollbackProposal({ ok: false, reason: 'conflict' });
      }
      // target_version is an integer column; guard it before interpolation so a corrupt value can
      // never reach the SQL as `version = NaN` (which would match nothing — fail closed — but
      // silently). An explicit conflict makes the invariant legible.
      if (targetVersion !== null && !Number.isInteger(targetVersion)) {
        throw new RollbackProposal({ ok: false, reason: 'conflict' });
      }
      // 2) The binding write: set the routing preference + re-route, fenced to a non-executing
      //    reassignable status AND the version the proposal was generated against (a task that
      //    moved since → no row → conflict, the proposal is stale). Identical re-route to a
      //    reassign, plus preferred_agent_id. Throwing rolls back the proposal CAS → stays pending.
      const versionFence = targetVersion === null ? '' : ` AND version = ${targetVersion}`;
      const moved = await db.query(
        `UPDATE task
            SET status = 'routable', claimed_by = NULL, failure_count = 0,
                preferred_agent_id = $3, version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2
            AND status IN ('routable','claimed','needs_attention','failed')${versionFence}
         RETURNING status`,
        [orgId, targetTaskId, preferredAgentId]
      );
      if (moved.rowCount !== 1) {
        const exists = await db.query(`SELECT 1 FROM task WHERE org_id = $1 AND id = $2`, [orgId, targetTaskId]);
        throw new RollbackProposal({ ok: false, reason: exists.rowCount ? 'conflict' : 'not_found' });
      }
      return { ok: true };
    }).catch((err) => {
      if (err instanceof RollbackProposal) return err.outcome;
      throw err;
    });
  }

  async acceptTriageProposal(orgId: string, id: string, tier: Tier): Promise<ProposalWriteOutcome> {
    return this.withTaskTx<ProposalWriteOutcome>(async (db) => {
      // 1) CAS the proposal pending→accepted (org + kind='triage'). At-most-once: only the winner
      //    proceeds to the binding write.
      const claimed = await db.query<{ target_task_id: string | null; target_version: number | null }>(
        `UPDATE proposal SET status = 'accepted', version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'pending' AND kind = 'triage'
        RETURNING target_task_id, target_version`,
        [orgId, id]
      );
      if (claimed.rowCount !== 1) return this.proposalMissOutcome(orgId, id, db);
      const targetTaskId = claimed.rows[0]!.target_task_id;
      const targetVersion = claimed.rows[0]!.target_version;
      if (!targetTaskId) throw new RollbackProposal({ ok: false, reason: 'conflict' });
      if (targetVersion !== null && !Number.isInteger(targetVersion)) {
        throw new RollbackProposal({ ok: false, reason: 'conflict' });
      }
      // 2) The binding write: apply the tier via the SAME write overrideTierEstimate performs
      //    (tierEstimateWrite) — version-fenced + done-guarded, NOTHING but tier_estimate.tier.
      //    A task that moved/finished since → not ok → roll back so the proposal stays pending.
      const outcome = await this.tierEstimateWrite(db, orgId, targetTaskId, tier, targetVersion);
      if (!outcome.ok) {
        throw new RollbackProposal({ ok: false, reason: outcome.reason === 'not_found' ? 'not_found' : 'conflict' });
      }
      return { ok: true };
    }).catch((err) => {
      if (err instanceof RollbackProposal) return err.outcome;
      throw err;
    });
  }

  async acceptDecompositionProposal(
    orgId: string,
    id: string,
    children: Array<{ title: string; body: string }>
  ): Promise<ProposalWriteOutcome> {
    return this.withTaskTx<ProposalWriteOutcome>(async (db) => {
      // 1) CAS the proposal pending→accepted (org + kind='decomposition'). At-most-once.
      const claimed = await db.query<{ target_task_id: string | null; target_version: number | null }>(
        `UPDATE proposal SET status = 'accepted', version = version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'pending' AND kind = 'decomposition'
        RETURNING target_task_id, target_version`,
        [orgId, id]
      );
      if (claimed.rowCount !== 1) return this.proposalMissOutcome(orgId, id, db);
      const parentTaskId = claimed.rows[0]!.target_task_id;
      const targetVersion = claimed.rows[0]!.target_version;
      if (!parentTaskId) throw new RollbackProposal({ ok: false, reason: 'conflict' });
      // target_version is an integer column; guard it before interpolation so a corrupt value can
      // never reach the SQL as `version = NaN` (which would match nothing — fail closed — but
      // silently). An explicit conflict makes the invariant legible.
      if (targetVersion !== null && !Number.isInteger(targetVersion)) {
        throw new RollbackProposal({ ok: false, reason: 'conflict' });
      }
      // 2) Read the PARENT in the same tx, version-fenced + not-done. A parent that moved/finished
      //    since the proposal was generated → conflict, roll back (all-or-nothing — no orphan children).
      const fence = targetVersion === null ? '' : ` AND version = ${targetVersion}`;
      const parent = await db.query<{ external_story_id: string; platform: string; repo_ref: string | null }>(
        `SELECT external_story_id, platform, repo_ref FROM task
          WHERE org_id = $1 AND id = $2 AND status <> 'done'${fence}`,
        [orgId, parentTaskId]
      );
      if (parent.rowCount !== 1) {
        const exists = await db.query(`SELECT 1 FROM task WHERE org_id = $1 AND id = $2`, [orgId, parentTaskId]);
        throw new RollbackProposal({ ok: false, reason: exists.rowCount ? 'conflict' : 'not_found' });
      }
      // DECOMPOSE-ONCE: a parent is split at most once. The child story ids are deterministic
      // (`parent#sub-N`), so a SECOND (different) decomposition of the same parent would collide on
      // those ids and silently keep the FIRST decomposition's content (ON CONFLICT does not overwrite
      // a child — a child may already be in flight). Reject instead, so a stale split can never
      // shadow a live one. (A re-accept of the SAME proposal is already blocked by the CAS above; a
      // rolled-back tx leaves no children, so a genuine retry still proceeds cleanly.)
      const already = await db.query(
        `SELECT 1 FROM task WHERE org_id = $1 AND parent_task_id = $2 LIMIT 1`,
        [orgId, parentTaskId]
      );
      if (already.rowCount) throw new RollbackProposal({ ok: false, reason: 'conflict' });
      const p = parent.rows[0]!;
      // 3) The binding write: create each child via getOrCreateTask. Children inherit the parent's
      //    org/platform/repo and carry their own content + a parent pointer. NOTHING is written to the
      //    parent (status/claim/routing untouched) — the parent keeps its lifecycle; the children are
      //    new routable tasks. The deterministic id + the decompose-once guard make this idempotent.
      for (let i = 0; i < children.length; i++) {
        await this.getOrCreateTaskOn(db, orgId, {
          externalStoryId: `${p.external_story_id}#sub-${i}`,
          platform: p.platform as CreateTaskInput['platform'],
          repoRef: p.repo_ref,
          content: { title: children[i]!.title, body: children[i]!.body },
          parentTaskId,
        });
      }
      return { ok: true };
    }).catch((err) => {
      if (err instanceof RollbackProposal) return err.outcome;
      throw err;
    });
  }

  /** The miss-verdict for a proposal CAS that moved no row: `not_found` (absent/other org) vs
   *  `conflict` (exists but not `pending` — already accepted/dismissed). */
  private async proposalMissOutcome(
    orgId: string,
    id: string,
    db: Queryable = this.db
  ): Promise<ProposalWriteOutcome> {
    const exists = await db.query(`SELECT 1 FROM proposal WHERE org_id = $1 AND id = $2`, [orgId, id]);
    return { ok: false, reason: exists.rowCount ? 'conflict' : 'not_found' };
  }

  async setStatus(orgId: string, taskId: string, status: TaskStatus): Promise<void> {
    // Enforce the domain transition rules at the write boundary: the row only moves
    // to `status` when its current status legally precedes it (TASK_TRANSITIONS),
    // checked IN the UPDATE so there's no read-then-write race. No identity special
    // case — a status only re-affirms itself when TASK_TRANSITIONS gives it a
    // self-loop (e.g. routable's pre-claim failure reset), which the inverse map
    // already carries; terminal `done` therefore cannot be re-written.
    const allowedFrom = VALID_PREDECESSORS[status];
    const res = await this.db.query(
      `UPDATE task SET status = $3, version = version + 1, updated_at = now()
         WHERE org_id = $1 AND id = $2 AND status = ANY($4::text[])`,
      [orgId, taskId, status, allowedFrom]
    );
    if (res.rowCount === 0) {
      // Nothing moved: the task is gone (or in another org), or its current status doesn't
      // legally precede `status`. Read it back (org-scoped) for a precise error. (The read
      // is a separate snapshot — a concurrent writer could have changed the row between the
      // UPDATE and here; we don't try to distinguish that, since the on-disk state is
      // correct either way and the message reports the status we observed.)
      const cur = await this.db.query<{ status: TaskStatus }>(
        `SELECT status FROM task WHERE org_id = $1 AND id = $2`,
        [orgId, taskId]
      );
      if (cur.rowCount === 0) {
        throw new Error(`setStatus: task ${taskId} not found`);
      }
      throw new Error(`setStatus: illegal transition ${cur.rows[0]!.status} -> ${status}`);
    }
  }

  async recordFailureAndTransition(
    orgId: string,
    taskId: string,
    breakerThreshold: number
  ): Promise<{ failureCount: number; tripped: boolean }> {
    // One atomic UPDATE: bump the counter and pick the resulting status in the
    // same statement. The `failure_count + 1 >= threshold` test mirrors the
    // breaker() in @tasca/routing (the source of the threshold semantics) — at or
    // over the threshold the task trips to `needs_attention` (claim retained for
    // the human); below it the task is reset to `routable` with `claimed_by`
    // cleared so the next CAS re-claims the SAME row at a fresh version.
    const res = await this.db.query<{ failure_count: number; status: string }>(
      `UPDATE task
          SET failure_count = failure_count + 1,
              status     = CASE WHEN failure_count + 1 >= $3 THEN 'needs_attention' ELSE 'routable' END,
              claimed_by = CASE WHEN failure_count + 1 >= $3 THEN claimed_by ELSE NULL END,
              version    = version + 1,
              updated_at = now()
        WHERE org_id = $1 AND id = $2
       RETURNING failure_count, status`,
      [orgId, taskId, breakerThreshold]
    );
    const row = res.rows[0]!;
    return { failureCount: row.failure_count, tripped: row.status === 'needs_attention' };
  }

  async recordRunnerFailure(
    orgId: string,
    taskId: string,
    breakerThreshold: number
  ): Promise<{ acted: boolean; failureCount: number; tripped: boolean }> {
    // Same atomic increment+transition as recordFailureAndTransition, but fenced to a
    // live post-claim status so a re-finalized job can't double-count the breaker.
    const res = await this.db.query<{ failure_count: number; status: string }>(
      `UPDATE task
          SET failure_count = failure_count + 1,
              status     = CASE WHEN failure_count + 1 >= $3 THEN 'needs_attention' ELSE 'routable' END,
              claimed_by = CASE WHEN failure_count + 1 >= $3 THEN claimed_by ELSE NULL END,
              version    = version + 1,
              updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('executing','claimed')
       RETURNING failure_count, status`,
      [orgId, taskId, breakerThreshold]
    );
    if (res.rowCount !== 1) return { acted: false, failureCount: 0, tripped: false };
    const row = res.rows[0]!;
    return { acted: true, failureCount: row.failure_count, tripped: row.status === 'needs_attention' };
  }

  async failNoCapacity(orgId: string, taskId: string, reason: string): Promise<boolean> {
    // → needs_attention WITHOUT touching failure_count (infra-unavailability, not an agent
    // failure). Records the reason in last_error. Guarded to a still-dispatched status so a
    // concurrent operator cancel/reassign (which already moved the task) wins and this no-ops.
    const res = await this.db.query(
      `UPDATE task
          SET status = 'needs_attention', last_error = $3, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('executing','claimed')`,
      [orgId, taskId, reason]
    );
    return res.rowCount === 1;
  }

  async retireNoChanges(orgId: string, taskId: string, reason: string): Promise<boolean> {
    // → needs_attention WITHOUT touching failure_count: a no-changes run is deterministic (the agent
    // already decided there is nothing to do), so retrying via the breaker just burns identical runs.
    // Guarded to a still-dispatched status so a concurrent operator cancel/reassign wins and this no-ops.
    const res = await this.db.query(
      `UPDATE task
          SET status = 'needs_attention', last_error = $3, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('executing','claimed')`,
      [orgId, taskId, reason]
    );
    return res.rowCount === 1;
  }

  async retireUnroutable(orgId: string, taskId: string, reason: string): Promise<boolean> {
    // Pre-claim retire to needs_attention (routing fail-close, slice 5d). Guarded to `routable` so a
    // concurrent claim that already moved the task wins and this no-ops. Breaker untouched.
    const res = await this.db.query(
      `UPDATE task
          SET status = 'needs_attention', last_error = $3, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status = 'routable'`,
      [orgId, taskId, reason]
    );
    return res.rowCount === 1;
  }

  async markEmCleared(orgId: string, taskId: string): Promise<void> {
    // Orthogonal to the lifecycle (status/version untouched): clearing only flips the gate flag so a
    // later re-drive of the SAME row isn't re-reviewed. org-scoped.
    await this.db.query(
      `UPDATE task SET em_cleared = true, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [orgId, taskId]
    );
  }

  async parkAwaitingClarification(orgId: string, taskId: string, round: number): Promise<boolean> {
    // → awaiting_clarification, recording the clarification round, WITHOUT touching the breaker (an
    // unclear story is not an agent failure). Guarded to `routable` so a concurrent claim that already
    // moved the task wins and this no-ops.
    const res = await this.db.query(
      `UPDATE task
          SET status = 'awaiting_clarification', em_clarification_round = $3, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status = 'routable'`,
      [orgId, taskId, round]
    );
    return res.rowCount === 1;
  }

  async updateBlockReason(orgId: string, taskId: string, humanReason: string): Promise<boolean> {
    // EM block-explanation (slice 4): upgrade ONLY last_error with the human rephrase — no status change,
    // no breaker. GUARDED to a still-blocked status so if the task moved on (resume → routable, re-drive →
    // executing, finalize → done) between the block and this best-effort rephrase, the update no-ops and
    // can't overwrite the live state with a stale reason. version is bumped so a watcher sees the text move.
    const res = await this.db.query(
      `UPDATE task
          SET last_error = $3, version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('needs_attention','failed')`,
      [orgId, taskId, humanReason]
    );
    return res.rowCount === 1;
  }

  async getAwaitingClarificationTask(
    orgId: string,
    platform: 'shortcut' | 'github' | 'linear',
    externalStoryId: string
  ): Promise<Task | null> {
    // ORG-SCOPED + status-filtered: only a task PARKED at awaiting_clarification for this org's story
    // matches. A reply on a story whose task already moved on (routable/cleared/dispatched/done) → no row
    // → the resume no-ops. (platform, external_story_id) is the same key getOrCreateTask uses.
    const res = await this.db.query<TaskRow>(
      `SELECT id, external_story_id, title, platform, status, version, claimed_by, failure_count, repo_ref, tier_estimate, last_error, preferred_agent_id, em_cleared, em_clarification_round
         FROM task
        WHERE org_id = $1 AND platform = $2 AND external_story_id = $3 AND status = 'awaiting_clarification'`,
      [orgId, platform, externalStoryId]
    );
    const row = res.rows[0];
    return row ? mapTask(row) : null;
  }

  async resumeFromClarification(orgId: string, taskId: string): Promise<boolean> {
    // awaiting_clarification → routable so the gate re-runs. em_cleared stays false (re-judge) and
    // em_clarification_round is UNTOUCHED (the cap counts across resumes). Guarded to
    // `awaiting_clarification` so a concurrent move wins and this no-ops. Breaker untouched.
    const res = await this.db.query(
      `UPDATE task
          SET status = 'routable', version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status = 'awaiting_clarification'`,
      [orgId, taskId]
    );
    return res.rowCount === 1;
  }

  async recordRoutingDecision(
    orgId: string,
    input: {
      taskId: string;
      tierEstimate: TierEstimate;
      candidates: CapabilityMatch[];
      winnerAgentId: string | null;
    }
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO routing_decision (id, org_id, task_id, tier_estimate, candidates, winner_agent_id)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        randomUUID(),
        orgId,
        input.taskId,
        JSON.stringify(input.tierEstimate),
        JSON.stringify(input.candidates),
        input.winnerAgentId,
      ]
    );
  }

  async recordPullRequest(orgId: string, input: { taskId: string; url: string }): Promise<void> {
    // Idempotent on (task_id, url): a re-finalize (reaper at-least-once) is a no-op
    // rather than a duplicate PR row — the hard storage-layer guarantee behind the
    // reaper's read-then-write check. org_id is set on insert (the row is the task's org);
    // the (task_id, url) unique stays sufficient since task_id is globally unique.
    await this.db.query(
      `INSERT INTO pull_request (id, org_id, task_id, url) VALUES ($1,$2,$3,$4)
       ON CONFLICT (task_id, url) DO NOTHING`,
      [randomUUID(), orgId, input.taskId, input.url]
    );
  }

  async markPullRequestMerged(orgId: string, url: string): Promise<void> {
    // ORG-SCOPED flip to `merged`. The caller resolves the org from the PR row first
    // (getTaskIdByPullRequestUrl), so the org_id predicate only ever matches the row
    // this org owns; a missing/foreign row updates zero rows (a silent no-op), never
    // a cross-tenant write. Idempotent: re-marking an already-merged row is a no-op set.
    await this.db.query(`UPDATE pull_request SET state = 'merged' WHERE org_id = $1 AND url = $2`, [
      orgId,
      url,
    ]);
  }

  // ── GitHub App installation ───────────────────────────────────────────────────

  async upsertGitHubInstallation(
    orgId: string,
    input: {
      workspaceId: string;
      installationId: string;
    }
  ): Promise<void> {
    // Upsert on UNIQUE(org_id, platform, workspace_id) with platform='github' — the
    // org-prefixed unique created by ORG_CONTRACT_DDL, in lockstep with org_id in the
    // column set. The no-op for everything but installation_id keeps an existing
    // connection's health.
    await this.db.query(
      `INSERT INTO platform_connection (id, org_id, platform, workspace_id, installation_id)
       VALUES ($1,$2,'github',$3,$4)
       ON CONFLICT (org_id, platform, workspace_id) DO UPDATE SET
         installation_id = EXCLUDED.installation_id`,
      [randomUUID(), orgId, input.workspaceId, input.installationId]
    );
  }

  async getInstallationIdForOwner(owner: string): Promise<string | null> {
    // CROSS-ORG (see the interface note): an installation is keyed by (platform,
    // workspace_id) across all tenants, so this resolves regardless of org.
    const res = await this.db.query<{ installation_id: string | null }>(
      `SELECT installation_id FROM platform_connection
        WHERE platform = 'github' AND workspace_id = $1 AND health <> 'revoked'`,
      [owner]
    );
    return res.rows[0]?.installation_id ?? null;
  }

  async updateInstallationByAccount(account: string, installationId: string): Promise<boolean> {
    // Confirmation only (slice 5c) — refresh installation_id + health by account; never touches
    // org_id (the connect callback binds that). Cross-org by the globally-unique GitHub account.
    const res = await this.db.query(
      `UPDATE platform_connection SET installation_id = $2, health = 'healthy'
        WHERE platform = 'github' AND workspace_id = $1`,
      [account, installationId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async revokeInstallationByAccount(account: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE platform_connection SET health = 'revoked'
        WHERE platform = 'github' AND workspace_id = $1`,
      [account]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Shortcut connection ↔ project binding (slice SC-1) ────────────────────────
  async upsertShortcutConnection(
    orgId: string,
    input: { workspaceId: string; projectId: string }
  ): Promise<{ connectionId: string }> {
    // Upsert on the org-prefixed UNIQUE(org_id, platform, workspace_id) with platform='shortcut': a
    // re-configure of the same workspace updates its project_id + un-revokes (health back to healthy)
    // in place, keeping the existing id so the operator's webhook URL is stable. RETURNING (on both the
    // insert and the update) yields the canonical id. org-scoped — a connection can only land here.
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO platform_connection (id, org_id, platform, workspace_id, project_id)
       VALUES ($1,$2,'shortcut',$3,$4)
       ON CONFLICT (org_id, platform, workspace_id) DO UPDATE SET
         project_id = EXCLUDED.project_id, health = 'healthy'
       RETURNING id`,
      [randomUUID(), orgId, input.workspaceId, input.projectId]
    );
    return { connectionId: res.rows[0]!.id };
  }

  async getShortcutConnectionById(
    connectionId: string
  ): Promise<{ orgId: string; repoRef: string | null } | null> {
    // CROSS-ORG by design (the connection id is the routing key — see the interface note): a LEFT JOIN
    // to project resolves the bound repo_ref within the connection's OWN org. A revoked or non-shortcut
    // connection does not resolve (fail closed). repo_ref is null when no project is bound or the bound
    // project is the Unassigned (null-repo) bucket.
    const res = await this.db.query<{ org_id: string; repo_ref: string | null }>(
      `SELECT pc.org_id, p.repo_ref
         FROM platform_connection pc
         LEFT JOIN project p ON p.id = pc.project_id AND p.org_id = pc.org_id
        WHERE pc.id = $1 AND pc.platform = 'shortcut' AND pc.health <> 'revoked'`,
      [connectionId]
    );
    const row = res.rows[0];
    return row ? { orgId: row.org_id, repoRef: row.repo_ref } : null;
  }

  // ── Cross-org resolvers (the ONLY unscoped tenant reads — slice 3b-2) ──────────

  async getOrgForConnection(
    platform: 'shortcut' | 'github' | 'linear',
    workspaceId: string
  ): Promise<string | null> {
    // Discover the org that owns a workspace's connection (webhook → org). Unscoped by
    // design: it is resolving WHICH org, so it cannot already be org-scoped. A REVOKED connection
    // does NOT resolve (slice 5c) — an uninstalled/revoked account's webhooks must fail closed, not
    // keep running in the formerly-bound tenant. null = no live connection.
    const res = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM platform_connection WHERE platform = $1 AND workspace_id = $2 AND health <> 'revoked'`,
      [platform, workspaceId]
    );
    return res.rows[0]?.org_id ?? null;
  }

  async getOrgForTask(taskId: string): Promise<string | null> {
    // Discover the org that owns a task (worker → org). Unscoped by design (resolving
    // WHICH org). null = the task is gone (the reaper then just reaps its job).
    const res = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM task WHERE id = $1`,
      [taskId]
    );
    return res.rows[0]?.org_id ?? null;
  }

  async getTaskIdByPullRequestUrl(
    url: string
  ): Promise<{ orgId: string; taskId: string } | null> {
    // Discover the org + task a recorded PR belongs to (GitHub merge webhook → org/task).
    // Unscoped by design: the merge webhook arrives with no org, only the PR url, so this
    // is resolving WHICH org/task owns it (the url is the routing key). null = no recorded
    // PR for that url — a PR Tasca did not open — and the merge handler then no-ops.
    const res = await this.db.query<{ org_id: string; task_id: string }>(
      `SELECT org_id, task_id FROM pull_request WHERE url = $1`,
      [url]
    );
    const row = res.rows[0];
    return row ? { orgId: row.org_id, taskId: row.task_id } : null;
  }

  // ── Read-side queries ───────────────────────────────────────────────────────

  async listTasks(
    orgId: string,
    filter?: { status?: TaskStatus; projectId?: string; limit?: number }
  ): Promise<TaskSummary[]> {
    // Newest-first by created_at, scoped to org; status + project filters are optional. org_id stays
    // the tenant boundary; project_id (when present) is a FINER filter WITHIN it — an absent projectId
    // is the cross-project view (all of the org's projects). The limit is clamped to a sane ceiling so
    // a hostile/oversized ?limit can't ask for the whole table.
    const limit = clampLimit(filter?.limit, 50, 200);
    const params: unknown[] = [orgId];
    let where = `WHERE org_id = $1`;
    if (filter?.status) {
      params.push(filter.status);
      where += ` AND status = $${params.length}`;
    }
    if (filter?.projectId) {
      params.push(filter.projectId);
      where += ` AND project_id = $${params.length}`;
    }
    params.push(limit);
    const res = await this.db.query<TaskRow>(
      `SELECT id, external_story_id, title, platform, status, version, claimed_by, failure_count, repo_ref, tier_estimate, last_error
         FROM task ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    return res.rows.map(mapTaskSummary);
  }

  async getTaskStatusCounts(orgId: string): Promise<Record<string, number>> {
    // Aggregate count of the org's tasks by status — the standup's data source (slice W3-S1d). An
    // aggregate, NOT a paginated list: it counts EVERY task in the org (no LIMIT, so a large org is
    // never silently under-counted), and is cheaper than fetching the rows. Org-scoped.
    const res = await this.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM task WHERE org_id = $1 GROUP BY status`,
      [orgId]
    );
    const out: Record<string, number> = {};
    for (const row of res.rows) out[row.status] = row.n;
    return out;
  }

  async recordUsage(orgId: string, e: UsageRecordInput): Promise<void> {
    // CAS-idempotent: the UNIQUE idempotency_key makes a retried/concurrent report of the SAME call a
    // no-op insert — at most one row per call, never a double-count. Org-scoped (org_id from the caller).
    await this.db.query(
      `INSERT INTO usage_event (id, org_id, task_id, source, model, input_tokens, output_tokens, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), orgId, e.taskId, e.source, e.model, e.inputTokens, e.outputTokens, e.idempotencyKey]
    );
  }

  async getUsage(orgId: string, opts?: { taskId?: string; since?: string }): Promise<UsageTotals> {
    const params: unknown[] = [orgId];
    let where = 'WHERE org_id = $1'; // ORG-SCOPED: a cross-org sum would be a billing leak
    if (opts?.taskId) {
      params.push(opts.taskId);
      where += ` AND task_id = $${params.length}`;
    }
    if (opts?.since) {
      params.push(opts.since);
      where += ` AND created_at >= $${params.length}`;
    }
    const res = await this.db.query<{ source: string; input: number; output: number }>(
      `SELECT source, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output
         FROM usage_event ${where} GROUP BY source`,
      params
    );
    const bySource: Record<string, { inputTokens: number; outputTokens: number }> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    for (const r of res.rows) {
      bySource[r.source] = { inputTokens: r.input, outputTokens: r.output };
      inputTokens += r.input;
      outputTokens += r.output;
    }
    return { inputTokens, outputTokens, bySource };
  }

  async getRoutingDecisionForTask(orgId: string, taskId: string): Promise<RoutingDecisionRecord | null> {
    const res = await this.db.query<RoutingDecisionRow>(
      `SELECT id, task_id, tier_estimate, candidates, winner_agent_id, created_at
         FROM routing_decision WHERE org_id = $1 AND task_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, taskId]
    );
    const row = res.rows[0];
    return row ? mapRoutingDecision(row) : null;
  }

  async listRoutingDecisions(orgId: string, limit?: number): Promise<RoutingDecisionRecord[]> {
    const capped = clampLimit(limit, 50, 200);
    const res = await this.db.query<RoutingDecisionRow>(
      `SELECT id, task_id, tier_estimate, candidates, winner_agent_id, created_at
         FROM routing_decision WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [orgId, capped]
    );
    return res.rows.map(mapRoutingDecision);
  }

  async listPullRequestsForTask(orgId: string, taskId: string): Promise<PullRequestRecord[]> {
    const res = await this.db.query<PullRequestRow>(
      `SELECT url, state, created_at FROM pull_request WHERE org_id = $1 AND task_id = $2 ORDER BY created_at DESC`,
      [orgId, taskId]
    );
    return res.rows.map((r) => ({
      url: r.url,
      state: r.state as PullRequestRecord['state'],
      createdAt: toIso(r.created_at),
    }));
  }

  async listConnections(orgId: string): Promise<ConnectionSummary[]> {
    // One row per configured platform_connection IN THIS ORG. Webhook counters are derived
    // from the webhook_event ledger over the last 24h — real counts, not seeded; a platform
    // with no events shows honest zeros and a null last-received. The ledger subquery is
    // org-scoped too, so counters reflect only this tenant's deliveries.
    const res = await this.db.query<ConnectionRow>(
      `SELECT
         pc.platform,
         pc.workspace_id,
         pc.health,
         COALESCE(w.received_24h, 0)  AS received_24h,
         COALESCE(w.processed_24h, 0) AS processed_24h,
         w.last_received_at
       FROM platform_connection pc
       LEFT JOIN (
         SELECT platform,
                count(*) FILTER (WHERE received_at >= now() - interval '24 hours')                          AS received_24h,
                count(*) FILTER (WHERE status = 'processed' AND processed_at >= now() - interval '24 hours') AS processed_24h,
                max(received_at)                                                                             AS last_received_at
           FROM webhook_event WHERE org_id = $1 GROUP BY platform
       ) w ON w.platform = pc.platform
       WHERE pc.org_id = $1
       ORDER BY pc.platform`,
      [orgId]
    );
    return res.rows.map((r) => ({
      platform: r.platform as ConnectionSummary['platform'],
      workspaceId: r.workspace_id,
      health: r.health as ConnectionSummary['health'],
      webhook: {
        received24h: Number(r.received_24h),
        processed24h: Number(r.processed_24h),
        lastReceivedAt: r.last_received_at ? toIso(r.last_received_at) : null,
      },
    }));
  }
}

/** Clamp a caller-supplied limit to [1, max], falling back to `fallback`. */
function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  return n > max ? max : n;
}

/** pg returns timestamptz as a Date; normalize to an ISO string for the JSON wire. */
function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapTaskSummary(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    externalStoryId: row.external_story_id,
    title: row.title ?? null,
    platform: row.platform as TaskSummary['platform'],
    status: row.status as TaskStatus,
    tierEstimate: row.tier_estimate,
    repoRef: row.repo_ref,
    claimedBy: row.claimed_by,
    failureCount: row.failure_count,
    lastError: row.last_error ?? null,
  };
}

interface RoutingDecisionRow {
  id: string;
  task_id: string;
  tier_estimate: TierEstimate;
  candidates: CapabilityMatch[];
  winner_agent_id: string | null;
  created_at: Date | string;
}

function mapRoutingDecision(row: RoutingDecisionRow): RoutingDecisionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    tierEstimate: row.tier_estimate,
    candidates: row.candidates ?? [],
    winnerAgentId: row.winner_agent_id,
    createdAt: toIso(row.created_at),
  };
}

interface PullRequestRow {
  url: string;
  state: string;
  created_at: Date | string;
}

interface GovernanceAuditRow {
  id: string;
  actor_user_id: string;
  action: string;
  target: string | null;
  payload: Record<string, unknown> | null;
  at: Date | string;
}

function mapGovernanceAudit(row: GovernanceAuditRow): GovernanceAuditEvent {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    target: row.target,
    payload: row.payload ?? {},
    at: toIso(row.at),
  };
}

interface ConnectionRow {
  platform: string;
  workspace_id: string;
  health: string;
  received_24h: number | string;
  processed_24h: number | string;
  last_received_at: Date | string | null;
}

function isPool(db: Queryable): db is Pool {
  // Discriminate by `release()`: a checked-out PoolClient has it, a Pool does not.
  // (Mirrors PgIdentityRepository — `connect()` is not a valid discriminator since pg's
  // PoolClient is a Client and also exposes it.) Used to decide tx ownership.
  return typeof (db as { release?: unknown }).release !== 'function';
}
