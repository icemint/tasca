// Test support: a `fetch` stub keyed by path, plus realistic fixtures that mirror
// the real agent activity (the agent-authored PRs #8/#9 for issues #5/#6 on
// agentic-playground). NOT a .test.ts file, so vitest doesn't run it as a suite.

import { vi } from 'vitest';
import type { LoadResult } from './mount';
import type {
  Agent,
  AgentDetail,
  ConnectionsResponse,
  CredentialAuditResponse,
  SessionResponse,
  TaskDetail,
  TaskSummary,
  VendorCredentialsResponse,
} from './contract';

/** Narrow a LoadResult to its html (throws on unauth/error), so view assertions
 *  read the rendered markup without a manual type guard at every call site. */
export function htmlOf(r: LoadResult): string {
  if (r.kind === 'unauth' || r.kind === 'error') throw new Error(`expected html, got ${r.kind}`);
  return r.html;
}

/** Stub global.fetch with an exact path→response map (query string is ignored).
 *  Unmapped paths resolve 404. Pair with `vi.unstubAllGlobals()` in afterEach. */
export function stubFetch(routes: Record<string, { status?: number; body?: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const path = String(input).split('?')[0]!;
      const r = routes[path];
      if (!r) return new Response('not found', { status: 404 });
      const status = r.status ?? 200;
      const body = r.body === undefined ? '' : JSON.stringify(r.body);
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    })
  );
}

/** A network failure (fetch rejects) — drives the 'error' state. */
export function stubFetchReject(): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('boom');
  }));
}

export const SESSION_OK: SessionResponse = {
  authenticated: true,
  user: { id: 'u1', email: 'denny@tasca.dev', displayName: 'Denny', avatarUrl: null, provider: 'github' },
};

export const AGENT_ELVIS: Agent = {
  id: 'agent-elvis',
  name: 'Elvis',
  vendor: 'claude',
  model: 'claude-opus-4-8',
  status: 'active',
  version: 0,
  avatarUrl: null,
  currentTaskId: 'task-lru',
  state: 'working',
  capability: {
    maxTier: 'hard',
    tiersCovered: ['low', 'medium', 'hard'],
    languageSpecialties: ['TypeScript'],
    frameworkSpecialties: ['Node'],
    concurrencyLimit: 2,
    costCeiling: null,
    successRate: 1,
  },
};

export const TASK_LRU: TaskSummary = {
  id: 'task-lru',
  externalStoryId: 'roadhero/agentic-playground#5',
  platform: 'github',
  status: 'done',
  tierEstimate: 'medium',
  repoRef: 'roadhero/agentic-playground',
  claimedBy: 'agent-elvis',
  failureCount: 0,
};

export const TASK_RETRY_ATTN: TaskSummary = {
  id: 'task-retry',
  externalStoryId: 'roadhero/agentic-playground#6',
  platform: 'github',
  status: 'needs_attention',
  tierEstimate: 'hard',
  repoRef: 'roadhero/agentic-playground',
  claimedBy: 'agent-elvis',
  failureCount: 2,
};

export const TASK_LRU_DETAIL: TaskDetail = {
  ...TASK_LRU,
  lastError: null,
  routingDecision: {
    taskId: 'task-lru',
    tierEstimate: 'medium',
    winnerAgentId: 'agent-elvis',
    createdAt: '2026-06-08T00:00:00Z',
    candidates: [
      { agentId: 'agent-elvis', score: 0.92, eligible: true, reasons: ['TypeScript match'] },
      { agentId: 'agent-other', score: 0.4, eligible: false, reasons: ['tier too low'] },
    ],
  },
  pullRequests: [
    { url: 'https://github.com/roadhero/agentic-playground/pull/8', state: 'merged', createdAt: '2026-06-08T01:00:00Z' },
  ],
};

/** An executing task — a live run in flight — so the cancel-coupled controls (Interrupt +
 *  live Reassign) render. */
export const TASK_EXECUTING_DETAIL: TaskDetail = {
  ...TASK_LRU,
  id: 'task-exec',
  status: 'executing',
  claimedBy: 'agent-elvis',
  lastError: null,
  routingDecision: null,
  pullRequests: [],
};

/** A task parked in needs_attention with a recorded reason (no execution capacity) — so the
 *  inspector's reason surfacing renders. */
export const TASK_NO_CAPACITY_DETAIL: TaskDetail = {
  ...TASK_LRU,
  id: 'task-nocap',
  status: 'needs_attention',
  lastError: 'no execution capacity: no agent-runner claimed within 30000ms',
  routingDecision: null,
  pullRequests: [],
};

export const AGENT_ELVIS_DETAIL: AgentDetail = {
  ...AGENT_ELVIS,
  bindings: [{ platform: 'github', externalHandle: 'tasca-elvis', state: 'active' }],
  recentTasks: [TASK_LRU, TASK_RETRY_ATTN],
};

export const CONNECTIONS_OK: ConnectionsResponse = {
  platforms: [
    {
      platform: 'github',
      workspaceId: 'roadhero',
      health: 'healthy',
      webhook: { received24h: 12, processed24h: 12, lastReceivedAt: new Date().toISOString() },
    },
  ],
};

// ── vendor credentials (slice 3.5-A.2c.2) — the read shape NEVER carries a key. ──
export const VENDOR_CREDS_ACTIVE: VendorCredentialsResponse = {
  credentials: [
    { provider: 'anthropic', status: 'active', fingerprint: '1a2b', lastValidatedAt: new Date().toISOString() },
  ],
};

export const VENDOR_CREDS_EMPTY: VendorCredentialsResponse = { credentials: [] };

export const CREDENTIAL_AUDIT_OK: CredentialAuditResponse = {
  events: [
    { id: 'ev2', actorUserId: 'u1', action: 'credential.set', target: 'anthropic', payload: { fingerprint: '1a2b', status: 'active' }, at: new Date().toISOString() },
    { id: 'ev1', actorUserId: null, action: 'credential.delete', target: 'anthropic', payload: {}, at: '2026-06-12T00:00:00Z' },
  ],
};

export const CREDENTIAL_AUDIT_EMPTY: CredentialAuditResponse = { events: [] };
