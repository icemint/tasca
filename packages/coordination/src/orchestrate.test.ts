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
import type {
  AgentProcessHandle,
  ExecutionPort,
  OpenPrInput,
  OpenPrResult,
  ReserveWorktreeInput,
  SpawnAgentInput,
  Worktree,
} from '@tasca/execution';
import { orchestrateTaskAssigned, type OrchestrationDeps } from './orchestrate';
import type { CoordinationStore } from './store';
import type { StatusReporter, StatusUpdate } from './ports';
import type { AgentDirectory, AuditSink, TaskContentSource } from './orchestrate';
import type { MatchCandidate } from '@tasca/routing';

// ── In-memory fakes ───────────────────────────────────────────────────────────

class FakeStore implements CoordinationStore {
  tasks = new Map<string, Task>();
  routingDecisions: Array<{ taskId: string; winnerAgentId: string | null }> = [];
  pullRequests: Array<{ taskId: string; url: string }> = [];
  seenEvents = new Set<string>();

  async recordWebhookEvent(input: { platform: string; externalEventId: string }) {
    const key = `${input.platform}:${input.externalEventId}`;
    if (this.seenEvents.has(key)) return { fresh: false };
    this.seenEvents.add(key);
    return { fresh: true };
  }
  async createTask(input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }) {
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
  async incrementFailureCount(taskId: string) {
    const t = this.tasks.get(taskId)!;
    t.failureCount += 1;
    return t.failureCount;
  }
  async recordRoutingDecision(input: { taskId: string; winnerAgentId: string | null }) {
    this.routingDecisions.push({ taskId: input.taskId, winnerAgentId: input.winnerAgentId });
  }
  async recordPullRequest(input: { taskId: string; url: string }) {
    this.pullRequests.push(input);
  }
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

function fakeHandle(opts: { exitCode?: number; error?: Error }): AgentProcessHandle {
  return {
    pid: 1234,
    onData() {},
    onExit(listener) {
      if (!opts.error) queueMicrotask(() => listener(opts.exitCode ?? 0));
    },
    onError(listener) {
      if (opts.error) queueMicrotask(() => listener(opts.error!));
    },
    kill() {},
  };
}

class FakeExecution implements ExecutionPort {
  spawnCalls = 0;
  prCalls = 0;
  constructor(private readonly behavior: { spawnExitCode?: number; spawnError?: Error; prError?: Error } = {}) {}
  async initDb() {}
  async reserveWorktree(input: ReserveWorktreeInput): Promise<Worktree> {
    return { path: `/tmp/wt/${input.taskLabel}`, branch: `tasca/${input.taskLabel}`, repoPath: input.repoPath };
  }
  spawnAgent(_input: SpawnAgentInput): AgentProcessHandle {
    this.spawnCalls += 1;
    return fakeHandle({
      ...(this.behavior.spawnExitCode !== undefined ? { exitCode: this.behavior.spawnExitCode } : {}),
      ...(this.behavior.spawnError !== undefined ? { error: this.behavior.spawnError } : {}),
    });
  }
  async openPr(_input: OpenPrInput): Promise<OpenPrResult> {
    this.prCalls += 1;
    if (this.behavior.prError) throw this.behavior.prError;
    return { url: 'https://github.com/icemint/tasca/pull/42' };
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
    expect(execution.prCalls).toBe(1);
    expect(store.pullRequests).toEqual([{ taskId: outcome.taskId, url: outcome.prUrl }]);

    // status-back as Elvis: comment + state + PR link
    expect(status.updates).toHaveLength(1);
    expect(status.updates[0]).toMatchObject({
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

describe('orchestrateTaskAssigned — failure path → breaker → needs_attention (§6.14)', () => {
  it('first failure → failed (below threshold), task is left for retry', async () => {
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
    expect(store.tasks.get(outcome.taskId)!.status).toBe('failed');
  });

  it('failure count reaching N=2 trips the breaker → needs_attention', async () => {
    const store = new FakeStore();
    // Seed a task already at failure_count 1 by running once, then re-run on it.
    // Simpler: drive incrementFailureCount to N by pre-failing the store task.
    const first = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: new FakeExecution({ spawnError: new Error('spawn boom') }), status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(first.kind).toBe('failed');

    // Second independent assignment that also fails, but seeded at count 1 so it
    // reaches the threshold: bump the new task's count by routing again with a
    // store whose failure increment starts from a tripped value.
    const trippingStore = new FakeStore();
    // Pre-load: monkeypatch incrementFailureCount to simulate an existing failure.
    const realInc = trippingStore.incrementFailureCount.bind(trippingStore);
    trippingStore.incrementFailureCount = async (id: string) => {
      await realInc(id);
      return realInc(id); // second bump → count 2
    };
    const tripped = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store: trippingStore, execution: new FakeExecution({ spawnExitCode: 2 }), status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(tripped.kind).toBe('needs_attention');
    if (tripped.kind !== 'needs_attention') return;
    expect(tripped.failureCount).toBe(2);
    expect(trippingStore.tasks.get(tripped.taskId)!.status).toBe('needs_attention');
  });

  it('a PR-open failure also feeds the breaker (spawn ok, PR throws)', async () => {
    const store = new FakeStore();
    const exec = new FakeExecution({ spawnExitCode: 0, prError: new Error('gh failed') });
    const outcome = await orchestrateTaskAssigned(
      EVENT,
      makeDeps({ store, execution: exec, status: new FakeStatus(), audit: new FakeAudit() })
    );
    expect(exec.spawnCalls).toBe(1);
    expect(outcome.kind).toBe('failed');
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
