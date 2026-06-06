// The read-only HTTP API the authenticated app (app.tasca.dev) consumes. It is a
// CLEAN, ADDITIVE module: the server delegates to `readApiHandler` with a SINGLE
// line before its 404, mirroring how the Auth track delegates to its handler —
// so this branch and the Auth branch touch server.ts in non-overlapping spots
// and merge without conflict.
//
// Every endpoint is GET + JSON + same-origin (the app calls relative `/api/...`
// URLs; nginx reverse-proxies `/api/` to this worker). Responses project the
// existing @tasca/domain rows; nothing aggregate the schema doesn't carry is
// fabricated — absent data renders as null / [] / "—" in the UI.
//
// Auth: a session-verifier may be injected (`verifySession`). When present, a
// request without a valid session gets 401 (the app redirects to the login page).
// When ABSENT (the Auth track hasn't merged yet), enforcement is skipped in
// non-production and refused in production — coordination keeps its boundary and
// never hard-depends on @tasca/auth.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Agent as DomainAgent,
  AgentState,
  CapabilityProfile,
  IdentityBinding,
  Tier,
} from '@tasca/domain';
import type {
  ConnectionSummary,
  CoordinationStore,
  PullRequestRecord,
  RoutingDecisionRecord,
  TaskSummary,
} from './store';
import type { Logger } from './ports';

// ── Read-side seams (narrow; the factory injects the concrete @tasca/identity repo) ─
import type { AgentRecord, AgentWithProfile } from '@tasca/identity';

/** The identity read surface the API needs — a subset of PgIdentityRepository. */
export interface IdentityReader {
  listAgentsWithProfiles(status?: 'active' | 'paused' | 'retired'): Promise<AgentWithProfile[]>;
  getAgentWithProfile(agentId: string): Promise<AgentWithProfile | null>;
  listBindings(agentId: string): Promise<IdentityBinding[]>;
}

/** Result of verifying a request's session. */
export interface SessionInfo {
  userId: string;
}

export interface ReadApiDeps {
  store: Pick<
    CoordinationStore,
    | 'listTasks'
    | 'getTask'
    | 'getRoutingDecisionForTask'
    | 'listRoutingDecisions'
    | 'listPullRequestsForTask'
    | 'listConnections'
  >;
  identity: IdentityReader;
  /**
   * Verify the request's session. When provided, a missing/invalid session → 401.
   * When omitted, the Auth track is not yet wired: allow in non-prod, refuse in prod.
   */
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /** True in production — gates the no-verifier fallback. Defaults to NODE_ENV check. */
  isProduction?: boolean;
  logger?: Logger;
}

// ── JSON wire shapes (the contract the app/ projects in app/src/lib/contract.ts) ──

interface CapabilityJson {
  maxTier: Tier | null;
  tiersCovered: Tier[];
  languageSpecialties: string[];
  frameworkSpecialties: string[];
  concurrencyLimit: number | null;
  costCeiling: number | null;
  successRate: number | null;
}

interface AgentJson {
  id: string;
  name: string;
  vendor: DomainAgent['vendor'] | string;
  model: string;
  status: AgentRecord['status'];
  avatarUrl: string | null;
  capability: CapabilityJson;
  currentTaskId: string | null;
  state: AgentState;
}

interface BindingJson {
  platform: IdentityBinding['platform'];
  externalHandle: string | null;
  state: IdentityBinding['state'];
}

function capabilityJson(profile: CapabilityProfile | null): CapabilityJson {
  return {
    maxTier: profile?.maxTier ?? null,
    tiersCovered: profile?.tiersCovered ?? [],
    languageSpecialties: profile?.languageSpecialties ?? [],
    frameworkSpecialties: profile?.frameworkSpecialties ?? [],
    concurrencyLimit: profile?.concurrencyLimit ?? null,
    costCeiling: profile?.costCeiling ?? null,
    successRate: profile?.successRate ?? null,
  };
}

/**
 * Map an agent record to the wire shape. Live `state` and `currentTaskId` are
 * coordination concerns the identity store doesn't track yet (the routing loop
 * surfaces them later); until then they are reported honestly as 'idle' / null
 * rather than fabricated. `currentByAgent` lets the list endpoint fill in the
 * task an agent has claimed from the task table without an N+1.
 */
function agentJson(
  a: AgentWithProfile,
  currentByAgent: Map<string, string>
): AgentJson {
  const currentTaskId = currentByAgent.get(a.agent.id) ?? null;
  return {
    id: a.agent.id,
    name: a.agent.name,
    vendor: a.agent.vendor,
    model: a.agent.model,
    status: a.agent.status,
    avatarUrl: a.agent.avatarUrl,
    capability: capabilityJson(a.profile),
    currentTaskId,
    state: currentTaskId ? 'working' : 'idle',
  };
}

function connectionsJson(connections: ConnectionSummary[]) {
  return { platforms: connections };
}

function taskSummaryJson(t: TaskSummary) {
  return {
    id: t.id,
    externalStoryId: t.externalStoryId,
    platform: t.platform,
    status: t.status,
    tierEstimate: t.tierEstimate ? t.tierEstimate.tier : null,
    repoRef: t.repoRef,
    claimedBy: t.claimedBy,
    failureCount: t.failureCount,
  };
}

function routingDecisionJson(d: RoutingDecisionRecord) {
  return {
    taskId: d.taskId,
    tierEstimate: d.tierEstimate.tier,
    candidates: d.candidates,
    winnerAgentId: d.winnerAgentId,
    createdAt: d.createdAt,
  };
}

function pullRequestJson(p: PullRequestRecord) {
  return { url: p.url, state: p.state, createdAt: p.createdAt };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Build the per-agent → claimed-task map from the task list (claimed_by = agent id). */
function claimedTaskMap(tasks: TaskSummary[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tasks) {
    if (t.claimedBy && !m.has(t.claimedBy)) m.set(t.claimedBy, t.id);
  }
  return m;
}

/**
 * The read API request handler. Returns `true` when it handled the request (so
 * the caller stops), `false` when the path is not a read-API GET (so the caller
 * falls through to its own routing / 404). All matched paths under `/api/` that
 * aren't this module's read endpoints are NOT claimed here — auth owns `/api/auth/*`.
 */
export async function readApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReadApiDeps
): Promise<boolean> {
  if (req.method !== 'GET' || req.url === undefined) return false;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // Only claim the read-API namespace. Auth (`/api/auth/*`) is left for its handler.
  if (!path.startsWith('/api/') || path.startsWith('/api/auth/')) return false;

  // Match before doing any auth work, so a non-read path falls through cleanly.
  const matched = matchRoute(path);
  if (!matched) return false;

  // ── session enforcement ──────────────────────────────────────────────────
  if (deps.verifySession) {
    let session: SessionInfo | null = null;
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('read-api: session verification threw', { err: String(err) });
      sendJson(res, 401, { authenticated: false });
      return true;
    }
    if (!session) {
      sendJson(res, 401, { authenticated: false });
      return true;
    }
  } else {
    const isProd = deps.isProduction ?? process.env.NODE_ENV === 'production';
    if (isProd) {
      // No session verifier wired in production → fail closed, never serve data.
      sendJson(res, 503, { error: 'auth not configured' });
      return true;
    }
    // non-prod: allow (lets the UI render against the read API before Auth merges)
  }

  try {
    await dispatch(matched, url, res, deps);
  } catch (err) {
    deps.logger?.error('read-api: handler failed', { path, err: String(err) });
    sendJson(res, 500, { error: 'internal error' });
  }
  return true;
}

type Route =
  | { kind: 'agents' }
  | { kind: 'agent'; id: string }
  | { kind: 'tasks' }
  | { kind: 'task'; id: string }
  | { kind: 'routing-decisions' }
  | { kind: 'connections' };

function matchRoute(path: string): Route | null {
  if (path === '/api/agents') return { kind: 'agents' };
  if (path === '/api/tasks') return { kind: 'tasks' };
  if (path === '/api/routing-decisions') return { kind: 'routing-decisions' };
  if (path === '/api/connections') return { kind: 'connections' };
  const agent = /^\/api\/agents\/([^/]+)$/.exec(path);
  if (agent) return { kind: 'agent', id: decodeURIComponent(agent[1]!) };
  const task = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (task) return { kind: 'task', id: decodeURIComponent(task[1]!) };
  return null;
}

async function dispatch(
  route: Route,
  url: URL,
  res: ServerResponse,
  deps: ReadApiDeps
): Promise<void> {
  switch (route.kind) {
    case 'agents': {
      const [agents, tasks] = await Promise.all([
        deps.identity.listAgentsWithProfiles(),
        deps.store.listTasks({ limit: 200 }),
      ]);
      const current = claimedTaskMap(tasks);
      sendJson(res, 200, agents.map((a) => agentJson(a, current)));
      return;
    }
    case 'agent': {
      const agent = await deps.identity.getAgentWithProfile(route.id);
      if (!agent) {
        sendJson(res, 404, { error: 'agent not found' });
        return;
      }
      const [bindings, tasks] = await Promise.all([
        deps.identity.listBindings(route.id),
        deps.store.listTasks({ limit: 200 }),
      ]);
      const current = claimedTaskMap(tasks);
      const recentTasks = tasks.filter((t) => t.claimedBy === route.id).slice(0, 10);
      sendJson(res, 200, {
        ...agentJson(agent, current),
        bindings: bindings.map(
          (b): BindingJson => ({
            platform: b.platform,
            externalHandle: b.externalHandle,
            state: b.state,
          })
        ),
        recentTasks: recentTasks.map(taskSummaryJson),
      });
      return;
    }
    case 'tasks': {
      const statusParam = url.searchParams.get('status') ?? undefined;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : undefined;
      const tasks = await deps.store.listTasks({
        ...(statusParam ? { status: statusParam as TaskSummary['status'] } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      sendJson(res, 200, tasks.map(taskSummaryJson));
      return;
    }
    case 'task': {
      const task = await deps.store.getTask(route.id);
      if (!task) {
        sendJson(res, 404, { error: 'task not found' });
        return;
      }
      const [decision, prs] = await Promise.all([
        deps.store.getRoutingDecisionForTask(route.id),
        deps.store.listPullRequestsForTask(route.id),
      ]);
      sendJson(res, 200, {
        id: task.id,
        externalStoryId: task.externalStoryId,
        platform: task.platform,
        status: task.status,
        tierEstimate: task.tierEstimate ? task.tierEstimate.tier : null,
        repoRef: task.repoRef,
        claimedBy: task.claimedBy,
        failureCount: task.failureCount,
        routingDecision: decision ? routingDecisionJson(decision) : null,
        pullRequests: prs.map(pullRequestJson),
      });
      return;
    }
    case 'routing-decisions': {
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : undefined;
      const decisions = await deps.store.listRoutingDecisions(limit);
      sendJson(res, 200, decisions.map(routingDecisionJson));
      return;
    }
    case 'connections': {
      const connections = await deps.store.listConnections();
      sendJson(res, 200, connectionsJson(connections));
      return;
    }
  }
}
