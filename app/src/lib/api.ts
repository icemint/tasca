// Typed read-API client. Same-origin RELATIVE URLs only (`/api/...`): nginx
// reverse-proxies `/api/` to the coordination worker, so the session cookie is
// sent automatically — no CORS, no absolute api host, no credentials:'include'.
//
// Errors are classified so each island can render an honest state:
//   - 'unauth'  → 401 or {authenticated:false}  → redirect to the login page (/)
//   - 'error'   → network failure / 5xx / bad JSON → error state
//   - 'ok'      → parsed body
//
// In DEV the client serves from dev-fixtures instead of the network, so every
// screen renders before the real API exists. The fixtures path is gated behind
// `import.meta.env.DEV`, which Vite statically replaces with `false` in the
// production build — so the dynamic import is dead-code-eliminated and the
// fixtures module is NEVER bundled or served in prod. (`?mock=1` is a DEV-only
// override; `?mock=0` opts a DEV page back onto the real network.)

import type {
  Agent,
  AgentDetail,
  ConnectionsResponse,
  RoutingDecision,
  SessionResponse,
  TaskDetail,
  TaskSummary,
} from './contract';

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauth' }
  | { kind: 'error'; message: string };

/**
 * True when fixtures should be used. Only ever true in a DEV build — the whole
 * branch is behind `import.meta.env.DEV`, so production tree-shakes it away.
 * `?mock=0` opts a DEV page back onto the real network.
 */
export function useMock(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '0') {
    return false;
  }
  return true;
}

async function get<T>(path: string): Promise<ApiResult<T>> {
  // DEV-only fixtures path. Gated on import.meta.env.DEV so the dynamic import is
  // eliminated from the production bundle (dev-fixtures never ships).
  if (import.meta.env.DEV && useMock()) {
    try {
      const { resolveFixture } = await import('./dev-fixtures');
      return { kind: 'ok', data: resolveFixture(path) as T };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : 'fixture error' };
    }
  }

  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    return { kind: 'error', message: 'Network unreachable' };
  }

  if (res.status === 401) return { kind: 'unauth' };
  if (!res.ok) return { kind: 'error', message: `Request failed (${res.status})` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', message: 'Malformed response' };
  }

  // The session contract also signals unauth via a body flag (not only 401).
  if (body && typeof body === 'object' && (body as { authenticated?: boolean }).authenticated === false) {
    return { kind: 'unauth' };
  }
  return { kind: 'ok', data: body as T };
}

// ── session ───────────────────────────────────────────────────────────────────

/** Resolve the current session. On unauth, callers redirect to `/`. */
export async function getSession(): Promise<ApiResult<SessionResponse>> {
  return get<SessionResponse>('/api/auth/me');
}

/** Redirect to the login page. Centralized so islands share one behavior. */
export function redirectToLogin(): void {
  if (typeof location !== 'undefined') location.assign('/');
}

// ── read endpoints ──────────────────────────────────────────────────────────

export const getAgents = () => get<Agent[]>('/api/agents');
export const getAgent = (id: string) => get<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`);
export const getTasks = (params?: { status?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.limit !== undefined) q.set('limit', String(params.limit));
  const qs = q.toString();
  return get<TaskSummary[]>(`/api/tasks${qs ? `?${qs}` : ''}`);
};
export const getTask = (id: string) => get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
export const getRoutingDecisions = (limit?: number) =>
  get<RoutingDecision[]>(`/api/routing-decisions${limit !== undefined ? `?limit=${limit}` : ''}`);
export const getConnections = () => get<ConnectionsResponse>('/api/connections');
