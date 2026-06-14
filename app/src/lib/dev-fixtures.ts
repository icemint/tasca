// DEV-ONLY fixtures for the read API. This module is dynamically imported behind
// `useMock()` (DEV build or ?mock=1) so it is NEVER bundled into the production
// app — production renders REAL data from the worker, or honest empty/error
// states. The shapes here mirror the read-API contract exactly so screens can be
// built and reviewed before the live API is reachable. NOT shipped to users.

import type {
  Agent,
  AgentDetail,
  ConnectionsResponse,
  RoutingDecision,
  SessionResponse,
  TaskDetail,
  TaskSummary,
} from './contract';

const SESSION: SessionResponse = {
  authenticated: true,
  user: {
    id: 'dev-user',
    email: 'dev@tasca.dev',
    displayName: 'Dev User',
    avatarUrl: null,
    provider: 'github',
  },
};

const TASKS: TaskSummary[] = [
  { id: 'tas-241', externalStoryId: 'sc-241', platform: 'shortcut', status: 'executing', tierEstimate: 'hard', repoRef: 'acme/api', claimedBy: 'nova', failureCount: 0, lastError: null },
  { id: 'tas-219', externalStoryId: 'lin-219', platform: 'linear', status: 'executing', tierEstimate: 'medium', repoRef: 'acme/edge', claimedBy: 'juno', failureCount: 0, lastError: null },
  { id: 'bill-77', externalStoryId: 'sc-77', platform: 'shortcut', status: 'needs_attention', tierEstimate: 'ultra', repoRef: 'acme/billing', claimedBy: 'sable', failureCount: 3, lastError: 'no execution capacity: no agent-runner claimed within 30000ms' },
  { id: 'tas-271', externalStoryId: 'lin-271', platform: 'linear', status: 'routable', tierEstimate: 'medium', repoRef: 'acme/api', claimedBy: null, failureCount: 0, lastError: null },
  { id: 'tas-205', externalStoryId: 'gh-205', platform: 'github', status: 'done', tierEstimate: 'hard', repoRef: 'acme/api', claimedBy: 'pike', failureCount: 0, lastError: null },
];

const AGENTS: Agent[] = [
  { id: 'nova', name: 'Nova', vendor: 'claude', model: 'Sonnet 4.5', status: 'active', version: 0, avatarUrl: null, state: 'working', currentTaskId: 'tas-241',
    capability: { maxTier: 'hard', tiersCovered: ['basic','low','medium','hard'], languageSpecialties: ['TypeScript','Node'], frameworkSpecialties: ['Auth','Postgres'], concurrencyLimit: 2, costCeiling: 20, successRate: 0.94 } },
  { id: 'sable', name: 'Sable', vendor: 'claude', model: 'Opus 4.1', status: 'active', version: 0, avatarUrl: null, state: 'blocked', currentTaskId: 'bill-77',
    capability: { maxTier: 'ultra', tiersCovered: ['medium','hard','ultra'], languageSpecialties: ['TypeScript','Go'], frameworkSpecialties: ['Billing','Distributed'], concurrencyLimit: 2, costCeiling: 40, successRate: 0.90 } },
  { id: 'juno', name: 'Juno', vendor: 'openai', model: 'GPT-4.1', status: 'active', version: 0, avatarUrl: null, state: 'working', currentTaskId: 'tas-219',
    capability: { maxTier: 'medium', tiersCovered: ['basic','low','medium'], languageSpecialties: ['Node'], frameworkSpecialties: ['Edge','Webhooks'], concurrencyLimit: 2, costCeiling: 15, successRate: 0.92 } },
  { id: 'pike', name: 'Pike', vendor: 'claude', model: 'Sonnet 4.5', status: 'active', version: 0, avatarUrl: null, state: 'shipped', currentTaskId: null,
    capability: { maxTier: 'hard', tiersCovered: ['basic','low','medium','hard'], languageSpecialties: ['TypeScript'], frameworkSpecialties: ['API','Security'], concurrencyLimit: 2, costCeiling: 20, successRate: 0.96 } },
  { id: 'echo', name: 'Echo', vendor: 'local', model: 'LM Studio · qwen2.5', status: 'active', version: 0, avatarUrl: null, state: 'idle', currentTaskId: null,
    capability: { maxTier: 'low', tiersCovered: ['basic','low'], languageSpecialties: ['Scripts'], frameworkSpecialties: ['Tests'], concurrencyLimit: 3, costCeiling: 0, successRate: null } },
];

const ROUTING_DECISIONS: RoutingDecision[] = [
  { taskId: 'tas-241', tierEstimate: 'hard', winnerAgentId: 'nova', createdAt: '2026-06-01T12:04:02.000Z',
    candidates: [
      { agentId: 'nova', score: 0.92, eligible: true, reasons: ['TypeScript + auth history', 'HARD-capable', 'free slot'] },
      { agentId: 'sable', score: 0.74, eligible: false, reasons: ['at concurrency limit'] },
    ] },
  { taskId: 'tas-219', tierEstimate: 'medium', winnerAgentId: 'juno', createdAt: '2026-06-01T11:30:00.000Z',
    candidates: [{ agentId: 'juno', score: 0.88, eligible: true, reasons: ['edge history', 'free slot'] }] },
];

function agentDetail(id: string): AgentDetail | null {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) return null;
  return {
    ...a,
    bindings: [
      { platform: 'shortcut', externalHandle: `${a.id}-agent`, state: 'active' },
      { platform: 'github', externalHandle: `tasca-${a.id}[bot]`, state: 'active' },
    ],
    recentTasks: TASKS.filter((t) => t.claimedBy === id),
  };
}

function taskDetail(id: string): TaskDetail | null {
  const t = TASKS.find((x) => x.id === id);
  if (!t) return null;
  return {
    ...t,
    // Demonstrate the needs_attention reason surfacing in dev.
    lastError: t.status === 'needs_attention' ? 'no execution capacity: no agent-runner claimed within 30000ms' : null,
    routingDecision: ROUTING_DECISIONS.find((d) => d.taskId === id) ?? null,
    pullRequests:
      t.status === 'executing' || t.status === 'done'
        ? [{ url: `https://github.com/${t.repoRef}/pull/4821`, state: t.status === 'done' ? 'merged' : 'open', createdAt: '2026-06-01T12:11:55.000Z' }]
        : [],
  };
}

const CONNECTIONS: ConnectionsResponse = {
  platforms: [
    { platform: 'shortcut', workspaceId: 'Acme Robotics', health: 'healthy', webhook: { received24h: 1240, processed24h: 1240, lastReceivedAt: '2026-06-01T12:12:00.000Z' } },
    { platform: 'github', workspaceId: 'acme', health: 'degraded', webhook: { received24h: 33, processed24h: 27, lastReceivedAt: '2026-06-01T11:58:00.000Z' } },
    { platform: 'linear', workspaceId: 'Engineering', health: 'healthy', webhook: { received24h: 380, processed24h: 380, lastReceivedAt: '2026-06-01T12:11:00.000Z' } },
  ],
};

/** Resolve a fixture for a read-API path (mirrors the worker's routing). */
export function resolveFixture(path: string): unknown {
  const url = new URL(path, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/auth/me') return SESSION;
  if (p === '/api/agents') return AGENTS;
  if (p === '/api/tasks') {
    const status = url.searchParams.get('status');
    return status ? TASKS.filter((t) => t.status === status) : TASKS;
  }
  if (p === '/api/routing-decisions') return ROUTING_DECISIONS;
  if (p === '/api/connections') return CONNECTIONS;
  if (p === '/api/projects') {
    return {
      projects: [
        { id: 'proj_api', name: 'api', repoRef: 'acme/api' },
        { id: 'proj_billing', name: 'billing', repoRef: 'acme/billing' },
        { id: 'proj_edge', name: 'edge', repoRef: 'acme/edge' },
      ],
      activeProjectId: null,
    };
  }

  const agentMatch = /^\/api\/agents\/(.+)$/.exec(p);
  if (agentMatch) {
    const d = agentDetail(decodeURIComponent(agentMatch[1]!));
    if (!d) throw new Error('agent not found');
    return d;
  }
  const taskMatch = /^\/api\/tasks\/(.+)$/.exec(p);
  if (taskMatch) {
    const d = taskDetail(decodeURIComponent(taskMatch[1]!));
    if (!d) throw new Error('task not found');
    return d;
  }
  throw new Error(`no fixture for ${p}`);
}
