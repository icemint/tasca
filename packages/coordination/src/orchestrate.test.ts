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
import { orchestrateTaskAssigned, type OrchestrationDeps } from './orchestrate';
import type { CoordinationStore } from './store';
import type { StatusReporter, StatusUpdate } from './ports';
import type { AgentDirectory, AuditSink, RepoProvisioner, TaskContentSource } from './orchestrate';
import type { MatchCandidate } from '@tasca/routing';

// ── In-memory fakes ───────────────────────────────────────────────────────────

class FakeStore implements CoordinationStore {
  tasks = new Map<string, Task>();
  routingDecisions: Array<{ taskId: string; winnerAgentId: string | null }> = [];
  pullRequests: Array<{ taskId: string; url: string }> = [];
  events = new Map<string, 'received' | 'processed'>();

  async recordWebhookEvent(input: { platform: string; externalEventId: string }) {
    const key = `${input.platform}:${input.externalEventId}`;
    const existing = this.events.get(key);
    if (existing === undefined) {
      this.events.set(key, 'received');
      return { fresh: true, alreadyProcessed: false };
    }
    return { fresh: false, alreadyProcessed: existing === 'processed' };
  }
  async markWebhookProcessed(input: { platform: string; externalEventId: string }) {
    this.events.set(`${input.platform}:${input.externalEventId}`, 'processed');
  }
  async getOrCreateTask(input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }) {
    // Get-or-create keyed by (platform, externalStoryId), mirroring the PG unique.
    for (const t of this.tasks.values()) {
      if (t.platform === input.platform && t.externalStoryId === input.externalStoryId) return t;
    }
    const task: Task = {
      id: randomUUID(),
      externalStoryId: input.externalStoryId,
      platform: input.platform,
      status: 'routable',
      version: 0,
      claimedBy: null,
      failureCount: 0,
      repoRef: input.repoRef ?? null,
      tierEstimate: null,
    };
    this.tasks.set(task.id, task);
    return task;
  }
  async getTask(taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }
  async setTierEstimate(taskId: string, estimate: TierEstimate) {
    const t = this.tasks.get(taskId)!;
    t.tierEstimate = estimate;
  }
  async setStatus(taskId: string, status: TaskStatus) {
    const t = this.tasks.get(taskId)!;
    t.status = status;
    t.version += 1;
  }
  async recordFailureAndTransition(taskId: string, breakerThreshold: number) {
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
  async upsertGitHubInstallation() {}
  async getInstallationIdForOwner() {
    return null;
  }
  async recordRoutingDecision(input: { taskId: string; winnerAgentId: string | null }) {
    this.routingDecisions.push({ taskId: input.taskId, winnerAgentId: input.winnerAgentId });
  }
  failRecordOnce = false;
  async recordPullRequest(input: { taskId: string; url: string }) {
    if (this.failRecordOnce) {
      this.failRecordOnce = false;
      throw new Error('pull_request INSERT failed (connection dropped)');
    }
    this.pullRequests.push(input);
  }
  // read-side
  async listTasks() { return []; }
  async getRoutingDecisionForTask() { return null; }
  async listRoutingDecisions() { return []; }
  async listPullRequestsForTask(taskId: string) {
    return this.pullRequests
      .filter((p) => p.taskId === taskId)
      .map((p) => ({ url: p.url, state: 'open' as const, createdAt: '2026-01-01T00:00:00Z' }));
  }
  async listConnections() { return []; }
}

/** A claim port that wins iff the task is still routable at the expected version. */
class FakeClaimPort implements ClaimPort {
  constructor(private readonly store: FakeStore) {}
  async tryClaim(taskId: string, agentId: string, expectedVersion: number): Promise<ClaimOutcome> {
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

function fakeHandle(opts: { exitCode?: number; error?: Error; hang?: boolean }): AgentProcessHandle {
  return {
    pid: 1234,
    onData() {},
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
  async openPr(input: OpenPrInput): Promise<OpenPrResult> {
    this.prCalls += 1;
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
  constructor(private readonly candidates: MatchCandidate[]) {}
  async listCandidates() {
    return this.candidates;
  }
  async principalIdFor(agentId: string) {
    return `prn_${agentId}`;
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
}): OrchestrationDeps {
  const candidates = opts.candidates ?? [{ profile: elvisProfile(), state: 'idle', activeCount: 0 }];
  return {
    store: opts.store,
    claim: new FakeClaimPort(opts.store),
    execution: opts.execution,
    status: opts.status,
    directory: new FakeDirectory(candidates),
    audit: opts.audit,
    content,
  };
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
  });

  it('empty roster → no_candidate, no dispatch, decision still persisted', async () => {
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution, status, audit, candidates: [] })
    );
    expect(outcome.kind).toBe('no_candidate');
    if (outcome.kind !== 'no_candidate') return;
    expect(execution.spawnCalls).toBe(0);
    // The routing decision is still persisted (inspector sees a no-winner attempt).
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

  it('agent run with NO committed change → failed, and openPr is NOT called (no empty PR)', async () => {
    const store = new FakeStore();
    const exec = new FakeExecution({ spawnExitCode: 0, commitChanged: false });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: exec, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(exec.spawnCalls).toBe(1);
    expect(exec.commitCalls).toBe(1);
    // No diff → fail BEFORE openPr; no PR opened, no PR recorded.
    expect(exec.prCalls).toBe(0);
    expect(outcome.kind).toBe('failed');
    expect(store.pullRequests).toHaveLength(0);
    expect(store.tasks.get((outcome as { taskId: string }).taskId)!.status).toBe('routable');
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
    const seeded = await store.getOrCreateTask({
      externalStoryId: EVENT.externalStoryId,
      platform: 'shortcut',
      repoRef: '/repos/demo',
    });
    await store.recordPullRequest({ taskId: seeded.id, url: 'https://github.com/icemint/tasca/pull/7' });

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

  it('provisions the slug to a local path, which reserveWorktree then uses', async () => {
    const store = new FakeStore();
    const execution = new FakeExecution();
    const seen: string[] = [];
    const provisioner: RepoProvisioner = {
      async ensureLocalRepo(repoRef) {
        seen.push(repoRef);
        return { path: '/local/checkout', defaultBranch: 'trunk' };
      },
    };
    const deps: OrchestrationDeps = {
      ...makeDeps({ store, execution, status: new FakeStatus(), audit: new FakeAudit() }),
      provisioner,
    };

    const outcome = await orchestrateTaskAssigned(GITHUB_EVENT, deps);

    expect(outcome.kind).toBe('dispatched');
    // (a) the provisioner saw the raw slug
    expect(seen).toEqual(['acme/widgets']);
    // (b) reserveWorktree got the provisioned local path + `origin/<defaultBranch>`
    //     as the base ref (so it never hits Emdash's per-project-settings lookup).
    expect(execution.reserveInputs).toEqual([
      { repoPath: '/local/checkout', taskLabel: 'gh-story-1', projectId: 'gh-story-1', baseRef: 'origin/trunk' },
    ]);
  });

  it('a provisioning failure feeds the breaker (failed → needs_attention)', async () => {
    const store = new FakeStore();
    const failing: RepoProvisioner = {
      async ensureLocalRepo() {
        throw new Error('no GitHub App installation for owner acme');
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
