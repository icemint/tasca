import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IdentityBinding, Task, TaskStatus, TierEstimate } from '@tasca/domain';
import type { AgentWithProfile } from '@tasca/identity';
import { readApiHandler, type IdentityReader, type ReadApiDeps } from './read-api';
import type {
  ConnectionSummary,
  CoordinationStore,
  PullRequestRecord,
  RoutingDecisionRecord,
  TaskSummary,
} from './store';

// ── fakes (real in-memory state, no mocking framework) ───────────────────────

const tier = (t: TierEstimate['tier']): TierEstimate => ({
  tier: t,
  confidence: 0.8,
  signals: { wordCount: 10, hasReasoningVerb: false, scopeHint: 'unknown', labelTier: null },
  classifierUsed: false,
});

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    externalStoryId: `story-${id}`,
    platform: 'shortcut',
    status: 'routable',
    version: 0,
    claimedBy: null,
    failureCount: 0,
    repoRef: 'acme/api',
    tierEstimate: null,
    lastError: null,
    preferredAgentId: null,
    ...over,
  };
}

function summary(t: Task): TaskSummary {
  return {
    id: t.id,
    externalStoryId: t.externalStoryId,
    platform: t.platform,
    status: t.status,
    tierEstimate: t.tierEstimate,
    repoRef: t.repoRef,
    claimedBy: t.claimedBy,
    failureCount: t.failureCount,
  };
}

class FakeStore {
  tasks: Task[] = [];
  decisions: RoutingDecisionRecord[] = [];
  prs: PullRequestRecord[] = [];
  connections: ConnectionSummary[] = [];

  async listTasks(_orgId: string, filter?: { status?: TaskStatus; limit?: number }): Promise<TaskSummary[]> {
    let rows = this.tasks.slice();
    if (filter?.status) rows = rows.filter((t) => t.status === filter.status);
    if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit);
    return rows.map(summary);
  }
  async getTask(_orgId: string, id: string): Promise<Task | null> {
    return this.tasks.find((t) => t.id === id) ?? null;
  }
  async getRoutingDecisionForTask(_orgId: string, taskId: string): Promise<RoutingDecisionRecord | null> {
    return this.decisions.find((d) => d.taskId === taskId) ?? null;
  }
  async listRoutingDecisions(_orgId: string, limit?: number): Promise<RoutingDecisionRecord[]> {
    return limit !== undefined ? this.decisions.slice(0, limit) : this.decisions.slice();
  }
  async listPullRequestsForTask(_orgId: string, taskId: string): Promise<PullRequestRecord[]> {
    return taskId ? this.prs.slice() : [];
  }
  async listConnections(_orgId: string): Promise<ConnectionSummary[]> {
    return this.connections.slice();
  }
}

function agent(id: string, name: string, withProfile = true): AgentWithProfile {
  return {
    agent: {
      id,
      name,
      avatarUrl: null,
      vendor: 'claude',
      model: 'sonnet',
      status: 'active',
      rbacRoleId: null,
      humanOfRecordUserId: null,
      version: 0,
    },
    profile: withProfile
      ? {
          agentId: id,
          maxTier: 'hard',
          tiersCovered: ['basic', 'low', 'medium', 'hard'],
          languageSpecialties: ['TypeScript'],
          frameworkSpecialties: ['Node'],
          concurrencyLimit: 2,
          costCeiling: 20,
          successRate: 0.94,
          avgLatencyMs: 1000,
        }
      : null,
  };
}

class FakeIdentity implements IdentityReader {
  agents: AgentWithProfile[] = [];
  bindings: Record<string, IdentityBinding[]> = {};
  async listAgentsWithProfiles() {
    return this.agents.slice();
  }
  async getAgentWithProfile(id: string) {
    return this.agents.find((a) => a.agent.id === id) ?? null;
  }
  async listBindings(agentId: string) {
    return this.bindings[agentId] ?? [];
  }
}

// ── req/res harness (mirrors server.test.ts) ─────────────────────────────────

function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

interface CapturedRes {
  statusCode: number;
  body: string;
  res: ServerResponse;
}
function fakeRes(): CapturedRes {
  const captured: CapturedRes = { statusCode: 0, body: '', res: undefined as unknown as ServerResponse };
  const res = {
    headersSent: false,
    writeHead(code: number) {
      captured.statusCode = code;
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  } as unknown as ServerResponse;
  captured.res = res;
  return captured;
}

/** A membership reader that maps any user to one org (or null for the no-membership case). */
const membershipFor = (org: string | null) => ({ async getActiveOrg() { return org; } });

function deps(store: FakeStore, identity: FakeIdentity, over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  // Endpoint tests run with the unauthenticated opt-in so they exercise the
  // handlers directly; auth-gating tests override verifySession / allowUnauthenticated.
  return { store, identity, membership: membershipFor('org_default'), allowUnauthenticated: true, ...over };
}

const json = (r: CapturedRes) => JSON.parse(r.body);

describe('read-api handler', () => {
  it('ignores non-GET and non-/api paths (returns false → caller 404s)', async () => {
    const store = new FakeStore();
    const id = new FakeIdentity();
    const r1 = fakeRes();
    expect(await readApiHandler(fakeReq('POST', '/api/agents'), r1.res, deps(store, id))).toBe(false);
    const r2 = fakeRes();
    expect(await readApiHandler(fakeReq('GET', '/healthz'), r2.res, deps(store, id))).toBe(false);
  });

  it('does NOT claim /api/auth/* (left for the Auth track handler)', async () => {
    const store = new FakeStore();
    const id = new FakeIdentity();
    const r = fakeRes();
    expect(await readApiHandler(fakeReq('GET', '/api/auth/me'), r.res, deps(store, id))).toBe(false);
  });

  it('GET /api/agents → projects agents + capability, joins claimed task', async () => {
    const store = new FakeStore();
    store.tasks = [task('t1', { claimedBy: 'a1', status: 'executing' })];
    const id = new FakeIdentity();
    id.agents = [agent('a1', 'Nova'), agent('a2', 'Pike', false)];

    const r = fakeRes();
    expect(await readApiHandler(fakeReq('GET', '/api/agents'), r.res, deps(store, id))).toBe(true);
    expect(r.statusCode).toBe(200);
    const body = json(r);
    expect(body).toHaveLength(2);
    const nova = body.find((a: { name: string }) => a.name === 'Nova');
    expect(nova.currentTaskId).toBe('t1');
    expect(nova.state).toBe('working');
    expect(nova.capability.maxTier).toBe('hard');
    // agent with no capability profile → honest nulls, not fabricated numbers
    const pike = body.find((a: { name: string }) => a.name === 'Pike');
    expect(pike.capability.maxTier).toBeNull();
    expect(pike.state).toBe('idle');
    expect(pike.currentTaskId).toBeNull();
  });

  it('GET /api/agents/:id → 404 when unknown, detail when known', async () => {
    const store = new FakeStore();
    store.tasks = [task('t1', { claimedBy: 'a1' })];
    const id = new FakeIdentity();
    id.agents = [agent('a1', 'Nova')];
    id.bindings = {
      a1: [
        {
          id: 'b1',
          agentId: 'a1',
          platform: 'shortcut',
          externalId: 'sc-1',
          externalHandle: 'nova-agent',
          credentialRef: null,
          state: 'active',
        },
      ],
    };

    const miss = fakeRes();
    await readApiHandler(fakeReq('GET', '/api/agents/nope'), miss.res, deps(store, id));
    expect(miss.statusCode).toBe(404);

    const hit = fakeRes();
    await readApiHandler(fakeReq('GET', '/api/agents/a1'), hit.res, deps(store, id));
    expect(hit.statusCode).toBe(200);
    const body = json(hit);
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0].externalHandle).toBe('nova-agent');
    // credentialRef must NOT leak into the wire shape (it is a secret pointer)
    expect(body.bindings[0].credentialRef).toBeUndefined();
    expect(body.recentTasks).toHaveLength(1);
  });

  it('GET /api/tasks honors status filter + maps tierEstimate to its tier string', async () => {
    const store = new FakeStore();
    store.tasks = [
      task('t1', { status: 'executing', tierEstimate: tier('hard') }),
      task('t2', { status: 'done' }),
    ];
    const id = new FakeIdentity();
    const r = fakeRes();
    await readApiHandler(fakeReq('GET', '/api/tasks?status=executing'), r.res, deps(store, id));
    expect(r.statusCode).toBe(200);
    const body = json(r);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('t1');
    expect(body[0].tierEstimate).toBe('hard');
  });

  it('GET /api/tasks/:id → folds routing decision + PRs', async () => {
    const store = new FakeStore();
    store.tasks = [task('t1', { tierEstimate: tier('medium') })];
    store.decisions = [
      { id: 'd1', taskId: 't1', tierEstimate: tier('medium'), candidates: [], winnerAgentId: 'a1', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    store.prs = [{ url: 'https://example/pr/1', state: 'open', createdAt: '2026-01-01T00:00:00.000Z' }];
    const id = new FakeIdentity();
    const r = fakeRes();
    await readApiHandler(fakeReq('GET', '/api/tasks/t1'), r.res, deps(store, id));
    expect(r.statusCode).toBe(200);
    const body = json(r);
    expect(body.routingDecision.winnerAgentId).toBe('a1');
    expect(body.routingDecision.tierEstimate).toBe('medium');
    expect(body.pullRequests).toHaveLength(1);
  });

  it('GET /api/connections → wraps platforms', async () => {
    const store = new FakeStore();
    store.connections = [
      { platform: 'shortcut', workspaceId: 'ws1', health: 'healthy', webhook: { received24h: 3, processed24h: 3, lastReceivedAt: null } },
    ];
    const id = new FakeIdentity();
    const r = fakeRes();
    await readApiHandler(fakeReq('GET', '/api/connections'), r.res, deps(store, id));
    expect(r.statusCode).toBe(200);
    expect(json(r).platforms).toHaveLength(1);
  });

  it('401 when a session verifier is wired and rejects the request', async () => {
    const store = new FakeStore();
    const id = new FakeIdentity();
    const r = fakeRes();
    await readApiHandler(
      fakeReq('GET', '/api/agents'),
      r.res,
      deps(store, id, { verifySession: () => null })
    );
    expect(r.statusCode).toBe(401);
    expect(json(r).authenticated).toBe(false);
  });

  it('serves when a session verifier accepts the request', async () => {
    const store = new FakeStore();
    const id = new FakeIdentity();
    id.agents = [agent('a1', 'Nova')];
    const r = fakeRes();
    await readApiHandler(
      fakeReq('GET', '/api/agents'),
      r.res,
      deps(store, id, { verifySession: () => ({ userId: 'u1' }) })
    );
    expect(r.statusCode).toBe(200);
  });

  it('fails closed (503) by default when NO session verifier is wired', async () => {
    const store = new FakeStore();
    const id = new FakeIdentity();
    id.agents = [agent('a1', 'Nova')];
    const r = fakeRes();
    // No verifySession and no allowUnauthenticated opt-in → refuse, regardless of NODE_ENV.
    await readApiHandler(fakeReq('GET', '/api/agents'), r.res, { store, identity: id, membership: membershipFor('org_default') });
    expect(r.statusCode).toBe(503);
  });

  it('RBAC: a verified user WITH a membership is served their org', async () => {
    const store = new FakeStore();
    store.tasks = [task('t1', { status: 'routable' })];
    const id = new FakeIdentity();
    const r = fakeRes();
    await readApiHandler(
      fakeReq('GET', '/api/tasks'),
      r.res,
      deps(store, id, { verifySession: () => ({ userId: 'u-member' }), membership: membershipFor('org_default'), allowUnauthenticated: false })
    );
    expect(r.statusCode).toBe(200);
  });

  it('RBAC fail-closed: a verified user with NO membership is rejected (403), never default-org data', async () => {
    const store = new FakeStore();
    store.tasks = [task('t1', { status: 'routable' })];
    const id = new FakeIdentity();
    const r = fakeRes();
    await readApiHandler(
      fakeReq('GET', '/api/tasks'),
      r.res,
      deps(store, id, { verifySession: () => ({ userId: 'u-orphan' }), membership: membershipFor(null), allowUnauthenticated: false })
    );
    expect(r.statusCode).toBe(403); // no membership → fail closed, not 200 with org_default rows
  });
});
