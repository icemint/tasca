import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  CapabilityProfile,
  ClaimOutcome,
  ClaimPort,
  Task,
  TaskStatus,
  TierEstimate,
} from '@tasca/domain';
import type { AdapterEvent } from '@tasca/contracts';
import {
  ExecutionError,
  type AgentProcessHandle,
  type ExecutionPort,
  type OpenPrInput,
  type OpenPrResult,
  type CommitAgentWorkInput,
  type CommitAgentWorkResult,
  type ReserveWorktreeInput,
  type SpawnAgentInput,
  type Worktree,
} from '@tasca/execution';
import type { DispatchJob, DispatchJobInput, DispatchQueue } from '@tasca/db';
import { orchestrateTaskAssigned, type OrchestrationDeps } from './orchestrate';
import { currentUsageContext } from './usage-context';
import type { CoordinationStore, TaskWriteOutcome, Proposal, CreateProposalInput, ProposalWriteOutcome, TaskOrigin, UsageRecordInput } from './store';
import type { StatusReporter, StatusUpdate } from './ports';
import type { AgentDirectory, AuditSink, RepoProvisioner, TaskContentSource } from './orchestrate';
import type { MatchCandidate } from '@tasca/routing';

// ── In-memory fakes ───────────────────────────────────────────────────────────

class FakeStore implements CoordinationStore {
  tasks = new Map<string, Task>();
  routingDecisions: Array<{ taskId: string; winnerAgentId: string | null; policy: 'em' | 'rank' }> = [];
  pullRequests: Array<{ taskId: string; url: string }> = [];
  events = new Map<string, 'received' | 'processed'>();

  // Cross-org resolvers. connectionOrg is the org a workspace resolves to (slice 5c): default
  // 'org_default' = a connected/grandfathered workspace; set null to simulate an UNCONNECTED
  // workspace (a github event then fails closed via resolveWebhookOrg).
  connectionOrg: string | null = 'org_default';
  async getOrgForConnection(_platform: Task['platform'], _workspaceId: string) {
    return this.connectionOrg;
  }
  async getOrgForTask(taskId: string) {
    return this.tasks.has(taskId) ? 'org_default' : null;
  }
  async recordWebhookEvent(_orgId: string, input: { platform: string; externalEventId: string }) {
    const key = `${input.platform}:${input.externalEventId}`;
    const existing = this.events.get(key);
    if (existing === undefined) {
      this.events.set(key, 'received');
      return { fresh: true, alreadyProcessed: false };
    }
    return { fresh: false, alreadyProcessed: existing === 'processed' };
  }
  async markWebhookProcessed(_orgId: string, input: { platform: string; externalEventId: string }) {
    this.events.set(`${input.platform}:${input.externalEventId}`, 'processed');
  }
  async getOrCreateTask(_orgId: string, input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }) {
    // Get-or-create keyed by (platform, externalStoryId), mirroring the PG unique.
    for (const t of this.tasks.values()) {
      if (t.platform === input.platform && t.externalStoryId === input.externalStoryId) return t;
    }
    const task: Task = {
      id: randomUUID(),
      externalStoryId: input.externalStoryId,
      title: null,
      platform: input.platform,
      status: 'routable',
      version: 0,
      claimedBy: null,
      failureCount: 0,
      repoRef: input.repoRef ?? null,
      tierEstimate: null,
      lastError: null,
      preferredAgentId: null,
      emCleared: false,
      emClarificationRound: 0,
    };
    this.tasks.set(task.id, task);
    return task;
  }
  async getOrCreateProject() { return 'proj_x'; }
  async listProjects() { return []; }
  async getActiveProject() { return null; }
  async setActiveProject(): Promise<'ok' | 'not_found'> { return 'ok'; }
  async clearActiveProject(): Promise<void> {}
  async createManager(): Promise<{ managerId: string }> { return { managerId: 'mgr_x' }; }
  async getManager() { return null; }
  async listManagers() { return []; }
  async setManagerShortcutIdentity(): Promise<void> {}
  async setProjectManager(): Promise<'ok' | 'not_found'> { return 'ok'; }
  // EM router (EM v1 slice 1). Default null → legacy rank path (this suite's existing routing tests stay
  // unchanged). Settable so an EM-path unit test can opt a project into a manager.
  managerForProject: string | null = null;
  async getManagerForProject(): Promise<string | null> { return this.managerForProject; }
  // Active-load signal (EM v1 slice 1). Default empty (every agent idle); settable per agent so a unit
  // test can drive the least-loaded pick. The directory fake reads activeCount independently here.
  activeByAgent = new Map<string, number>();
  async countActiveByAgent(): Promise<Map<string, number>> { return this.activeByAgent; }
  // Per-PROJECT active load (EM v1 slice 1 — the dispatch gate). Keyed by repoRef; default 0 (repo idle).
  // Settable so a unit test can drive the per-project gate independently of the per-agent count.
  activeOnProject = new Map<string, number>();
  async countActiveOnProject(_orgId: string, repoRef: string): Promise<number> { return this.activeOnProject.get(repoRef) ?? 0; }
  async getTask(_orgId: string, taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }
  // Task origins (slice W3-S1c) — seed an entry to simulate a decomposition child (stored content
  // + parent story); absent = a normal task (content fetched from the platform).
  origins = new Map<string, TaskOrigin>();
  async getTaskOrigin(_orgId: string, taskId: string): Promise<TaskOrigin | null> {
    return this.origins.get(taskId) ?? null;
  }
  async setTierEstimate(_orgId: string, taskId: string, estimate: TierEstimate) {
    const t = this.tasks.get(taskId)!;
    t.tierEstimate = estimate;
  }
  titleWrites: Array<{ taskId: string; title: string }> = [];
  setTaskTitleThrows = false;
  async setTaskTitle(_orgId: string, taskId: string, title: string) {
    if (this.setTaskTitleThrows) throw new Error('title write boom');
    this.titleWrites.push({ taskId, title });
    const t = this.tasks.get(taskId);
    if (t) t.title = title;
  }
  async setStatus(_orgId: string, taskId: string, status: TaskStatus) {
    const t = this.tasks.get(taskId)!;
    t.status = status;
    t.version += 1;
  }
  async recordFailureAndTransition(_orgId: string, taskId: string, breakerThreshold: number) {
    // Mirror the atomic SQL: increment, then trip-or-reset by threshold.
    const t = this.tasks.get(taskId)!;
    t.failureCount += 1;
    const tripped = t.failureCount >= breakerThreshold;
    if (tripped) {
      t.status = 'needs_attention';
    } else {
      t.status = 'routable';
      t.claimedBy = null;
    }
    t.version += 1;
    return { failureCount: t.failureCount, tripped };
  }
  async recordRunnerFailure(orgId: string, taskId: string, breakerThreshold: number) {
    const t = this.tasks.get(taskId)!;
    if (t.status !== 'executing' && t.status !== 'claimed') {
      return { acted: false, failureCount: t.failureCount, tripped: false };
    }
    const r = await this.recordFailureAndTransition(orgId, taskId, breakerThreshold);
    return { acted: true, ...r };
  }
  noCapacityCalls: Array<{ taskId: string; reason: string }> = [];
  async failNoCapacity(_orgId: string, taskId: string, reason: string): Promise<boolean> {
    this.noCapacityCalls.push({ taskId, reason });
    const t = this.tasks.get(taskId)!;
    if (t.status !== 'executing' && t.status !== 'claimed') return false;
    t.status = 'needs_attention';
    t.lastError = reason;
    t.version += 1; // breaker/failure_count deliberately untouched
    return true;
  }
  noChangesCalls: Array<{ taskId: string; reason: string }> = [];
  /** Force retireNoChanges to no-op (simulating a concurrent operator cancel/reassign that already
   *  moved the task out of executing/claimed). */
  noChangesRetireActs = true;
  async retireNoChanges(_orgId: string, taskId: string, reason: string): Promise<boolean> {
    this.noChangesCalls.push({ taskId, reason });
    const t = this.tasks.get(taskId);
    if (!this.noChangesRetireActs || !t || (t.status !== 'executing' && t.status !== 'claimed')) return false;
    t.status = 'needs_attention';
    t.lastError = reason;
    t.version += 1; // breaker/failure_count deliberately untouched
    return true;
  }
  async upsertGitHubInstallation() {}
  async getInstallationIdForOwner() {
    return null;
  }
  async updateInstallationByAccount() {
    return false;
  }
  async revokeInstallationByAccount() {
    return false;
  }
  async upsertShortcutConnection() {
    return { connectionId: 'conn_x' };
  }
  async getShortcutConnectionById() {
    return null;
  }
  async getShortcutConnectionForOrg() {
    return null;
  }
  async deleteShortcutConnection() {
    return false;
  }
  async projectExistsInOrg() {
    return true;
  }
  retireCalls: Array<{ taskId: string; reason: string }> = [];
  async retireUnroutable(_orgId: string, taskId: string, reason: string): Promise<boolean> {
    this.retireCalls.push({ taskId, reason });
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'routable') return false;
    t.status = 'needs_attention';
    t.lastError = reason;
    t.version += 1;
    return true;
  }
  blockReasonCalls: Array<{ taskId: string; humanReason: string }> = [];
  async updateBlockReason(_orgId: string, taskId: string, humanReason: string): Promise<boolean> {
    this.blockReasonCalls.push({ taskId, humanReason });
    const t = this.tasks.get(taskId);
    // Guarded to a still-blocked status (mirrors the SQL): a task that moved on is not overwritten.
    if (!t || (t.status !== 'needs_attention' && t.status !== 'failed')) return false;
    t.lastError = humanReason;
    t.version += 1;
    return true;
  }
  emClearedCalls: string[] = [];
  async markEmCleared(_orgId: string, taskId: string): Promise<void> {
    this.emClearedCalls.push(taskId);
    const t = this.tasks.get(taskId);
    if (t) t.emCleared = true; // status/version untouched (orthogonal to the lifecycle)
  }
  parkCalls: Array<{ taskId: string; round: number }> = [];
  async parkAwaitingClarification(_orgId: string, taskId: string, round: number): Promise<boolean> {
    this.parkCalls.push({ taskId, round });
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'routable') return false;
    t.status = 'awaiting_clarification';
    t.emClarificationRound = round;
    t.version += 1; // breaker/failure_count deliberately untouched
    return true;
  }
  async getAwaitingClarificationTask(_orgId: string, platform: Task['platform'], externalStoryId: string): Promise<Task | null> {
    for (const t of this.tasks.values()) {
      if (t.platform === platform && t.externalStoryId === externalStoryId && t.status === 'awaiting_clarification') return t;
    }
    return null;
  }
  resumeCalls: string[] = [];
  async resumeFromClarification(_orgId: string, taskId: string): Promise<boolean> {
    this.resumeCalls.push(taskId);
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'awaiting_clarification') return false;
    t.status = 'routable'; // em_cleared + em_clarification_round untouched
    t.version += 1;
    return true;
  }
  async recordRoutingDecision(
    _orgId: string,
    input: { taskId: string; winnerAgentId: string | null; policy: 'em' | 'rank' }
  ) {
    this.routingDecisions.push({ taskId: input.taskId, winnerAgentId: input.winnerAgentId, policy: input.policy });
  }
  failRecordOnce = false;
  async recordPullRequest(_orgId: string, input: { taskId: string; url: string }) {
    if (this.failRecordOnce) {
      this.failRecordOnce = false;
      throw new Error('pull_request INSERT failed (connection dropped)');
    }
    this.pullRequests.push(input);
  }
  async markPullRequestMerged() {}
  async getTaskIdByPullRequestUrl(url: string) {
    const pr = this.pullRequests.find((p) => p.url === url);
    return pr ? { orgId: 'org_default', taskId: pr.taskId } : null;
  }
  // human write-API (unused by these orchestration tests)
  async escalateTask(): Promise<TaskWriteOutcome> {
    return { ok: false, reason: 'not_found' };
  }
  async overrideTierEstimate(): Promise<TaskWriteOutcome> {
    return { ok: false, reason: 'not_found' };
  }
  async reassignTask(): Promise<TaskWriteOutcome> {
    return { ok: false, reason: 'not_found' };
  }
  async interruptTask(): Promise<TaskWriteOutcome> {
    return { ok: false, reason: 'not_found' };
  }
  async forceResetTask(): Promise<TaskWriteOutcome> {
    return { ok: false, reason: 'not_found' };
  }
  // read-side
  async listTasks() { return []; }
  async getTaskStatusCounts() { return {}; }
  usageRecords: Array<{ orgId: string; source: string; idempotencyKey: string }> = [];
  async recordUsage(orgId: string, e: UsageRecordInput) {
    this.usageRecords.push({ orgId, source: e.source, idempotencyKey: e.idempotencyKey });
  }
  async getUsage() { return { inputTokens: 0, outputTokens: 0, bySource: {} }; }
  async getRoutingDecisionForTask() { return null; }
  async listRoutingDecisions() { return []; }
  async listPullRequestsForTask(_orgId: string, taskId: string) {
    return this.pullRequests
      .filter((p) => p.taskId === taskId)
      .map((p) => ({ url: p.url, state: 'open' as const, createdAt: '2026-01-01T00:00:00Z' }));
  }
  async listConnections() { return []; }
  // PM-assistant proposals (slice W3-S1) — not exercised by orchestration tests; the
  // preferred-agent routing tests pre-seed task.preferredAgentId directly.
  async listProposals() { return []; }
  async getProposal() { return null; }
  async createProposal(_orgId: string, input: CreateProposalInput): Promise<Proposal> {
    return { id: 'p', kind: input.kind, targetTaskId: input.targetTaskId, targetVersion: input.targetVersion, payload: input.payload, status: 'pending', version: 0, createdAt: '2026-01-01T00:00:00Z' };
  }
  async dismissProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async acceptRoutingProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async acceptTriageProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async acceptDecompositionProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
}

/** A claim port that wins iff the task is still routable at the expected version. */
class FakeClaimPort implements ClaimPort {
  constructor(private readonly store: FakeStore) {}
  async tryClaim(_orgId: string, taskId: string, agentId: string, expectedVersion: number): Promise<ClaimOutcome> {
    const t = this.store.tasks.get(taskId);
    if (t && t.status === 'routable' && t.version === expectedVersion) {
      t.status = 'claimed';
      t.claimedBy = agentId;
      t.version += 1;
      return { won: true, newVersion: t.version };
    }
    return { won: false, newVersion: null };
  }
}

function fakeHandle(opts: { exitCode?: number; error?: Error; hang?: boolean; output?: string }): AgentProcessHandle {
  return {
    pid: 1234,
    onData(listener) {
      if (opts.output) queueMicrotask(() => listener(opts.output!));
    },
    onExit(listener) {
      if (!opts.hang && !opts.error) queueMicrotask(() => listener(opts.exitCode ?? 0));
    },
    onError(listener) {
      if (!opts.hang && opts.error) queueMicrotask(() => listener(opts.error!));
    },
    kill() {},
  };
}

class FakeExecution implements ExecutionPort {
  spawnCalls = 0;
  prCalls = 0;
  reserveCalls = 0;
  commitCalls = 0;
  /** Records each reserveWorktree input so a test can assert the resolved repoPath. */
  reserveInputs: ReserveWorktreeInput[] = [];
  /** Records each spawnAgent input so a test can assert the prompt was passed. */
  spawnInputs: SpawnAgentInput[] = [];
  /** Records each commitAgentWork input. */
  commitInputs: CommitAgentWorkInput[] = [];
  /** Distinct PRs actually opened (keyed by head) — a duplicate would bump this past 1. */
  distinctPrs = 0;
  private readonly openedHeads = new Map<string, string>();
  /** Agent ids passed to killAgent (the timeout path reaps via this). */
  killed: string[] = [];
  constructor(
    private readonly behavior: {
      spawnExitCode?: number;
      spawnError?: Error;
      spawnHang?: boolean;
      spawnOutput?: string;
      prError?: Error;
      commitChanged?: boolean;
    } = {}
  ) {}
  async initDb() {}
  async reserveWorktree(input: ReserveWorktreeInput): Promise<Worktree> {
    // Mirror the vendored WorktreeService: a fresh, RANDOM-suffixed local branch
    // per attempt (so the PR head must come from the deterministic headBranch).
    this.reserveCalls += 1;
    this.reserveInputs.push(input);
    return {
      path: `/tmp/wt/${input.taskLabel}-${this.reserveCalls}`,
      branch: `tasca/local-${this.reserveCalls}`,
      repoPath: input.repoPath,
    };
  }
  spawnAgent(input: SpawnAgentInput): AgentProcessHandle {
    this.spawnCalls += 1;
    this.spawnInputs.push(input);
    return fakeHandle({
      ...(this.behavior.spawnExitCode !== undefined ? { exitCode: this.behavior.spawnExitCode } : {}),
      ...(this.behavior.spawnError !== undefined ? { error: this.behavior.spawnError } : {}),
      ...(this.behavior.spawnHang ? { hang: true } : {}),
      ...(this.behavior.spawnOutput !== undefined ? { output: this.behavior.spawnOutput } : {}),
    });
  }
  killAgent(id: string): void {
    this.killed.push(id);
  }
  async commitAgentWork(input: CommitAgentWorkInput): Promise<CommitAgentWorkResult> {
    this.commitCalls += 1;
    this.commitInputs.push(input);
    return { changed: this.behavior.commitChanged ?? true };
  }
  /** The `token` passed on the most recent openPr (for asserting auth threading). */
  lastOpenPrToken: string | undefined;
  /** The full input of the most recent openPr (for asserting cwd/branch threading). */
  lastOpenPrInput: OpenPrInput | undefined;
  async openPr(input: OpenPrInput): Promise<OpenPrResult> {
    this.prCalls += 1;
    this.lastOpenPrToken = input.token;
    this.lastOpenPrInput = input;
    if (this.behavior.prError) throw this.behavior.prError;
    // Model GitHub: one open PR per head branch. A repeated head returns the
    // existing PR (idempotent); a NEW head opens a new PR.
    const head = input.headBranch ?? input.branch;
    const existing = this.openedHeads.get(head);
    if (existing) return { url: existing };
    this.distinctPrs += 1;
    const url = `https://github.com/icemint/tasca/pull/${41 + this.distinctPrs}`;
    this.openedHeads.set(head, url);
    return { url };
  }
  async close() {}
}

class FakeStatus implements StatusReporter {
  updates: StatusUpdate[] = [];
  async postStatus(update: StatusUpdate) {
    this.updates.push(update);
  }
}

class FakeAudit implements AuditSink {
  records: Array<{ action: string; agentId: string }> = [];
  async record(input: { action: string; agentId: string }) {
    this.records.push({ action: input.action, agentId: input.agentId });
  }
}

const ELVIS = 'agent-elvis';
function elvisProfile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    agentId: ELVIS,
    maxTier: 'ultra',
    tiersCovered: ['basic', 'low', 'medium', 'hard', 'ultra'],
    languageSpecialties: ['typescript'],
    frameworkSpecialties: [],
    concurrencyLimit: 2,
    costCeiling: 100,
    successRate: 0.9,
    avgLatencyMs: 1000,
    ...overrides,
  };
}

class FakeDirectory implements AgentDirectory {
  // `names` maps agentId → display name. The real directory resolves a label by NAME (the roster
  // JOINs `agent` on lower(name)=lower($2)); the fake mirrors that — match by name, case-insensitive,
  // ONLY within the candidate (hired) set. CapabilityProfile carries no name, so the map supplies it.
  constructor(
    private readonly candidates: MatchCandidate[],
    private readonly names: Record<string, string> = {},
    // agentId → agent.md description (the standing persona). Absent ⇒ descriptionFor returns null.
    private readonly descriptions: Record<string, string> = {}
  ) {}
  async listCandidates() {
    return this.candidates;
  }
  async findHiredAgentByName(_orgId: string, name: string) {
    const lower = name.toLowerCase();
    for (const c of this.candidates) {
      const display = this.names[c.profile.agentId];
      if (display && display.toLowerCase() === lower) return c.profile.agentId;
    }
    return null;
  }
  async principalIdFor(agentId: string) {
    return `prn_${agentId}`;
  }
  async descriptionFor(agentId: string) {
    return this.descriptions[agentId] ?? null;
  }
}

const content: TaskContentSource = {
  async fetch() {
    return { title: 'Fix the thing', body: 'a short task' };
  },
};

const EVENT: AdapterEvent = {
  type: 'task.assigned',
  platform: 'shortcut',
  externalStoryId: 'sc-story-1',
  agentExternalId: 'sc-agent-elvis',
  repoHint: '/repos/demo',
};

function makeDeps(opts: {
  store: FakeStore;
  execution: FakeExecution;
  status: FakeStatus;
  audit: FakeAudit;
  candidates?: MatchCandidate[];
  content?: TaskContentSource;
  names?: Record<string, string>;
  descriptions?: Record<string, string>;
  classifierFor?: OrchestrationDeps['classifierFor'];
  agentVendorResolver?: OrchestrationDeps['agentVendorResolver'];
  startAgentProxy?: OrchestrationDeps['startAgentProxy'];
  emReviewGate?: OrchestrationDeps['emReviewGate'];
  emBlockExplainer?: OrchestrationDeps['emBlockExplainer'];
}): OrchestrationDeps {
  const candidates = opts.candidates ?? [{ profile: elvisProfile(), state: 'idle', activeCount: 0 }];
  return {
    store: opts.store,
    claim: new FakeClaimPort(opts.store),
    execution: opts.execution,
    status: opts.status,
    directory: new FakeDirectory(candidates, opts.names, opts.descriptions),
    audit: opts.audit,
    content: opts.content ?? content,
    ...(opts.classifierFor ? { classifierFor: opts.classifierFor } : {}),
    ...(opts.emReviewGate ? { emReviewGate: opts.emReviewGate } : {}),
    ...(opts.emBlockExplainer ? { emBlockExplainer: opts.emBlockExplainer } : {}),
    ...(opts.agentVendorResolver ? { agentVendorResolver: opts.agentVendorResolver } : {}),
    ...(opts.startAgentProxy ? { startAgentProxy: opts.startAgentProxy } : {}),
  };
}

/** A content source that also surfaces labels (slice 5d intake — `agent:<name>` override). */
function labeledContent(labels: string[]): TaskContentSource {
  return { async fetch() { return { title: 'Fix the thing', body: 'a short task', labels }; } };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('orchestrateTaskAssigned — happy path (§6 forward)', () => {
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
  });

  it('event → tier → match → CAS claim → dispatch → openPr → status-back, all persisted', async () => {
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit }));

    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.agentId).toBe(ELVIS);
    expect(outcome.prUrl).toBe('https://github.com/icemint/tasca/pull/42');

    // tier persisted (inspectable)
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.tierEstimate).not.toBeNull();
    expect(task.status).toBe('in_review');
    expect(task.claimedBy).toBe(ELVIS);

    // routing decision persisted with the winner
    expect(store.routingDecisions).toHaveLength(1);
    expect(store.routingDecisions[0]!.winnerAgentId).toBe(ELVIS);
    expect(store.routingDecisions[0]!.policy).toBe('rank'); // no manager → legacy rank path

    // execution + PR
    expect(execution.spawnCalls).toBe(1);
    // The agent is spawned with the REAL story content as a prompt (not a bare command).
    expect(execution.spawnInputs[0]!.prompt).toContain('Fix the thing');
    expect(execution.spawnInputs[0]!.prompt).toContain('a short task');
    expect(execution.spawnInputs[0]!.command).toBeUndefined();
    // The change was committed + verified before the PR.
    expect(execution.commitCalls).toBe(1);
    expect(execution.prCalls).toBe(1);
    expect(store.pullRequests).toEqual([{ taskId: outcome.taskId, url: outcome.prUrl }]);

    // status-back as Elvis: comment + state + PR link
    expect(status.updates).toHaveLength(1);
    expect(status.updates[0]).toMatchObject({
      platform: 'shortcut',
      agentId: ELVIS,
      externalStoryId: 'sc-story-1',
      state: 'in_review',
      prUrl: outcome.prUrl,
    });

    // audit recorded the privileged actions
    const actions = audit.records.map((r) => r.action);
    expect(actions).toContain('task.claim');
    expect(actions).toContain('pr.create');
    expect(actions).toContain('status.post');
  });

  it("threads the winner's agent.md description into the in-process spawn input (issue 362)", async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, descriptions: { [ELVIS]: 'You are Elvis, a careful reviewer.' } })
    );
    expect(outcome.kind).toBe('dispatched');
    // The persona rides the spawn input as appendSystemPrompt, ADDITIVE to the task prompt.
    expect(execution.spawnInputs[0]!.prompt).toContain('Fix the thing');
    expect(execution.spawnInputs[0]!.appendSystemPrompt).toBe('You are Elvis, a careful reviewer.');
  });

  it('sets no appendSystemPrompt on the spawn input when the agent has no description (issue 362)', async () => {
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit }));
    expect(outcome.kind).toBe('dispatched');
    expect(execution.spawnInputs[0]!.appendSystemPrompt).toBeUndefined();
  });

  it('persists the fetched content title onto the task (QA item 325)', async () => {
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit }));
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    // the store received the fetched title and it landed on the task row
    expect(store.titleWrites).toContainEqual({ taskId: outcome.taskId, title: 'Fix the thing' });
    expect(store.tasks.get(outcome.taskId)!.title).toBe('Fix the thing');
  });

  it('truncates an over-long title to the persisted bound, never rejecting it (QA item 325)', async () => {
    const longContent: TaskContentSource = {
      async fetch() {
        return { title: 'x'.repeat(500), body: 'a short task' };
      },
    };
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, content: longContent }));
    expect(outcome.kind).toBe('dispatched');
    expect(store.titleWrites[0]!.title).toHaveLength(300); // truncated, not rejected
  });

  it('a title-write failure is NON-FATAL — the run still dispatches, the failure is logged not propagated', async () => {
    store.setTaskTitleThrows = true;
    const logs: Array<{ msg: string }> = [];
    const logger = { error() {}, warn: (msg: string) => logs.push({ msg }) };
    const outcome = await orchestrateTaskAssigned(EVENT, {
      ...makeDeps({ store, execution, status, audit }),
      logger,
    });
    // the run completes end-to-end despite the title write throwing
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.prUrl).toBe('https://github.com/icemint/tasca/pull/42');
    // the failure was surfaced (warn), not swallowed
    expect(logs.some((l) => l.msg.includes('failed to persist task title'))).toBe(true);
  });

  it('NO-CHANGES run → retired to needs_attention WITHOUT the breaker (no re-route, no retry-burn)', async () => {
    const noChangeExec = new FakeExecution({ commitChanged: false }); // agent ran, committed nothing
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution: noChangeExec, status, audit }));

    expect(outcome.kind).toBe('no_changes');
    if (outcome.kind !== 'no_changes') return;
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.status).toBe('needs_attention'); // terminal, surfaced to a human
    expect(task.failureCount).toBe(0); // breaker NOT driven — re-running is pointless
    expect(store.noChangesCalls).toHaveLength(1); // went through the no-breaker terminal path
    expect(noChangeExec.prCalls).toBe(0); // never opened an empty PR
    // the failure/breaker path was NOT taken (it would have re-routed below threshold)
    expect(audit.records.map((r) => r.action)).toContain('task.no_changes');
  });

  it('NO-CHANGES but an operator moved the task mid-run → preempted, NO spurious no_changes audit', async () => {
    store.noChangesRetireActs = false; // the guarded retire no-ops (task already moved)
    const noChangeExec = new FakeExecution({ commitChanged: false });
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution: noChangeExec, status, audit }));

    expect(outcome.kind).toBe('preempted'); // defer — the operator owns the task's post-state
    expect(store.noChangesCalls).toHaveLength(1); // the retire WAS attempted...
    expect(audit.records.map((r) => r.action)).not.toContain('task.no_changes'); // ...but no audit for a no-op retire
  });

  it('threads the event platform onto the status update (github)', async () => {
    const githubEvent: AdapterEvent = {
      type: 'task.assigned',
      platform: 'github',
      externalStoryId: 'icemint/demo#42',
      agentExternalId: '5550001',
      repoHint: 'icemint/demo',
    };
    const outcome = await orchestrateTaskAssigned(
      githubEvent,
      makeDeps({ store, execution, status, audit })
    );
    expect(outcome.kind).toBe('dispatched');
    expect(status.updates[0]!.platform).toBe('github');
    // PROJECTION model (D8): the github PR carries `Closes #42` so a merge auto-closes the issue, and
    // the branch keeps the slug form (no sc-<id> token — that's Shortcut-only).
    expect(execution.lastOpenPrInput!.body).toBe('Closes #42');
    expect(execution.lastOpenPrInput!.headBranch).toMatch(/^tasca\/icemint-demo-42-[0-9a-f]{8}$/);
  });

  it('a SHORTCUT PR uses the Git Helper convention branch tasca/sc-<id>/<story-name> + a [sc-<id>] body', async () => {
    const shortcutEvent: AdapterEvent = { ...EVENT, externalStoryId: '123' }; // a real Shortcut story id is numeric
    const outcome = await orchestrateTaskAssigned(shortcutEvent, makeDeps({ store, execution, status, audit }));
    expect(outcome.kind).toBe('dispatched');
    // [owner]/sc-<id>/[story-name]: owner is a fixed 'tasca' (NOT the routing winner — it varies across
    // re-drives, which would break the deterministic head); sc-<id> is the link token + stable anchor;
    // the story name ('Fix the thing') is slugged. Plus the [sc-<id>] body; the move is the operator's
    // Shortcut Event Handler.
    expect(execution.lastOpenPrInput!.headBranch).toBe('tasca/sc-123/fix-the-thing');
    expect(execution.lastOpenPrInput!.body).toBe('[sc-123]');
  });

  it('the Shortcut branch story-name slug is GitHub-safe: lowercased, non-alnum collapsed to -, length-capped, no trailing -', async () => {
    const ev: AdapterEvent = { ...EVENT, externalStoryId: '88' };
    const longTitle = 'Add a ROT13 cipher utility!! (with spaces, símböls & a very very very very long tail that exceeds the cap)';
    const outcome = await orchestrateTaskAssigned(
      ev,
      makeDeps({ store, execution, status, audit, content: { async fetch() { return { title: longTitle, body: '' }; } } })
    );
    expect(outcome.kind).toBe('dispatched');
    const head = execution.lastOpenPrInput!.headBranch!;
    expect(head).toMatch(/^tasca\/sc-88\/[a-z0-9-]+$/); // only GitHub-safe chars, no '..' possible
    expect(head.startsWith('tasca/sc-88/add-a-rot13-cipher-utility')).toBe(true);
    const slug = head.split('/')[2]!;
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('a Shortcut story with an empty title → tasca/sc-<id>/task (never an empty trailing segment)', async () => {
    const ev: AdapterEvent = { ...EVENT, externalStoryId: '7' };
    const outcome = await orchestrateTaskAssigned(
      ev,
      makeDeps({ store, execution, status, audit, content: { async fetch() { return { title: '', body: '' }; } } })
    );
    expect(outcome.kind).toBe('dispatched');
    expect(execution.lastOpenPrInput!.headBranch).toBe('tasca/sc-7/task');
  });

  it('FAIL-CLOSED: a github event for an UNCONNECTED workspace → unconnected, no task, no agent run', async () => {
    store.connectionOrg = null; // the workspace has no platform_connection (install not bound)
    const githubEvent: AdapterEvent = {
      type: 'task.assigned',
      platform: 'github',
      externalStoryId: 'stranger/repo#1',
      agentExternalId: '5550001',
      repoHint: 'stranger/repo',
    };
    const outcome = await orchestrateTaskAssigned(githubEvent, makeDeps({ store, execution, status, audit }));
    expect(outcome.kind).toBe('unconnected'); // fail closed — NOT dispatched into the default org
    expect(store.tasks.size).toBe(0); // no task created
    expect(execution.spawnCalls).toBe(0); // no agent run
  });

  it('a SHORTCUT event for an unconnected workspace still resolves to the grandfather default (no connect flow yet)', async () => {
    store.connectionOrg = null;
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit }));
    expect(outcome.kind).toBe('dispatched'); // shortcut keeps the documented default, not fail-closed
  });

  it('empty roster (no agents hired) → no_roster, retired to needs_attention, decision persisted', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: [] })
    );
    expect(outcome.kind).toBe('no_roster');
    if (outcome.kind !== 'no_roster') return;
    expect(execution.spawnCalls).toBe(0);
    // Fail closed honestly: the task is retired to needs_attention with an explicit reason,
    // never crashed and never routed to a default agent.
    expect(store.retireCalls).toEqual([{ taskId: outcome.taskId, reason: 'no agents hired' }]);
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.status).toBe('needs_attention');
    expect(task.lastError).toBe('no agents hired');
    // The routing decision is still persisted (inspector sees a no-winner, empty-candidate attempt).
    expect(store.routingDecisions).toHaveLength(1);
    expect(store.routingDecisions[0]!.winnerAgentId).toBeNull();
  });

  it('agent busy (state not idle) → no_candidate', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution,
        status,
        audit,
        candidates: [{ profile: elvisProfile(), state: 'working', activeCount: 2 }],
      })
    );
    expect(outcome.kind).toBe('no_candidate');
    expect(execution.spawnCalls).toBe(0);
  });
});

describe('orchestrateTaskAssigned — assignment intake: agent:<name> label (§5d)', () => {
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
  });

  // Two hired candidates: elvis ranks higher (success 0.9), mona lower (success 0.6).
  const twoHired: MatchCandidate[] = [
    { profile: elvisProfile(), state: 'idle', activeCount: 0 },
    { profile: elvisProfile({ agentId: 'agent-mona', successRate: 0.6 }), state: 'idle', activeCount: 0 },
  ];
  // agentId → display NAME (labels resolve by name, like the real roster's JOIN on agent.name).
  const names = { 'agent-elvis': 'Elvis', 'agent-mona': 'Mona' };

  it('label naming a HIRED agent overrides the routing pick → dispatched to that agent', async () => {
    // Routing alone would pick elvis (higher score); the `agent:Mona` label (by NAME) overrides to mona.
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: twoHired, names, content: labeledContent(['agent:Mona']) })
    );
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.agentId).toBe('agent-mona');
    expect(store.routingDecisions[0]!.winnerAgentId).toBe('agent-mona');
    expect(store.retireCalls).toEqual([]); // a hired label is not a fail-close
  });

  it('label resolves the name case-insensitively within the hired set', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: twoHired, names, content: labeledContent(['agent:mONa']) })
    );
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.agentId).toBe('agent-mona');
  });

  it('label naming an UNHIRED agent fails closed → agent_not_hired, retired to needs_attention, no route', async () => {
    // 'Qwen' is NOT in the hired candidate set — the label must NOT bypass the boundary.
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: twoHired, names, content: labeledContent(['agent:Qwen']) })
    );
    expect(outcome.kind).toBe('agent_not_hired');
    if (outcome.kind !== 'agent_not_hired') return;
    expect(execution.spawnCalls).toBe(0); // never routed to an unhired agent
    expect(store.retireCalls).toEqual([{ taskId: outcome.taskId, reason: "requested agent 'Qwen' is not hired" }]);
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.status).toBe('needs_attention');
    expect(task.lastError).toBe("requested agent 'Qwen' is not hired");
    // The decision is persisted with no winner (an honest, inspectable unhired-label attempt).
    expect(store.routingDecisions).toHaveLength(1);
    expect(store.routingDecisions[0]!.winnerAgentId).toBeNull();
  });

  it('no label → routing-by-default picks the top eligible hired agent', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: twoHired })
    );
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.agentId).toBe(ELVIS); // the routing engine's top pick, no override
  });
});

describe('orchestrateTaskAssigned — preferred-agent routing (accepted PM proposal, W3-S1)', () => {
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
  });

  // Pre-seed the task (the row an accepted routing proposal would have set preferred_agent_id on),
  // so getOrCreateTask returns it with the preference. EVENT is platform 'shortcut' / story 'sc-story-1'.
  function seedPreferred(preferredAgentId: string | null): string {
    const id = randomUUID();
    store.tasks.set(id, {
      id,
      externalStoryId: 'sc-story-1',
      title: null,
      platform: 'shortcut',
      status: 'routable',
      version: 0,
      claimedBy: null,
      failureCount: 0,
      repoRef: '/repos/demo',
      tierEstimate: null,
      lastError: null,
      preferredAgentId,
      emCleared: false,
      emClarificationRound: 0,
    });
    return id;
  }

  const twoHired: MatchCandidate[] = [
    { profile: elvisProfile(), state: 'idle', activeCount: 0 }, // ELVIS ranks top (success 0.9)
    { profile: elvisProfile({ agentId: 'agent-mona', successRate: 0.6 }), state: 'idle', activeCount: 0 },
  ];

  it('a preference for a HIRED agent overrides the routing pick → dispatched to that agent', async () => {
    const taskId = seedPreferred('agent-mona'); // routing alone would pick ELVIS
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates: twoHired }));
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.taskId).toBe(taskId);
    expect(outcome.agentId).toBe('agent-mona');
    expect(store.routingDecisions[0]!.winnerAgentId).toBe('agent-mona');
    expect(store.retireCalls).toEqual([]); // a hired preference is not a fail-close
  });

  it('FAIL-CLOSED: a preference for an UNHIRED agent → agent_not_hired, retired, never routed elsewhere', async () => {
    const taskId = seedPreferred('agent-qwen'); // not in the hired candidate set
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates: twoHired }));
    expect(outcome.kind).toBe('agent_not_hired');
    if (outcome.kind !== 'agent_not_hired') return;
    expect(execution.spawnCalls).toBe(0); // never silently routed to ELVIS instead
    expect(store.retireCalls).toEqual([{ taskId, reason: "requested agent 'agent-qwen' is not hired" }]);
    expect(store.tasks.get(taskId)!.status).toBe('needs_attention');
  });

  it('the preference takes PRECEDENCE over an agent:<name> label', async () => {
    const taskId = seedPreferred('agent-mona');
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store, execution, status, audit, candidates: twoHired,
        names: { 'agent-elvis': 'Elvis', 'agent-mona': 'Mona' },
        content: { async fetch() { return { title: 't', body: 'b', labels: ['agent:Elvis'] }; } },
      })
    );
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.agentId).toBe('agent-mona'); // preference wins over the label
    void taskId;
  });
});

describe('orchestrateTaskAssigned — EM router pure decision logic (EM v1 slice 1, no DB)', () => {
  // The slice's pure routing logic (least-loaded pick, deterministic tie-break, busy-vs-gap split, the
  // per-AGENT and per-PROJECT gates) on the in-memory fake — no Postgres. The PG suite covers the same
  // paths against real SQL; this is the fresh-clone unit guard so a no-DB run exercises them.
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
    store.managerForProject = 'mgr_em'; // opt every project in this suite into an EM (router engages)
  });

  // A tier:medium label pins the estimate so eligibility is deterministic per agent maxTier (no classifier).
  const tierMedium: TaskContentSource = {
    async fetch() { return { title: 'Build it', body: 'task body', labels: ['tier:medium'] }; },
  };
  function profile(id: string, over: Partial<CapabilityProfile> = {}): CapabilityProfile {
    return { ...elvisProfile({ agentId: id }), ...over };
  }

  it('(a) dispatches to the LEAST-LOADED eligible agent', async () => {
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-busy'), state: 'idle', activeCount: 2 },
      { profile: profile('agent-idle'), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-idle');
    expect(store.routingDecisions[0]!.policy).toBe('em'); // #339: the EM router made the pick
  });

  it('(b) tie on active-count → higher successRate, then lower agent id', async () => {
    // All idle (active 0). 'agent-hi' has the higher successRate → wins regardless of order.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-lo', { successRate: 0.5 }), state: 'idle', activeCount: 0 },
      { profile: profile('agent-hi', { successRate: 0.95 }), state: 'idle', activeCount: 0 },
    ];
    const out1 = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(out1.kind === 'dispatched' && out1.agentId).toBe('agent-hi');

    // Tie on successRate too → lowest agent id wins (final deterministic tie-break).
    const store2 = new FakeStore();
    store2.managerForProject = 'mgr_em';
    const tie: MatchCandidate[] = [
      { profile: profile('agent-b', { successRate: 0.9 }), state: 'idle', activeCount: 0 },
      { profile: profile('agent-a', { successRate: 0.9 }), state: 'idle', activeCount: 0 },
    ];
    const out2 = await orchestrateTaskAssigned(EVENT, makeDeps({ store: store2, execution: new FakeExecution(), status: new FakeStatus(), audit: new FakeAudit(), candidates: tie, content: tierMedium }));
    expect(out2.kind === 'dispatched' && out2.agentId).toBe('agent-a');
  });

  it('(c) no tier-eligible agent → no_em_match (visible gap, not silent no_candidate)', async () => {
    // Both cap at basic; the task is medium → nobody reaches the tier.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-x', { maxTier: 'basic', tiersCovered: ['basic'] }), state: 'idle', activeCount: 0 },
      { profile: profile('agent-y', { maxTier: 'basic', tiersCovered: ['basic'] }), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind).toBe('no_em_match');
    if (outcome.kind !== 'no_em_match') return;
    expect(store.tasks.get(outcome.taskId)!.status).toBe('needs_attention');
  });

  it('(d) tier-eligible but all at per-AGENT capacity → no_em_capacity, left routable', async () => {
    // One eligible agent, concurrencyLimit 1 and already 1 active → at its per-agent limit. Transient busy,
    // not a gap: must NOT park (no_em_match) and must NOT silently no_candidate.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-full', { concurrencyLimit: 1 }), state: 'idle', activeCount: 1 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind).toBe('no_em_capacity');
    if (outcome.kind !== 'no_em_capacity') return;
    expect(store.tasks.get(outcome.taskId)!.status).not.toBe('needs_attention'); // left routable
  });

  it('(e) per-PROJECT at capacity (repo busy, agent has slots) → no_em_capacity, left routable', async () => {
    // The agent IS eligible and has per-agent headroom (limit 4, 0 active), but the REPO is at the
    // per-project limit (default 1). The per-PROJECT gate must fire — VISIBLE as no_em_capacity, routable.
    store.activeOnProject.set('/repos/demo', 1); // EVENT.repoHint resolves to repoRef '/repos/demo'
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-ok', { concurrencyLimit: 4 }), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind).toBe('no_em_capacity');
    if (outcome.kind !== 'no_em_capacity') return;
    expect(store.tasks.get(outcome.taskId)!.status).not.toBe('needs_attention'); // routable soft-wait
    expect(execution.spawnCalls).toBe(0); // no claim ran
  });

  it('(e2) per-project gate is per-REPO: a busy OTHER repo does not block this repo', async () => {
    store.activeOnProject.set('/repos/other', 5); // a different repo is saturated
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-ok', { concurrencyLimit: 4 }), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-ok');
  });

  it('(f) an explicit agent:<name> label OVERRIDES the EM (picks the named agent, not least-loaded)', async () => {
    const labelled: TaskContentSource = {
      async fetch() { return { title: 'Build it', body: 'task body', labels: ['tier:medium', 'agent:Busy'] }; },
    };
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-idle'), state: 'idle', activeCount: 0 }, // least-loaded — the EM would pick this
      { profile: profile('agent-busy'), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates, content: labelled, names: { 'agent-busy': 'Busy' } })
    );
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-busy'); // the label wins over the EM
    expect(store.routingDecisions[0]!.policy).toBe('rank'); // #339: an operator override is 'rank', not the EM's policy
  });

  it('(f2) an explicit preferredAgentId OVERRIDES the EM', async () => {
    const id = randomUUID();
    store.tasks.set(id, {
      id, externalStoryId: 'sc-story-1', title: null, platform: 'shortcut', status: 'routable', version: 0,
      claimedBy: null, failureCount: 0, repoRef: '/repos/demo', tierEstimate: null, lastError: null,
      preferredAgentId: 'agent-busy', emCleared: false, emClarificationRound: 0,
    });
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-idle'), state: 'idle', activeCount: 0 }, // the EM would pick this
      { profile: profile('agent-busy'), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-busy'); // the preference wins over the EM
    expect(store.routingDecisions[0]!.policy).toBe('rank'); // #339: an operator override is 'rank', not the EM's policy
  });

  it('(headroom) NON-EM project: a now-live activeCount headroom term shifts the legacy rank', async () => {
    // Finding #3 — making activeCount real makes match.ts headroom (1 - activeCount/concurrencyLimit) live.
    // OFF an EM project the legacy SCORE decides. A LOADED higher-successRate agent (lower headroom) loses
    // to an idle lower-successRate agent only because headroom is now real, not the old constant 1.0. Pins
    // the cross-cut: a future score-weight change that flips this must be intentional, not silent.
    store.managerForProject = null; // legacy path (no EM)
    // history*0.7 + headroom*0.3. Loaded: 0.9*0.7 + (1-3/4)*0.3 = 0.63 + 0.075 = 0.705.
    //                              Idle:  0.7*0.7 + 1*0.3       = 0.49 + 0.30  = 0.790 → idle wins.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-loaded', { successRate: 0.9, concurrencyLimit: 4 }), state: 'idle', activeCount: 3 },
      { profile: profile('agent-fresh', { successRate: 0.7, concurrencyLimit: 4 }), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-fresh'); // headroom tipped the legacy rank
  });

  // ── EM v1 slice 2: SPECIALTY filtering on the EM path ──────────────────────────────────────────────
  // The task title names a specialty ('React'); only an agent carrying it is EM-eligible. tier:medium pins
  // the tier so eligibility turns purely on the specialty (and capacity).
  const reactMedium: TaskContentSource = {
    async fetch() { return { title: 'Add a React component', body: 'task body', labels: ['tier:medium'] }; },
  };

  it('(g) a covered task routes to the COVERING agent (specialty filter engages on the EM path)', async () => {
    // 'agent-bare' is least-loaded but carries no react; 'agent-react' covers it. The specialty filter must
    // skip the least-loaded-but-unqualified agent and pick the covering one.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-bare', { frameworkSpecialties: [] }), state: 'idle', activeCount: 0 },
      { profile: profile('agent-react', { frameworkSpecialties: ['react'] }), state: 'idle', activeCount: 1 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: reactMedium }));
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-react');
  });

  it('(h) a specialty GAP → no_em_match with the specialty NAMED in the reason', () => {
    return (async () => {
      // Tier-OK agents exist but none carry react → a real gap (not transient). Park visibly; the reason
      // names the missing specialty so the operator knows what to hire/configure.
      const candidates: MatchCandidate[] = [
        { profile: profile('agent-x', { frameworkSpecialties: [] }), state: 'idle', activeCount: 0 },
      ];
      const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: reactMedium }));
      expect(outcome.kind).toBe('no_em_match');
      if (outcome.kind !== 'no_em_match') return;
      const parked = store.tasks.get(outcome.taskId)!;
      expect(parked.status).toBe('needs_attention');
      expect(parked.lastError).toContain('react'); // the specialty is NAMED in the no-fit reason
    })();
  });

  it('(i) a no-signal task routes tier-only (slice-1 behavior unchanged when there is no specialty signal)', async () => {
    // tierMedium's title ('Build it') derives no specialty → required = [] → passes all agents → the
    // least-loaded eligible wins exactly as slice 1 did.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-busy'), state: 'idle', activeCount: 2 },
      { profile: profile('agent-idle'), state: 'idle', activeCount: 0 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: tierMedium }));
    expect(outcome.kind === 'dispatched' && outcome.agentId).toBe('agent-idle');
  });

  it('(j) a COVERING-but-all-busy roster → no_em_capacity (routable), NOT a false no_em_match park', async () => {
    // The only react-covering agent is at its per-agent concurrency limit. That is transient capacity over
    // the COVERING subset, not a staffing gap — must leave the task routable, never park as no_em_match.
    const candidates: MatchCandidate[] = [
      { profile: profile('agent-react-full', { frameworkSpecialties: ['react'], concurrencyLimit: 1 }), state: 'idle', activeCount: 1 },
    ];
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, candidates, content: reactMedium }));
    expect(outcome.kind).toBe('no_em_capacity');
    if (outcome.kind !== 'no_em_capacity') return;
    expect(store.tasks.get(outcome.taskId)!.status).not.toBe('needs_attention'); // left routable
  });
});

describe('orchestrateTaskAssigned — usage context (W3-S4a)', () => {
  it('wraps the classifier call with the task usage context (org/task, source=classifier)', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const status = new FakeStatus();
    const audit = new FakeAudit();
    // The default content has no tier label → heuristic prior < 0.8 → estimateTier CALLS the classifier.
    let captured: ReturnType<typeof currentUsageContext>;
    const classifier = {
      async classify() {
        captured = currentUsageContext();
        return { tier: 'medium' as const, confidence: 0.9 };
      },
    };
    // BYOK (3.5-A.2a): the classifier is resolved per-org; the fake resolver returns it for any org.
    const classifierFor = async () => classifier;
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, classifierFor }));
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    // the classifier ran INSIDE the usage context → attributable to this task as source='classifier'
    expect(captured).toEqual({ orgId: 'org_default', taskId: outcome.taskId, source: 'classifier' });
  });

  it('BYOK: no org vault key → classifierFor returns null → heuristic routing (no classifier call)', async () => {
    const store = new FakeStore();
    // simulate "this org has no key": the resolver returns null, so no classifier is built
    const classifierFor = async () => null;
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution: new FakeExecution(), status: new FakeStatus(), audit: new FakeAudit(), classifierFor }));
    expect(outcome.kind).toBe('dispatched'); // still routes (heuristic), agents can still be matched
    const task = store.tasks.get((outcome as { taskId: string }).taskId)!;
    expect(task.tierEstimate?.classifierUsed).toBe(false); // degraded to the heuristic prior, no LLM call
  });
});

describe('orchestrateTaskAssigned — BYOK agent execution (3.5-A.2b)', () => {
  it('no org vault key → fail closed: needs_attention, NO agent spawn, no PR', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    let proxyStarted = false;
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution,
        status: new FakeStatus(),
        audit: new FakeAudit(),
        agentVendorResolver: async () => null, // this org has no Anthropic key
        startAgentProxy: async () => {
          proxyStarted = true;
          return { baseUrl: 'http://127.0.0.1:1', close: async () => {} };
        },
      })
    );
    expect(outcome.kind).toBe('no_agent_key');
    expect(proxyStarted).toBe(false); // never started a proxy for a keyless org
    expect(execution.spawnCalls).toBe(0); // and never spawned the agent
    expect(execution.prCalls).toBe(0);
    const task = store.tasks.get((outcome as { taskId: string }).taskId)!;
    expect(task.status).toBe('needs_attention');
    expect(task.lastError).toBe('no API key configured — ask an admin');
    expect(store.noChangesCalls).toHaveLength(1); // retired via the no-breaker terminal path
  });

  it('resolver THROWS (transient credential-store fault) → fail closed via the no-breaker terminal, NOT the breaker', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    let proxyStarted = false;
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution,
        status: new FakeStatus(),
        audit: new FakeAudit(),
        agentVendorResolver: async () => {
          throw new Error('pg read timeout'); // a transient vault/DB read fault, not a clean "no key"
        },
        startAgentProxy: async () => {
          proxyStarted = true;
          return { baseUrl: 'http://127.0.0.1:1', close: async () => {} };
        },
      })
    );
    expect(outcome.kind).toBe('key_unavailable'); // distinct from no_agent_key — the resolve itself failed
    expect(proxyStarted).toBe(false); // never started a proxy
    expect(execution.spawnCalls).toBe(0); // and never spawned the agent (fail-closed safety holds on a throw)
    const task = store.tasks.get((outcome as { taskId: string }).taskId)!;
    expect(task.status).toBe('needs_attention');
    expect(task.lastError).toBe('credential service unavailable — retry when restored');
    expect(store.noChangesCalls).toHaveLength(1); // routed to the no-breaker terminal...
    expect(task.failureCount).toBe(0); // ...NOT the breaker (no failure_count burn, no misleading task.failed)
  });

  it('key present → starts a per-task proxy with {apiKey, usageContext}, spawns with env.ANTHROPIC_BASE_URL, closes after the run, and meters the agent path', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const proxyCalls: Array<{ apiKey: string; usageContext: { orgId: string; taskId: string } }> = [];
    let closed = 0;
    // The per-task proxy fake also drives a usage record (what the real proxy's tee does) so the test
    // proves the agent path is metered through the baked {org,task} context.
    const startAgentProxy: OrchestrationDeps['startAgentProxy'] = async (opts) => {
      proxyCalls.push(opts);
      await store.recordUsage(opts.usageContext.orgId, {
        taskId: opts.usageContext.taskId,
        source: 'agent',
        model: 'claude-haiku-4-5',
        inputTokens: 10,
        outputTokens: 20,
        idempotencyKey: `msg_${opts.usageContext.taskId}`,
      });
      return { baseUrl: 'http://127.0.0.1:54321', close: async () => { closed += 1; } };
    };
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution,
        status: new FakeStatus(),
        audit: new FakeAudit(),
        agentVendorResolver: async () => 'sk-ant-ORG-KEY',
        startAgentProxy,
      })
    );
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    // The proxy was started once, baked with the resolved org key + the {org,task}.
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]!.apiKey).toBe('sk-ant-ORG-KEY');
    expect(proxyCalls[0]!.usageContext).toEqual({ orgId: 'org_default', taskId: outcome.taskId });
    // The agent was spawned pointed at the per-task proxy (ANTHROPIC_BASE_URL overlaid via input.env).
    expect(execution.spawnInputs).toHaveLength(1);
    expect(execution.spawnInputs[0]!.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:54321');
    // The proxy was torn down after the run.
    expect(closed).toBe(1);
    // The agent call was metered: a usage_event with source='agent', scoped to the baked org.
    const agentUsage = store.usageRecords.filter((r) => r.source === 'agent');
    expect(agentUsage).toHaveLength(1);
    expect(agentUsage[0]!.orgId).toBe('org_default');
    expect(agentUsage[0]!.idempotencyKey).toBe(`msg_${outcome.taskId}`);
  });

  it('closes the per-task proxy even when the agent run throws (finally semantics)', async () => {
    const store = new FakeStore();
    const failingExec = new FakeExecution({ spawnError: new Error('pty boom') });
    let closed = 0;
    await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution: failingExec,
        status: new FakeStatus(),
        audit: new FakeAudit(),
        agentVendorResolver: async () => 'sk-ant-ORG-KEY',
        startAgentProxy: async () => ({ baseUrl: 'http://127.0.0.1:9', close: async () => { closed += 1; } }),
      })
    );
    expect(closed).toBe(1); // the proxy is closed on the throw path, not leaked
  });
});

describe('orchestrateTaskAssigned — decomposition child (synthetic, W3-S1c)', () => {
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
  });

  // A synthetic child has NO platform story — content.fetch MUST NOT be the source. This content
  // source throws, so a dispatch can only succeed by using the STORED content (content precedence).
  const throwingContent: TaskContentSource = {
    async fetch() {
      throw new Error('a synthetic child has no platform story to fetch');
    },
  };

  function seedChild(): string {
    const id = randomUUID();
    store.tasks.set(id, {
      id, externalStoryId: 'sc-story-1', title: null, platform: 'shortcut', status: 'routable', version: 0,
      claimedBy: null, failureCount: 0, repoRef: '/repos/demo', tierEstimate: null, lastError: null, preferredAgentId: null,
      emCleared: false, emClarificationRound: 0,
    });
    store.origins.set(id, {
      content: { title: 'Subtask: schema migration', body: 'add the tables' },
      parentTaskId: 'parent-x',
      parentExternalStoryId: 'sc-parent',
    });
    return id;
  }

  it('routes + executes from STORED content (never the platform), and posts status to the PARENT story', async () => {
    const taskId = seedChild();
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, content: throwingContent })
    );
    expect(outcome.kind).toBe('dispatched'); // succeeded → it used the stored content, not the throwing fetch
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.taskId).toBe(taskId);
    // the agent ran on the child's stored content
    expect(execution.spawnInputs[0]!.prompt).toContain('schema migration');
    expect(execution.spawnInputs[0]!.prompt).toContain('add the tables');
    // STATUS-TO-PARENT: the child's status posts to the PARENT story, not its own synthetic id
    expect(status.updates).toHaveLength(1);
    expect(status.updates[0]!.externalStoryId).toBe('sc-parent');
    expect(status.updates[0]!.comment).toContain('Subtask');
  });
});

describe('orchestrateTaskAssigned — failure path → auto-recover → breaker (§6.14)', () => {
  it('first failure (below threshold) → task RESET to routable, claim cleared, for re-drive', async () => {
    const store = new FakeStore();
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution: new FakeExecution({ spawnExitCode: 1 }),
        status: new FakeStatus(),
        audit: new FakeAudit(),
      })
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.failureCount).toBe(1);
    // Must be re-claimable: routable + claim cleared (the CAS only claims routable
    // rows, so leaving it 'failed'/claimed would strand the documented retry).
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.status).toBe('routable');
    expect(task.claimedBy).toBeNull();
  });

  it('re-driving the SAME story on failure accumulates failures until the breaker trips at N=2', async () => {
    // The real auto-recover loop: same store + same event delivered twice. First
    // failure resets the task to routable (fc=1); the second delivery get-or-creates
    // the SAME task, re-wins the CAS, fails again (fc=2) → breaker → needs_attention.
    const store = new FakeStore();
    const first = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: new FakeExecution({ spawnExitCode: 1 }), status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed') return;
    expect(first.failureCount).toBe(1);

    const second = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: new FakeExecution({ spawnExitCode: 2 }), status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(second.kind).toBe('needs_attention');
    if (second.kind !== 'needs_attention') return;
    // Same task row was re-driven — one task total, count accumulated to the threshold.
    expect(store.tasks.size).toBe(1);
    expect(second.taskId).toBe(first.taskId);
    expect(second.failureCount).toBe(2);
    expect(store.tasks.get(second.taskId)!.status).toBe('needs_attention');
  });

  it('a PR-open failure also feeds the breaker (spawn ok, PR throws) → reset for retry', async () => {
    const store = new FakeStore();
    const exec = new FakeExecution({ spawnExitCode: 0, prError: new Error('gh failed') });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: exec, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(exec.spawnCalls).toBe(1);
    expect(outcome.kind).toBe('failed');
    expect(store.tasks.get((outcome as { taskId: string }).taskId)!.status).toBe('routable');
  });

  it('agent run with NO committed change → no_changes (terminal, no breaker), and openPr is NOT called (no empty PR)', async () => {
    const store = new FakeStore();
    const exec = new FakeExecution({ spawnExitCode: 0, commitChanged: false });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: exec, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(exec.spawnCalls).toBe(1);
    expect(exec.commitCalls).toBe(1);
    // No diff → terminal no-changes BEFORE openPr; no PR opened, no PR recorded.
    expect(exec.prCalls).toBe(0);
    expect(outcome.kind).toBe('no_changes');
    expect(store.pullRequests).toHaveLength(0);
    // Terminal needs_attention (NOT re-routed to routable) — a deterministic no-op shouldn't retry.
    expect(store.tasks.get((outcome as { taskId: string }).taskId)!.status).toBe('needs_attention');
    expect(store.tasks.get((outcome as { taskId: string }).taskId)!.failureCount).toBe(0); // breaker untouched
  });

  it('a PRE-claim failure (content fetch throws) also feeds the breaker — not just execution failures', async () => {
    // Regression: the breaker must cover the whole forward path. A persistent
    // pre-claim failure (broken content source / throwing classifier) must be
    // counted and escalate, not strand the task at routable forever.
    const store = new FakeStore();
    const exec = new FakeExecution();
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution: exec, status: new FakeStatus(), audit: new FakeAudit() }),
      content: { async fetch() { throw new Error('content source down'); } },
    };
    const outcome = await orchestrateTaskAssigned(EVENT, deps);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.failureCount).toBe(1);
    // Counted + reset for retry, and we never reached dispatch or recorded a decision.
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.status).toBe('routable');
    expect(exec.spawnCalls).toBe(0);
    expect(store.routingDecisions).toHaveLength(0);

    // A second persistent pre-claim failure trips the breaker → needs_attention.
    const second = await orchestrateTaskAssigned(EVENT, deps);
    expect(second.kind).toBe('needs_attention');
  });

  it('re-delivery of a non-routable task is a no-op (not_routable) — no tier work, no decision, no dispatch', async () => {
    const store = new FakeStore();
    // Drive the story to needs_attention (two execution failures).
    await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution: new FakeExecution({ spawnExitCode: 1 }), status: new FakeStatus(), audit: new FakeAudit() }));
    const escalated = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution: new FakeExecution({ spawnExitCode: 1 }), status: new FakeStatus(), audit: new FakeAudit() }));
    expect(escalated.kind).toBe('needs_attention');
    const decisionsBefore = store.routingDecisions.length;

    const exec = new FakeExecution();
    const third = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution: exec, status: new FakeStatus(), audit: new FakeAudit() }));
    expect(third.kind).toBe('not_routable');
    if (third.kind === 'not_routable') expect(third.status).toBe('needs_attention');
    expect(store.routingDecisions.length).toBe(decisionsBefore); // no spurious decision
    expect(exec.spawnCalls).toBe(0);
  });
});

describe('orchestrateTaskAssigned — lost claim (race loser)', () => {
  it('returns lost_claim and does not dispatch when the CAS loses', async () => {
    const store = new FakeStore();
    const losingClaim: ClaimPort = { async tryClaim() { return { won: false, newVersion: null }; } };
    const execution = new FakeExecution();
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() }),
      claim: losingClaim,
    };
    const outcome = await orchestrateTaskAssigned(EVENT, deps);
    expect(outcome.kind).toBe('lost_claim');
    expect(execution.spawnCalls).toBe(0);
  });
});

describe('orchestrateTaskAssigned — duplicate-PR guard (#198)', () => {
  it('does NOT re-run the agent or open a second PR when a PR is already recorded', async () => {
    // Simulate a re-drive: the task is routable again (a prior attempt was reset
    // for retry) but it ALREADY has a recorded PR from that prior attempt.
    const store = new FakeStore();
    const seeded = await store.getOrCreateTask('org_default', {
      externalStoryId: EVENT.externalStoryId,
      platform: 'shortcut',
      repoRef: '/repos/demo',
    });
    await store.recordPullRequest('org_default', { taskId: seeded.id, url: 'https://github.com/icemint/tasca/pull/7' });

    const execution = new FakeExecution();
    const status = new FakeStatus();
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit: new FakeAudit() }));

    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;
    expect(outcome.taskId).toBe(seeded.id);
    expect(outcome.prUrl).toBe('https://github.com/icemint/tasca/pull/7'); // the EXISTING PR
    // The guard skipped dispatch: no agent re-run, no second PR.
    expect(execution.spawnCalls).toBe(0);
    expect(execution.prCalls).toBe(0);
    expect(store.pullRequests).toHaveLength(1);
    // Finalize ran best-effort against the existing PR (status-back attempted once).
    expect(status.updates).toHaveLength(1);
  });

  it('re-drive after a recordPullRequest failure reuses the deterministic head — no second PR', async () => {
    // The residual window: openPr succeeds (PR on GitHub) but recordPullRequest
    // fails before the row lands → catch → failure reset → routable. On re-delivery
    // the pre-dispatch guard sees no recorded PR, so it re-dispatches: a DIFFERENT
    // local worktree branch, but the SAME deterministic head → openPr is recognized
    // as the existing PR rather than opening a second one on the customer repo.
    const store = new FakeStore();
    store.failRecordOnce = true;
    const execution = new FakeExecution();

    const first = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(first.kind).toBe('failed'); // recordPullRequest threw → reset for retry

    const second = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(second.kind).toBe('dispatched');
    expect(execution.reserveCalls).toBe(2); // two attempts, different local branches
    expect(execution.distinctPrs).toBe(1); // but only ONE real PR — the duplicate is prevented
    expect(store.pullRequests).toHaveLength(1); // recorded on the second attempt
  });

  it('a finalize-step failure after the PR is recorded does NOT re-drive (no duplicate PR)', async () => {
    // status-back (a finalize step) throws AFTER recordPullRequest. The PR is the
    // deliverable — a finalize failure must be swallowed, not drive the failure reset,
    // which would re-run the agent and open a second PR.
    const store = new FakeStore();
    const execution = new FakeExecution();
    const throwingStatus: StatusReporter = {
      async postStatus() {
        throw new Error('status-back transport blip');
      },
    };
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      { ...makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() }), status: throwingStatus }
    );

    expect(outcome.kind).toBe('dispatched'); // NOT failed — the PR stands
    const task = store.tasks.get((outcome as { taskId: string }).taskId)!;
    expect(task.status).not.toBe('routable'); // not reset → won't be re-driven
    expect(execution.prCalls).toBe(1); // exactly one PR opened
    expect(store.pullRequests).toHaveLength(1);
  });
});

describe('orchestrateTaskAssigned — clone-on-dispatch provisioner', () => {
  // A github event's repoHint is an `owner/repo` slug, not a local path.
  const GITHUB_EVENT: AdapterEvent = {
    type: 'task.assigned',
    platform: 'github',
    externalStoryId: 'gh-story-1',
    agentExternalId: 'sc-agent-elvis',
    repoHint: 'acme/widgets',
  };

  it('provisions the slug, then the PROVISIONER creates the worktree (NOT reserveWorktree)', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const ensured: string[] = [];
    const worktreeArgs: Array<{ repoRef: string; taskLabel: string }> = [];
    const removed: Array<{ repoRef: string; path: string; branch: string }> = [];
    const provisioner: RepoProvisioner = {
      async ensureLocalRepo(repoRef) {
        ensured.push(repoRef);
        return { path: '/local/checkout', defaultBranch: 'trunk' };
      },
      async createWorktree(repoRef, taskLabel) {
        worktreeArgs.push({ repoRef, taskLabel });
        return { path: '/wt', branch: 'tasca-wt/x', baseRef: 'origin/trunk' };
      },
      async tokenForRepo() {
        return 'ghs_install_token';
      },
      async removeWorktree(repoRef, path, branch) {
        removed.push({ repoRef, path, branch });
      },
    };
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() }),
      provisioner,
    };

    const outcome = await orchestrateTaskAssigned(GITHUB_EVENT, deps);

    expect(outcome.kind).toBe('dispatched');
    // (a) the local clone was ensured, then the worktree created — both with the slug.
    expect(ensured).toEqual(['acme/widgets']);
    expect(worktreeArgs).toEqual([{ repoRef: 'acme/widgets', taskLabel: 'gh-story-1' }]);
    // (b) ExecutionPort.reserveWorktree is BYPASSED on the provisioner path (the
    //     vendored worktree path would fetch/push against the now-tokenless origin).
    expect(execution.reserveCalls).toBe(0);
    // (c) the agent ran in, and the PR was opened from, the provisioner's worktree.
    expect(execution.spawnInputs[0]!.cwd).toBe('/wt');
    expect(execution.commitInputs[0]).toMatchObject({ cwd: '/wt', baseRef: 'origin/trunk' });
    // (d) openPr used the provisioner worktree path + branch + the installation token.
    expect(execution.lastOpenPrInput).toMatchObject({
      cwd: '/wt',
      branch: 'tasca-wt/x',
      token: 'ghs_install_token',
    });
    // (e) the provisioner's worktree is reclaimed after the dispatch terminates, so
    //     dispatches/re-drives don't leak worktrees + branches under reposDir.
    expect(removed).toEqual([{ repoRef: 'acme/widgets', path: '/wt', branch: 'tasca-wt/x' }]);
  });

  it('a provisioning failure feeds the breaker (failed → needs_attention)', async () => {
    const store = new FakeStore();
    const failing: RepoProvisioner = {
      async ensureLocalRepo() {
        throw new Error('no GitHub App installation for owner acme');
      },
      async createWorktree() {
        throw new Error('no GitHub App installation for owner acme');
      },
      async tokenForRepo() {
        throw new Error('no GitHub App installation for owner acme');
      },
      async removeWorktree() {
        // never reached — ensureLocalRepo throws before a worktree exists
      },
    };
    const deps = () => ({
      ...makeDeps({ store, execution: new FakeExecution(), status: new FakeStatus(), audit: new FakeAudit() }),
      provisioner: failing,
    });

    const first = await orchestrateTaskAssigned(GITHUB_EVENT, deps());
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed') return;
    expect(first.failureCount).toBe(1);
    expect(store.tasks.get(first.taskId)!.status).toBe('routable'); // reset for retry

    const second = await orchestrateTaskAssigned(GITHUB_EVENT, deps());
    expect(second.kind).toBe('needs_attention');
  });

  it('no provisioner + an event WITHOUT repoHint → repoPath defaults to "."', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const noRepoEvent: AdapterEvent = {
      type: 'task.assigned',
      platform: 'shortcut',
      externalStoryId: 'sc-no-repo',
      agentExternalId: 'sc-agent-elvis',
    };

    const outcome = await orchestrateTaskAssigned(
      noRepoEvent,
      makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() })
    );

    expect(outcome.kind).toBe('dispatched');
    expect(execution.reserveInputs[0]!.repoPath).toBe('.');
  });
});

// The split-dispatch safety net: when a queue is wired, coordination ENQUEUES the job
// for an agent-runner and falls back to IN-PROCESS if no runner claims it in time. A
// runner outage must never silently stall a task.
describe('orchestrateTaskAssigned — split dispatch + in-process fallback', () => {
  const GITHUB_EVENT: AdapterEvent = {
    type: 'task.assigned',
    platform: 'github',
    externalStoryId: 'gh-split-1',
    agentExternalId: 'sc-agent-elvis',
    repoHint: 'acme/widgets',
  };

  // The runner-wait path polls jobStatus() to detect a claim, then uses cancel() as the
  // race-safe hinge at timeout. `status` drives the poll outcome; cancelResult drives the
  // timeout hinge (true = "still queued, we cancel" → no_capacity; false = "a runner took it").
  class FakeDispatchQueue implements DispatchQueue {
    enqueued: DispatchJobInput[] = [];
    status = 'queued';
    cancelled: string[] = [];
    constructor(private readonly cancelResult: boolean) {}
    async enqueue(input: DispatchJobInput): Promise<{ id: string }> {
      this.enqueued.push(input);
      return { id: `job-${this.enqueued.length}` };
    }
    async cancel(id: string): Promise<boolean> {
      this.cancelled.push(id);
      return this.cancelResult;
    }
    async jobStatus(): Promise<string | null> {
      return this.status;
    }
    async claimNext(): Promise<DispatchJob | null> {
      return null;
    }
    async renewLease(): Promise<boolean> {
      return true;
    }
    async complete(): Promise<boolean> {
      return true;
    }
    async release(): Promise<boolean> {
      return true;
    }
    async fail(): Promise<boolean> {
      return true;
    }
    async reclaimExpired(): Promise<number> {
      return 0;
    }
    async sweepExpired(): Promise<{ reclaimed: number; failedOver: number }> {
      return { reclaimed: 0, failedOver: 0 };
    }
    async claimFinished(): Promise<never[]> {
      return [];
    }
    async markReaped(): Promise<void> {}
    async beginPublish(): Promise<boolean> {
      return true;
    }
    async requestCancel(): Promise<'removed' | 'signalled' | 'too_late'> {
      return 'too_late';
    }
    async requestCancelForTask(): Promise<'removed' | 'signalled' | 'too_late' | 'no_job'> {
      return 'no_job';
    }
  }

  const passingProvisioner: RepoProvisioner = {
    async ensureLocalRepo() {
      return { path: '/local/checkout', defaultBranch: 'trunk' };
    },
    async createWorktree() {
      return { path: '/wt', branch: 'tasca-wt/x', baseRef: 'origin/trunk' };
    },
    async tokenForRepo() {
      return 'ghs_tok';
    },
    async removeWorktree() {},
  };

  const queueDeps = (
    store: FakeStore,
    execution: FakeExecution,
    queue: FakeDispatchQueue,
    emBlockExplainer?: OrchestrationDeps['emBlockExplainer'],
    descriptions?: Record<string, string>
  ): OrchestrationDeps => ({
    ...makeDeps({
      store,
      execution,
      status: new FakeStatus(),
      audit: new FakeAudit(),
      ...(emBlockExplainer ? { emBlockExplainer } : {}),
      ...(descriptions ? { descriptions } : {}),
    }),
    provisioner: passingProvisioner,
    dispatchQueue: queue,
    runnerWaitMs: 5, // tiny bound so the no-claim timeout fires fast
    runnerPollMs: 1,
  });

  it('NO RUNNER claims within the bound → task retired to needs_attention (no execution capacity), NEVER in-process', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const queue = new FakeDispatchQueue(true); // cancel succeeds at timeout = nobody claimed it
    // queue.status stays 'queued' → the poll times out.
    const blockCalls: string[] = [];
    const emBlockExplainer: OrchestrationDeps['emBlockExplainer'] = async (_org, _task, _content, rawReason) => {
      blockCalls.push(rawReason);
    };

    const outcome = await orchestrateTaskAssigned(GITHUB_EVENT, queueDeps(store, execution, queue, emBlockExplainer));

    expect(queue.enqueued).toHaveLength(1); // it WAS enqueued for a runner
    expect(execution.spawnInputs).toHaveLength(0); // the hardened boundary HELD — no in-process run
    expect(queue.cancelled).toHaveLength(1); // the queued job was cancelled
    expect(store.noCapacityCalls).toHaveLength(1); // → needs_attention with a reason
    expect(store.noCapacityCalls[0]!.reason).toContain('no execution capacity');
    expect(outcome.kind).toBe('no_capacity');
    // EM v1 slice 4: the explainer was handed the raw no-capacity reason (best-effort, outcome unchanged).
    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0]).toContain('no execution capacity');
  });

  it('a runner CLAIMS the job (poll sees it leave the queue) → dispatched, no in-process run', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const queue = new FakeDispatchQueue(false);
    queue.status = 'claimed'; // a runner took it

    const outcome = await orchestrateTaskAssigned(GITHUB_EVENT, queueDeps(store, execution, queue));

    expect(queue.enqueued).toHaveLength(1);
    expect(execution.spawnInputs).toHaveLength(0); // the runner owns it; nothing ran in-process
    expect(queue.cancelled).toHaveLength(0); // never reached the cancel hinge (claimed during poll)
    expect(store.noCapacityCalls).toHaveLength(0);
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind === 'dispatched') expect(outcome.prUrl).toBe('(runner)');
  });

  it("puts the winner's agent.md description on the enqueued DispatchPayload as appendSystemPrompt (issue 362)", async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const queue = new FakeDispatchQueue(false);
    queue.status = 'claimed';

    await orchestrateTaskAssigned(
      GITHUB_EVENT,
      queueDeps(store, execution, queue, undefined, { [ELVIS]: 'You are Elvis, a careful reviewer.' })
    );

    expect(queue.enqueued).toHaveLength(1);
    const payload = queue.enqueued[0]!.payload as { prompt: string; appendSystemPrompt?: string };
    // ADDITIVE: the task prompt is still there AND the persona rides alongside it.
    expect(payload.prompt).toContain('Implement the task');
    expect(payload.appendSystemPrompt).toBe('You are Elvis, a careful reviewer.');
  });

  it('omits appendSystemPrompt from the enqueued DispatchPayload when the agent has no description (issue 362)', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const queue = new FakeDispatchQueue(false);
    queue.status = 'claimed';

    await orchestrateTaskAssigned(GITHUB_EVENT, queueDeps(store, execution, queue));

    expect(queue.enqueued).toHaveLength(1);
    const payload = queue.enqueued[0]!.payload as { appendSystemPrompt?: string };
    expect(payload.appendSystemPrompt).toBeUndefined();
  });

  it('an operator cancel/reassign flips the job to cancelled mid-wait → preempted (task untouched by orchestration)', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const queue = new FakeDispatchQueue(false);
    queue.status = 'cancelled'; // operator interrupt/reassign during the wait

    const outcome = await orchestrateTaskAssigned(GITHUB_EVENT, queueDeps(store, execution, queue));

    expect(execution.spawnInputs).toHaveLength(0);
    expect(store.noCapacityCalls).toHaveLength(0); // orchestration does NOT fight the canceller
    expect(outcome.kind).toBe('preempted');
  });
});

describe('orchestrateTaskAssigned — failure observability', () => {
  it('logs "dispatch failed" with the failing stage + error message (ExecutionError → stage)', async () => {
    const store = new FakeStore();
    const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      error: (message: string, context?: Record<string, unknown>) => lines.push({ message, ...(context ? { context } : {}) }),
      info: () => {},
    };
    // Fail at the worktree stage with a typed ExecutionError (post-claim).
    const failingExecution: ExecutionPort = {
      async initDb() {},
      async reserveWorktree() {
        throw new ExecutionError('worktree', 'reserveWorktree failed: git worktree add exploded');
      },
      spawnAgent() {
        throw new Error('unreached');
      },
      killAgent() {},
      async openPr(): Promise<OpenPrResult> {
        return { url: 'unreached' };
      },
      async commitAgentWork(): Promise<CommitAgentWorkResult> {
        return { changed: true };
      },
      async close() {},
    };
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution: new FakeExecution(), status: new FakeStatus(), audit: new FakeAudit() }),
      execution: failingExecution, // OrchestrationDeps.execution is ExecutionPort
      logger,
    };

    const outcome = await orchestrateTaskAssigned(EVENT, deps);
    expect(outcome.kind).toBe('failed');

    const failLog = lines.find((l) => l.message === 'coordination: dispatch failed');
    expect(failLog, 'a dispatch-failed log line should be emitted').toBeDefined();
    expect(failLog!.context).toMatchObject({ stage: 'worktree', taskId: outcome.taskId });
    expect(String(failLog!.context!.error)).toMatch(/git worktree add exploded/);
  });
});

describe('orchestrateTaskAssigned — agent run robustness', () => {
  it('treats a benign EIO PTY-teardown error as success (proceeds to commit + PR)', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution({
      spawnError: Object.assign(new Error('pty teardown'), { code: 'EIO' }),
    });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(outcome.kind).toBe('dispatched');
    expect(execution.prCalls).toBe(1);
  });

  it('a non-EIO spawn error fails the dispatch (breaker), no PR', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution({
      spawnError: Object.assign(new Error('spawn boom'), { code: 'ENOENT' }),
    });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(outcome.kind).toBe('failed');
    expect(execution.prCalls).toBe(0);
  });

  it('kills a hung agent after the timeout and fails the dispatch (no stranded task, no PR)', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution({ spawnHang: true });
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() }),
      agentTimeoutMs: 20,
    };
    const outcome = await orchestrateTaskAssigned(EVENT, deps);
    expect(outcome.kind).toBe('failed');
    expect(execution.killed.length).toBeGreaterThan(0); // reaped via killAgent
    expect(execution.prCalls).toBe(0);
  });
});

describe('orchestrateTaskAssigned — agent output observability', () => {
  it('captures the agent output tail + exit code and logs it (so a no-diff run is diagnosable)', async () => {
    const store = new FakeStore();
    const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      error: () => {},
      info: (message: string, context?: Record<string, unknown>) =>
        lines.push({ message, ...(context ? { context } : {}) }),
    };
    // Agent ran (exit 0) + said something, but produced no diff → no-changes.
    const execution = new FakeExecution({
      spawnOutput: 'I inspected README.md and found no typo in the heading.',
      commitChanged: false,
    });
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() }),
      logger,
    };

    const outcome = await orchestrateTaskAssigned(EVENT, deps);

    expect(outcome.kind).toBe('no_changes'); // the no-changes guard fired → terminal (no breaker)
    const runLog = lines.find((l) => l.message === 'coordination: agent run complete');
    expect(runLog, 'the agent run output should be logged before the no-changes retire').toBeDefined();
    expect(runLog!.context).toMatchObject({ exitCode: 0 });
    expect(String(runLog!.context!.outputTail)).toContain('no typo');
  });
});

describe('orchestrateTaskAssigned — EM requirements gate (EM v1 slice 2)', () => {
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
  });

  it('CLEAR → marks the task em_cleared and proceeds to dispatch', async () => {
    const calls: Array<{ taskId: string }> = [];
    const emReviewGate: OrchestrationDeps['emReviewGate'] = async (_org, task) => {
      calls.push({ taskId: task.id });
      return { clear: true };
    };
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, emReviewGate }));
    // proceeds the whole forward path (dispatched), having run the gate once and cleared the task
    expect(outcome.kind).toBe('dispatched');
    expect(calls).toHaveLength(1);
    const t = [...store.tasks.values()][0]!;
    expect(t.emCleared).toBe(true);
    expect(store.emClearedCalls).toContain(t.id);
  });

  it('UNCLEAR (first round) → parks the task at awaiting_clarification and bumps the round', async () => {
    const emReviewGate: OrchestrationDeps['emReviewGate'] = async () => ({ clear: false });
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, emReviewGate }));
    expect(outcome.kind).toBe('awaiting_clarification');
    const t = [...store.tasks.values()][0]!;
    expect(t.status).toBe('awaiting_clarification');
    expect(t.emClarificationRound).toBe(1); // 0 → 1
    expect(store.parkCalls).toEqual([{ taskId: t.id, round: 1 }]);
    // no dispatch happened
    expect(execution.spawnCalls).toBe(0);
    expect(store.emClearedCalls).toHaveLength(0);
  });

  it('UNCLEAR at the loop-cap → retires to needs_attention (no further parking)', async () => {
    // Seed a task already at round = CAP-1 (2): the next unclear verdict hits round 3 = the cap.
    const id = randomUUID();
    store.tasks.set(id, {
      id, externalStoryId: 'sc-story-1', title: null, platform: 'shortcut', status: 'routable', version: 0,
      claimedBy: null, failureCount: 0, repoRef: '/repos/demo', tierEstimate: null, lastError: null,
      preferredAgentId: null, emCleared: false, emClarificationRound: 2,
    });
    const emReviewGate: OrchestrationDeps['emReviewGate'] = async () => ({ clear: false });
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, emReviewGate }));
    expect(outcome.kind).toBe('needs_clarification_capped');
    const t = store.tasks.get(id)!;
    expect(t.status).toBe('needs_attention');
    expect(store.parkCalls).toHaveLength(0); // it did NOT park — it escalated
    expect(store.retireCalls[0]!.reason).toMatch(/still unclear after 3/i);
  });

  it('em_cleared task → the gate is SKIPPED on a re-drive (proceeds straight to dispatch)', async () => {
    const id = randomUUID();
    store.tasks.set(id, {
      id, externalStoryId: 'sc-story-1', title: null, platform: 'shortcut', status: 'routable', version: 0,
      claimedBy: null, failureCount: 0, repoRef: '/repos/demo', tierEstimate: null, lastError: null,
      preferredAgentId: null, emCleared: true, emClarificationRound: 0,
    });
    let gateRan = false;
    const emReviewGate: OrchestrationDeps['emReviewGate'] = async () => { gateRan = true; return { clear: false }; };
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit, emReviewGate }));
    expect(gateRan).toBe(false); // already cleared → gate not invoked
    expect(outcome.kind).toBe('dispatched');
  });

  it('no emReviewGate wired (EM disabled) → orchestration proceeds normally', async () => {
    const outcome = await orchestrateTaskAssigned(EVENT, makeDeps({ store, execution, status, audit }));
    expect(outcome.kind).toBe('dispatched');
    // the task is not touched by any EM bookkeeping
    const t = [...store.tasks.values()][0]!;
    expect(t.emCleared).toBe(false);
    expect(store.parkCalls).toHaveLength(0);
    expect(store.emClearedCalls).toHaveLength(0);
  });
});

// EM v1 slice 4 — the block-explanation post-step. When a task is retired to a blocked state with a RAW
// reason, the wired explainer is invoked best-effort with that reason; the retire semantics + the returned
// outcome are unchanged. The already-human EM-cap retire must NOT trigger it.
describe('orchestrateTaskAssigned — EM block-explanation (EM v1 slice 4)', () => {
  let store: FakeStore;
  let execution: FakeExecution;
  let status: FakeStatus;
  let audit: FakeAudit;
  /** A recording explainer that captures every (task, rawReason) it was handed. */
  let calls: Array<{ taskId: string; title: string; rawReason: string }>;
  let emBlockExplainer: OrchestrationDeps['emBlockExplainer'];
  beforeEach(() => {
    store = new FakeStore();
    execution = new FakeExecution();
    status = new FakeStatus();
    audit = new FakeAudit();
    calls = [];
    emBlockExplainer = async (_org, task, content, rawReason) => {
      calls.push({ taskId: task.id, title: content.title, rawReason });
    };
  });

  it('no_roster retire → SAME needs_attention outcome AND the explainer is invoked with the raw reason', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: [], emBlockExplainer })
    );
    // The block itself is unchanged.
    expect(outcome.kind).toBe('no_roster');
    if (outcome.kind !== 'no_roster') return;
    const task = store.tasks.get(outcome.taskId)!;
    expect(task.status).toBe('needs_attention');
    expect(store.retireCalls).toEqual([{ taskId: outcome.taskId, reason: 'no agents hired' }]);
    // The explainer ran once, on the raw reason.
    expect(calls).toEqual([{ taskId: outcome.taskId, title: 'Fix the thing', rawReason: 'no agents hired' }]);
  });

  it('agent_not_hired retire → the explainer is invoked with the raw reason', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({
        store,
        execution,
        status,
        audit,
        content: labeledContent(['agent:ghost']), // names an unhired agent
        names: {},
        emBlockExplainer,
      })
    );
    expect(outcome.kind).toBe('agent_not_hired');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.rawReason).toBe("requested agent 'ghost' is not hired");
  });

  it('no-changes retire → the explainer is invoked (fallback title = story id, content out of scope)', async () => {
    const noChangeExec = new FakeExecution({ commitChanged: false });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: noChangeExec, status, audit, emBlockExplainer })
    );
    expect(outcome.kind).toBe('no_changes');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe('sc-story-1'); // the catch has no story content → story id fallback
    expect(calls[0]!.rawReason).toMatch(/no committed changes/i);
  });

  it('the EM-cap retire (already human) → the explainer is NOT invoked', async () => {
    // Seed a task already at round = CAP-1: the next unclear verdict escalates at the cap.
    const id = randomUUID();
    store.tasks.set(id, {
      id, externalStoryId: 'sc-story-1', title: null, platform: 'shortcut', status: 'routable', version: 0,
      claimedBy: null, failureCount: 0, repoRef: '/repos/demo', tierEstimate: null, lastError: null,
      preferredAgentId: null, emCleared: false, emClarificationRound: 2,
    });
    const emReviewGate: OrchestrationDeps['emReviewGate'] = async () => ({ clear: false });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, emReviewGate, emBlockExplainer })
    );
    expect(outcome.kind).toBe('needs_clarification_capped');
    expect(store.retireCalls[0]!.reason).toMatch(/still unclear after 3/i);
    expect(calls).toHaveLength(0); // the cap reason is already human — not rephrased
  });

  it('no emBlockExplainer wired → block still retires, no rephrase attempted', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: [] })
    );
    expect(outcome.kind).toBe('no_roster');
    if (outcome.kind !== 'no_roster') return;
    expect(store.tasks.get(outcome.taskId)!.status).toBe('needs_attention');
    expect(store.tasks.get(outcome.taskId)!.lastError).toBe('no agents hired'); // raw reason stands
  });

  it('the explainer throwing does NOT disturb the block outcome (best-effort)', async () => {
    const throwingExplainer: OrchestrationDeps['emBlockExplainer'] = async () => {
      throw new Error('explainer boom');
    };
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: [], emBlockExplainer: throwingExplainer })
    );
    expect(outcome.kind).toBe('no_roster'); // unchanged despite the throw
    if (outcome.kind !== 'no_roster') return;
    expect(store.tasks.get(outcome.taskId)!.status).toBe('needs_attention');
  });
});
