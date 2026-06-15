import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus, TierEstimate } from '@tasca/domain';
import type { TaskAssignedEvent, TaskClarificationReplyEvent } from '@tasca/contracts';
import type { MatchCandidate, TaskInput } from '@tasca/routing';
import { handleClarificationReply, type ReplyConnectionContext } from './em-resume';
import type { OrchestrationDeps } from './orchestrate';
import type { CoordinationStore } from './store';

// Unit proof of the EM reply-resume handler (EM v1 slice 3). Hand-rolled fakes with real state; no DB, no
// LLM, no mocking framework. The resume handler is best-effort off the verified webhook: a reply on a
// non-parked story / the EM's own comment is a clean no-op; a genuine human reply resumes the task to
// routable and re-orchestrates it. Cross-tenant: the org is the CONNECTION's org — a parked task in
// another org is never resumed.

// ── A compact store fake covering the handler + the no_roster orchestration path ────────────────────────
class FakeStore {
  tasks = new Map<string, Task>();
  /** orgId → (projectId per repo). */
  projectFor(orgId: string, repoRef: string | null): string {
    return `${orgId}:proj:${repoRef ?? '∅'}`;
  }
  managerByProject = new Map<string, string>();
  managers = new Map<string, { id: string; name: string; shortcutMemberId: string | null; shortcutHandle: string | null }>();

  resumeCalls: Array<{ orgId: string; taskId: string }> = [];
  retireCalls: Array<{ taskId: string; reason: string }> = [];
  reorchestrated: TaskAssignedEvent[] = [];

  seed(task: Partial<Task> & { orgId: string }): Task {
    const t: Task = {
      id: randomUUID(),
      externalStoryId: 'sc-77',
      title: null,
      platform: 'shortcut',
      status: 'awaiting_clarification',
      version: 3,
      claimedBy: null,
      failureCount: 0,
      repoRef: 'acme/api',
      tierEstimate: null,
      lastError: null,
      preferredAgentId: null,
      emCleared: false,
      emClarificationRound: 1,
      ...task,
    };
    // Stash the owning org alongside the task so the org-scoped reads can enforce tenant isolation.
    this.taskOrg.set(t.id, task.orgId);
    this.tasks.set(t.id, t);
    return t;
  }
  private taskOrg = new Map<string, string>();

  async getAwaitingClarificationTask(orgId: string, platform: Task['platform'], externalStoryId: string): Promise<Task | null> {
    for (const t of this.tasks.values()) {
      if (
        this.taskOrg.get(t.id) === orgId &&
        t.platform === platform &&
        t.externalStoryId === externalStoryId &&
        t.status === 'awaiting_clarification'
      )
        return t;
    }
    return null;
  }
  async getOrCreateProject(orgId: string, repoRef: string | null): Promise<string> {
    return this.projectFor(orgId, repoRef);
  }
  async getManagerForProject(_orgId: string, projectId: string): Promise<string | null> {
    return this.managerByProject.get(projectId) ?? null;
  }
  async getManager(_orgId: string, managerId: string) {
    return this.managers.get(managerId) ?? null;
  }
  async resumeFromClarification(orgId: string, taskId: string): Promise<boolean> {
    this.resumeCalls.push({ orgId, taskId });
    const t = this.tasks.get(taskId);
    if (!t || this.taskOrg.get(taskId) !== orgId || t.status !== 'awaiting_clarification') return false;
    t.status = 'routable'; // em_cleared + round untouched
    t.version += 1;
    return true;
  }
  // ── the slice of the orchestration forward path the no_roster terminal touches ──
  async getOrCreateTask(orgId: string, input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }): Promise<Task> {
    for (const t of this.tasks.values()) {
      if (this.taskOrg.get(t.id) === orgId && t.platform === input.platform && t.externalStoryId === input.externalStoryId) return t;
    }
    return this.seed({ orgId, externalStoryId: input.externalStoryId, platform: input.platform, status: 'routable', repoRef: input.repoRef ?? null });
  }
  async getTaskOrigin(): Promise<null> {
    return null;
  }
  async markEmCleared(_orgId: string, taskId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (t) t.emCleared = true;
  }
  async setTierEstimate(_orgId: string, taskId: string, estimate: TierEstimate): Promise<void> {
    const t = this.tasks.get(taskId);
    if (t) t.tierEstimate = estimate;
  }
  async recordRoutingDecision(): Promise<void> {}
  async retireUnroutable(_orgId: string, taskId: string, reason: string): Promise<boolean> {
    this.retireCalls.push({ taskId, reason });
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'routable') return false;
    t.status = 'needs_attention';
    t.version += 1;
    return true;
  }
}

const STUB_CONTENT: TaskInput = { title: 'A story', body: 'with a body' };

/** Orchestration deps whose directory returns NO candidates → the forward path terminates at no_roster
 *  (retireUnroutable). Enough to prove the resume re-orchestrated without standing up the full pipeline. The
 *  emReviewGate records the synthetic event it was handed (proving the re-review ran on it). */
function makeDeps(store: FakeStore, gateSeen?: TaskAssignedEvent[]): OrchestrationDeps {
  return {
    store: store as unknown as CoordinationStore,
    claim: { async tryClaim() { return { won: false, newVersion: null, found: false }; } },
    execution: {} as OrchestrationDeps['execution'],
    status: { async postStatus() {} },
    directory: {
      async listCandidates(): Promise<MatchCandidate[]> { return []; },
      async findHiredAgentByName() { return null; },
      async principalIdFor() { return null; },
    },
    audit: { async record() {} },
    content: { async fetch() { return STUB_CONTENT; } },
    ...(gateSeen
      ? {
          emReviewGate: async (_org, _task, _content, event) => {
            gateSeen.push(event);
            return { clear: true };
          },
        }
      : {}),
  };
}

const CONNECTION: ReplyConnectionContext = { connectionId: 'conn-1', orgId: 'org_a', repoRef: 'acme/api' };

function reply(over: Partial<TaskClarificationReplyEvent> = {}): TaskClarificationReplyEvent {
  return { type: 'task.clarification_reply', platform: 'shortcut', externalStoryId: 'sc-77', replierMemberId: 'human-id', ...over };
}

describe('handleClarificationReply (EM v1 slice 3)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('a genuine human reply → resumes the parked task to routable AND re-orchestrates it', async () => {
    const parked = store.seed({ orgId: 'org_a' });
    const gateSeen: TaskAssignedEvent[] = [];
    const out = await handleClarificationReply(reply(), makeDeps(store, gateSeen), 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'resumed', taskId: parked.id });
    expect(store.resumeCalls).toEqual([{ orgId: 'org_a', taskId: parked.id }]);
    // Re-orchestrated: the synthetic task.assigned reached the gate, carrying the connection's repo + id.
    expect(gateSeen).toHaveLength(1);
    expect(gateSeen[0]).toMatchObject({
      type: 'task.assigned',
      platform: 'shortcut',
      externalStoryId: 'sc-77',
      shortcutConnectionId: 'conn-1',
      repoHint: 'acme/api',
    });
  });

  it('the round PERSISTS across the resume (the cap still counts)', async () => {
    const parked = store.seed({ orgId: 'org_a', emClarificationRound: 2 });
    await handleClarificationReply(reply(), makeDeps(store), 'org_a', CONNECTION);
    expect(store.tasks.get(parked.id)!.emClarificationRound).toBe(2); // untouched by the resume
    expect(store.tasks.get(parked.id)!.emCleared).toBe(false); // gate must re-run
  });

  it("the EM's OWN comment (replier == manager.shortcutMemberId) → no-op, never resumes", async () => {
    const parked = store.seed({ orgId: 'org_a' });
    const projectId = store.projectFor('org_a', 'acme/api');
    store.managerByProject.set(projectId, 'mgr-elvis');
    store.managers.set('mgr-elvis', { id: 'mgr-elvis', name: 'Elvis', shortcutMemberId: 'em-member-id', shortcutHandle: null });
    const out = await handleClarificationReply(reply({ replierMemberId: 'em-member-id' }), makeDeps(store), 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'em_own_comment', taskId: parked.id });
    expect(store.resumeCalls).toHaveLength(0);
    expect(store.tasks.get(parked.id)!.status).toBe('awaiting_clarification');
  });

  it('a different human, even with a manager set → resumes (only the EM is dropped)', async () => {
    const parked = store.seed({ orgId: 'org_a' });
    const projectId = store.projectFor('org_a', 'acme/api');
    store.managerByProject.set(projectId, 'mgr-elvis');
    store.managers.set('mgr-elvis', { id: 'mgr-elvis', name: 'Elvis', shortcutMemberId: 'em-member-id', shortcutHandle: null });
    const out = await handleClarificationReply(reply({ replierMemberId: 'someone-else' }), makeDeps(store), 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'resumed', taskId: parked.id });
  });

  it('a reply on a story with NO parked task → clean no-op', async () => {
    const out = await handleClarificationReply(reply({ externalStoryId: 'sc-does-not-exist' }), makeDeps(store), 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'no_parked_task' });
    expect(store.resumeCalls).toHaveLength(0);
  });

  it('a reply on an ALREADY-resumed/routable task → no parked task → no-op (idempotent)', async () => {
    store.seed({ orgId: 'org_a', status: 'routable' });
    const out = await handleClarificationReply(reply(), makeDeps(store), 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'no_parked_task' });
  });

  it('CROSS-TENANT: a task parked in another org is never resumed from this connection', async () => {
    // The parked task belongs to org_b; the reply arrives on org_a's connection. The org-scoped read
    // returns null → no-op. The other tenant's task is untouched.
    const foreign = store.seed({ orgId: 'org_b' });
    const out = await handleClarificationReply(reply(), makeDeps(store), 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'no_parked_task' });
    expect(store.tasks.get(foreign.id)!.status).toBe('awaiting_clarification');
  });

  it('a concurrent move out of awaiting_clarification → resume no-ops (already_moved), no re-orchestration', async () => {
    const parked = store.seed({ orgId: 'org_a' });
    const gateSeen: TaskAssignedEvent[] = [];
    const deps = makeDeps(store, gateSeen);
    // Simulate the race: the task is found parked, but moves before resumeFromClarification runs.
    const realResume = store.resumeFromClarification.bind(store);
    store.resumeFromClarification = async (orgId, taskId) => {
      store.tasks.get(taskId)!.status = 'claimed'; // an operator/claim moved it
      return realResume(orgId, taskId);
    };
    const out = await handleClarificationReply(reply(), deps, 'org_a', CONNECTION);
    expect(out).toEqual({ kind: 'already_moved', taskId: parked.id });
    expect(gateSeen).toHaveLength(0); // never re-orchestrated
  });
});
