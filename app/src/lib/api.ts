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
  CredentialAuditResponse,
  HiredAgentsResponse,
  InvitesResponse,
  MembersResponse,
  NewAgentInput,
  NewAgentResponse,
  OrgInfo,
  OrgRole,
  OrgsResponse,
  ProjectsResponse,
  ProposalsResponse,
  ProposalSummary,
  StandupSummary,
  SessionResponse,
  TaskDetail,
  TaskSummary,
  VendorCredentialsResponse,
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

/** The app home a logged-in user lands on (mirrors the worker's APP_HOME + AppShell's home link). */
export const APP_HOME = '/roster';

/**
 * Inverse of the island session gate: on the LOGIN page (`/`), if a real session already exists, go
 * straight into the app. Without this, a user the worker just authenticated (its success callback 302s
 * into the app, but a logged-in user landing on `/` directly otherwise never asks /api/auth/me) would
 * see the sign-in screen. Uses location.replace so the login page is not left in history. Returns true
 * if it redirected.
 */
export async function redirectIfAuthenticated(home: string = APP_HOME): Promise<boolean> {
  const session = await getSession();
  if (session.kind === 'ok' && session.data.authenticated === true) {
    if (typeof location !== 'undefined') location.replace(home);
    return true;
  }
  return false;
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
export const getConnections = () => get<ConnectionsResponse>('/api/connections');

// ── write endpoints (mutations) ───────────────────────────────────────────────
// Mutations go straight to the worker (never the DEV fixtures — there is nothing to
// mutate there). They inherit the worker's write-security harness: a double-submit
// CSRF token (GET /api/csrf → cookie + body) echoed in the x-csrf-token header.
// Every distinct failure is classified so a control can tell the truth: an 'unauth'
// redirects, a 'conflict' (409) reconciles to server truth, an 'unconfigured' (503)
// disables, an 'error' rolls back — a write NEVER silently leaves the UI lying.

export type WriteResult<T = unknown> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauth' } // 401 — session gone; redirect to login
  | { kind: 'forbidden' } // 403 — CSRF still invalid after a refresh
  | { kind: 'conflict'; data: T } // 409 — body carries the current truth (e.g. currentVersion)
  | { kind: 'notfound' } // 404
  | { kind: 'unconfigured' } // 503 — writes not enabled on the worker
  | { kind: 'error'; message: string };

let csrfToken: string | null = null;

/** Test-only: clear the cached CSRF token so each test starts from a clean slate. */
export function _resetCsrfForTest(): void {
  csrfToken = null;
}

/** Fetch (and cache) the double-submit CSRF token. `force` re-fetches after a 403
 *  (the token rotated/expired). Returns null if it can't be obtained. */
export async function ensureCsrf(force = false): Promise<string | null> {
  if (csrfToken && !force) return csrfToken;
  try {
    const res = await fetch('/api/csrf', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    csrfToken = typeof body.token === 'string' ? body.token : null;
    return csrfToken;
  } catch {
    return null;
  }
}

async function classify<T>(res: Response): Promise<WriteResult<T>> {
  if (res.status === 200) {
    try {
      return { kind: 'ok', data: (await res.json()) as T };
    } catch {
      return { kind: 'error', message: 'Malformed response' };
    }
  }
  if (res.status === 401) return { kind: 'unauth' };
  if (res.status === 403) return { kind: 'forbidden' };
  if (res.status === 404) return { kind: 'notfound' };
  if (res.status === 409) {
    // Mirror the 200 branch: an UNPARSEABLE 409 body (a proxy error page, a truncated
    // response) is an honest 'error', NOT a fabricated `{conflict, data:{}}`. Fabricating a
    // conflict would let the UI render a definite "not available in the current state" (or,
    // for agent writes, a NaN version) for what is actually a transport/unknown failure — a
    // lie. Only a body that parses becomes a conflict, carrying its real `code`/`currentVersion`.
    try {
      return { kind: 'conflict', data: (await res.json()) as T };
    } catch {
      return { kind: 'error', message: 'Malformed response' };
    }
  }
  if (res.status === 503) return { kind: 'unconfigured' };
  return { kind: 'error', message: `Request failed (${res.status})` };
}

/** POST a mutation with CSRF. On a 403 (stale token) it refreshes the token and
 *  retries ONCE, so an expired CSRF self-heals instead of failing the user. */
export async function post<T>(path: string, body: unknown): Promise<WriteResult<T>> {
  let token = await ensureCsrf();
  if (token === null) return { kind: 'error', message: 'Could not obtain a security token' };
  const send = (t: string): Promise<Response> =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t },
      body: JSON.stringify(body),
    });
  let res: Response;
  try {
    res = await send(token);
    if (res.status === 403) {
      const fresh = await ensureCsrf(true);
      if (fresh) res = await send(fresh);
    }
  } catch {
    return { kind: 'error', message: 'Network unreachable' };
  }
  return classify<T>(res);
}

// ── agent-state writes ────────────────────────────────────────────────────────

interface AgentWriteOk {
  ok: true;
  version: number;
}
interface AgentConflict {
  error: string;
  currentVersion: number;
}

export const pauseAgent = (id: string, version: number) =>
  post<AgentWriteOk | AgentConflict>(`/api/agents/${encodeURIComponent(id)}/pause`, { version });
export const resumeAgent = (id: string, version: number) =>
  post<AgentWriteOk | AgentConflict>(`/api/agents/${encodeURIComponent(id)}/resume`, { version });
export const editAgentProfile = (
  id: string,
  version: number,
  patch: {
    maxTier: string;
    concurrencyLimit: number | null;
    costCeiling: number | null;
    tiersCovered?: string[];
    languageSpecialties?: string[];
    frameworkSpecialties?: string[];
    // Identity fields (Slice D's form). Optional + preserve-if-absent: send only what changed.
    // `description` = agent.md instructions (stored; not yet wired into the run — see issue 362).
    name?: string;
    vendor?: 'claude' | 'openai' | 'local';
    model?: string;
    avatarUrl?: string | null;
    description?: string | null;
  }
) => post<AgentWriteOk | AgentConflict>(`/api/agents/${encodeURIComponent(id)}/profile`, { version, ...patch });

// ── task interventions (cancel-coupled writes) ────────────────────────────────
// Reassign re-routes a task (cancelling a live run first); Interrupt halts a live run
// and flags it. The 200 body carries the resulting status; a 409 body carries a `code`
// that tells the three "couldn't apply" truths apart — `too_late` (the agent already
// finished), `no_inflight` (running in-process, no job to cancel), or a generic `conflict`.

export interface TaskWriteOk {
  ok: true;
  status: string;
}
export interface TaskWriteConflict {
  error: string;
  code: 'conflict' | 'too_late' | 'no_inflight';
}

export const reassignTask = (id: string) =>
  post<TaskWriteOk | TaskWriteConflict>(`/api/tasks/${encodeURIComponent(id)}/reassign`, {});
export const interruptTask = (id: string) =>
  post<TaskWriteOk | TaskWriteConflict>(`/api/tasks/${encodeURIComponent(id)}/interrupt`, {});
// Force-clear a STUCK task (issue 317): when a run wedges in executing/claimed with no live job,
// interrupt/reassign dead-end (no_inflight) — this releases the claim → needs_attention. Admin-only
// server-side; a non-admin gets 403 (surfaced honestly by the caller's describe).
export const forceResetTask = (id: string) =>
  post<TaskWriteOk | TaskWriteConflict>(`/api/tasks/${encodeURIComponent(id)}/force-reset`, {});

// ── PM-assistant proposals (slice W3-S1) — advisory; accept routes through routing ─────

export const getProposals = () => get<ProposalsResponse>('/api/proposals');
/** Generate a suggestion for a task (on-demand). `kind` = routing (uses the stored estimate) or
 *  triage (the tier engine). 200 with `{proposal}` (possibly null when there's no suggestion). */
export const generateProposal = (taskId: string, kind: 'routing' | 'triage' | 'decomposition' = 'routing') =>
  post<{ proposal: ProposalSummary | null }>(`/api/proposals/generate`, { taskId, kind });
/** Generate a READ-ONLY standup (org-wide; nothing persisted, no accept). */
export const generateStandup = () =>
  post<{ standup: StandupSummary }>(`/api/proposals/generate`, { kind: 'standup' });
/** Accept a proposal — routes through the binding method (re-route to the proposed agent). */
export const acceptProposal = (id: string) =>
  post<{ ok: true } | { error: string; code?: string }>(`/api/proposals/${encodeURIComponent(id)}/accept`, {});
/** Dismiss a proposal — marks the suggestion handled; no binding effect. */
export const dismissProposal = (id: string) =>
  post<{ ok: true } | { error: string; code?: string }>(`/api/proposals/${encodeURIComponent(id)}/dismiss`, {});

// ── org self-serve: connect a workspace + hire/unhire agents (slice W4-S3) ─────
// Admin+ controls. The SERVER is the authority (5b gate); the UI uses `canManageActiveOrg`
// only to render an honest disabled state instead of a button that 403s.

/** DELETE a mutation with CSRF (mirrors `post`: self-heals a stale token once on a 403). */
export async function del<T>(path: string): Promise<WriteResult<T>> {
  let token = await ensureCsrf();
  if (token === null) return { kind: 'error', message: 'Could not obtain a security token' };
  const send = (t: string): Promise<Response> =>
    fetch(path, { method: 'DELETE', headers: { 'x-csrf-token': t } });
  let res: Response;
  try {
    res = await send(token);
    if (res.status === 403) {
      const fresh = await ensureCsrf(true);
      if (fresh) res = await send(fresh);
    }
  } catch {
    return { kind: 'error', message: 'Network unreachable' };
  }
  return classify<T>(res);
}

export const getOrgs = () => get<OrgsResponse>('/api/orgs');

/** True when the caller is admin+ in their ACTIVE org. Fail-closed: any read failure → false
 *  (render the control disabled rather than falsely enabled). The server still gates the write. */
export async function canManageActiveOrg(): Promise<boolean> {
  const res = await getOrgs();
  if (res.kind !== 'ok') return false;
  const active = res.data.orgs.find((o) => o.active) ?? res.data.orgs[0];
  return !!active && (active.role === 'admin' || active.role === 'owner');
}

// ── workspace settings (slice 3.5-B.2: instance name + members/roles) ──────────
// Name read is member+; rename is admin+; member list is member+; set-role / remove are owner-only
// (the server enforces all of it). A 409 `code:'last_owner'` on set-role/remove arrives via the
// conflict channel (classify parses 409 bodies), so the view can show the specific guard message.

/** The caller's active org — its name + the caller's role. */
export const getOrgInfo = () => get<OrgInfo>('/api/org');
/** Rename the active workspace (admin+; server-gated). */
export const renameOrg = (name: string) => post<{ ok: true; name: string } | { error: string }>('/api/org/name', { name });
/** The active org's members (member+). */
export const getMembers = () => get<MembersResponse>('/api/orgs/members');
/** Change a member's role (owner-only; server-gated). A last-owner refusal is a 409 `code:'last_owner'`. */
export const setMemberRole = (userId: string, role: OrgRole) =>
  post<{ ok: true } | { error: string; code?: string }>(`/api/orgs/members/${encodeURIComponent(userId)}/role`, { role });
/** Remove a member (owner-only; server-gated). A last-owner refusal is a 409 `code:'last_owner'`. */
export const removeMember = (userId: string) =>
  del<{ ok: true } | { error: string; code?: string }>(`/api/orgs/members/${encodeURIComponent(userId)}`);

// ── invites (slice 3.5-B.3.2: invite a teammate by email + role) ───────────────
// Create / list / revoke are admin+ (the server gates; the UI cap on the role <select> is a
// UX nicety, never the boundary). Accept is POSSESSION-based: any logged-in identity may accept
// — the invite email need NOT match. A 403 (inviting above your role) / 400 (bad email/role) ride
// the existing forbidden/error channels; a used/invalid accept token is a 409 conflict.

/** Invite a teammate. On ok the response carries the copyable single-use accept link (so it works
 *  even without email configured). 403 = inviting above your own role; 400 = a bad email/role. */
export const createInvite = (email: string, role: OrgRole) =>
  post<{ ok: true; email: string; role: OrgRole; acceptUrl: string } | { error: string }>('/api/invites', { email, role });
/** The org's pending invites (admin+) — never carries a token. */
export const getInvites = () => get<InvitesResponse>('/api/invites');
/** Revoke a pending invite (admin+; 404 if already gone). */
export const revokeInvite = (id: string) => del<{ ok: true } | { error: string }>('/api/invites/' + encodeURIComponent(id));
/** Accept an invite by its single-use token (any logged-in identity). 409 = invalid/already used. */
export const acceptInvite = (token: string) =>
  post<{ ok: true; orgId: string; role: OrgRole } | { error: string }>('/api/invites/accept', { token });

export const getHiredAgents = () => get<HiredAgentsResponse>('/api/orgs/agents');

// ── create an agent (slice Wizard-B) — member+ (any org member). On ok the agent is
// created AND auto-hired into the caller's active org, so it joins the roster at once.
// A validation failure is a 400 → the shared `classify` collapses it to an opaque
// 'error'; this helper lifts a parseable 400 into the `conflict` channel so the view
// can surface the server's specific message (mirrors `setVendorCredential`).
export async function createAgent(input: NewAgentInput): Promise<WriteResult<NewAgentResponse>> {
  let token = await ensureCsrf();
  if (token === null) return { kind: 'error', message: 'Could not obtain a security token' };
  const send = (t: string): Promise<Response> =>
    fetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t },
      body: JSON.stringify(input),
    });
  let res: Response;
  try {
    res = await send(token);
    if (res.status === 403) {
      const fresh = await ensureCsrf(true);
      if (fresh) res = await send(fresh);
    }
  } catch {
    return { kind: 'error', message: 'Network unreachable' };
  }
  // A validation failure (400, parseable) surfaces via the conflict channel so the view can read
  // the server's `error`. An unparseable 400 stays an honest 'error' (never a fabricated conflict).
  if (res.status === 400) {
    try {
      return { kind: 'conflict', data: (await res.json()) as NewAgentResponse };
    } catch {
      return { kind: 'error', message: 'Malformed response' };
    }
  }
  return classify<NewAgentResponse>(res);
}

export const hireAgent = (agentId: string) =>
  post<{ ok: true } | { error: string; code?: string }>('/api/orgs/agents', { agentId });
export const unhireAgent = (agentId: string) =>
  del<{ ok: true } | { error: string }>(`/api/orgs/agents/${encodeURIComponent(agentId)}`);

// ── per-org vendor credentials (slice 3.5-A.2c.2: Settings "Vendor keys") ──────
// The stored key is WRITE-ONLY: the read + audit shapes never carry it, and `set`
// validates the key live before sealing (a bad key → 400 code:'key_invalid'). All
// reads are member+; all writes + the audit read are admin+ (the server enforces it).

/** Read the org's vendor-credential statuses (no key — status + fingerprint only). */
export const getVendorCredentials = () => get<VendorCredentialsResponse>('/api/orgs/credentials');

type VendorSetBody =
  | { ok: true; provider: string; status: 'active'; fingerprint: string }
  | { error: string; code?: string };

/**
 * Set (or replace) the org's key for a provider. The server VALIDATES the key live before sealing
 * it — a rejected key is a 400 `{error, code:'key_invalid'}`. The shared `classify` collapses a 400
 * to an opaque 'error' (it only parses 409 bodies); for this surface the caller needs the
 * `key_invalid` code so the UI can say "the vendor rejected it" rather than a generic failure. So
 * this helper mirrors `post` (CSRF + one self-healing 403 retry) but additionally lifts a parseable
 * 400 into the `conflict` channel carrying its code — leaving the shared write path untouched.
 * The key is WRITE-ONLY: it is sent once and never echoed back.
 */
export async function setVendorCredential(provider: string, key: string): Promise<WriteResult<VendorSetBody>> {
  let token = await ensureCsrf();
  if (token === null) return { kind: 'error', message: 'Could not obtain a security token' };
  const send = (t: string): Promise<Response> =>
    fetch('/api/orgs/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t },
      body: JSON.stringify({ provider, key }),
    });
  let res: Response;
  try {
    res = await send(token);
    if (res.status === 403) {
      const fresh = await ensureCsrf(true);
      if (fresh) res = await send(fresh);
    }
  } catch {
    return { kind: 'error', message: 'Network unreachable' };
  }
  // A live-rejected key (400, parseable) surfaces via the conflict channel so the view can read
  // its `code`. An unparseable 400 stays an honest 'error' (never a fabricated conflict).
  if (res.status === 400) {
    try {
      return { kind: 'conflict', data: (await res.json()) as VendorSetBody };
    } catch {
      return { kind: 'error', message: 'Malformed response' };
    }
  }
  return classify<VendorSetBody>(res);
}
/** Remove the org's key for a provider. */
export const deleteVendorCredential = (provider: string) =>
  del<{ ok: true } | { error: string }>(`/api/orgs/credentials/${encodeURIComponent(provider)}`);
/** Read the credential governance audit trail (admin+; newest first). */
export const getCredentialAudit = () => get<CredentialAuditResponse>('/api/orgs/credentials/audit');

/** Begin the GitHub App install/connect flow (slice 5c). A REDIRECT-OUT (session+admin gated
 *  server-side), NOT an in-page write — the browser leaves to GitHub and returns via the Setup URL. */
export function connectGitHub(): void {
  if (typeof location !== 'undefined') location.assign('/api/connect/github');
}

// ── project switcher (slice Project-B) ────────────────────────────────────────
// The active project is a finer task-view filter WITHIN the org (the read API filters by it
// server-side). The list read carries which one is active; switch/clear are member+ CSRF writes.

/** The active org's projects + which one is active (null = the "All projects" view). */
export const getProjects = () => get<ProjectsResponse>('/api/projects');

/** Switch the active project (server-validated in-org; a foreign/unknown id → notfound). */
export const setActiveProject = (projectId: string) =>
  post<{ ok: true; activeProjectId: string }>('/api/active-project', { projectId });

/** Clear the active project → the cross-project "All projects" view (idempotent). */
export const clearActiveProject = () =>
  del<{ ok: true; activeProjectId: null }>('/api/active-project');
