// The human write-API: PM/operator interventions the authenticated app issues as
// POSTs (the read-API's mutating sibling). A CLEAN, ADDITIVE module — server.ts
// delegates to `writeApiHandler` next to the read handler, in a non-overlapping
// spot, so the branches merge without conflict.
//
// Every write is:
//   - SESSION-gated (same verifier as the read API) — 401 without a valid session;
//   - CSRF-protected via double-submit — a `tasca_csrf` cookie must equal the
//     `x-csrf-token` header (a forged cross-site POST can't read the cookie to echo
//     it); GET /api/csrf issues the pair;
//   - AUDITED — every attempt + outcome is recorded through the injected sink;
//   - mapped from a typed store outcome to an HTTP status (200 / 404 / 409).
//
// Auth posture mirrors the read API: a verifier MUST be wired, else fail closed
// (503) — never silently accept a mutation without authentication.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { TIERS, isLanguageSpecialty, isFrameworkSpecialty, type Tier, type AgentStatus } from '@tasca/domain';
import type { AgentWriteOutcome, CapabilityProfilePatch } from '@tasca/identity';
import type { CoordinationStore, TaskWriteOutcome } from './store';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { resolveOrg } from './resolve-org';
import { atLeast, type OrgRole, type RoleReader } from './membership';
import { sendJson, readJsonBody, issueCsrfToken, verifyCsrf } from './http-util';

/** The agent-write surface the write-API needs (a subset of PgIdentityRepository). */
export interface AgentWriter {
  setAgentStatus(agentId: string, status: AgentStatus, expectedVersion: number): Promise<AgentWriteOutcome>;
  updateCapabilityProfile(agentId: string, patch: CapabilityProfilePatch, expectedVersion: number): Promise<AgentWriteOutcome>;
}

/** Records a human-initiated write for the audit trail. */
export interface WriteAuditSink {
  record(entry: {
    userId: string;
    action: string;
    target: string;
    outcome: string;
    payload?: Record<string, unknown>;
  }): Promise<void> | void;
}

export interface WriteApiDeps {
  store: Pick<CoordinationStore, 'escalateTask' | 'overrideTierEstimate' | 'reassignTask' | 'interruptTask' | 'forceResetTask'>;
  /** Agent-state writes (pause/resume/edit-profile). Absent → those routes 404. */
  identity?: AgentWriter;
  /** Resolves a verified session's user to their org (slice 4 RBAC) AND their role in it (slice 5b).
   *  Membership (resolveOrg → the active org) is the tenant boundary: a member of org A acting on a
   *  B-task resolves to A and the org-scoped UPDATE misses (404). The ROLE then gates the action
   *  WITHIN the org (getRole): task interventions need member+, roster writes need admin+. Both
   *  layers are server-side and additive — neither bypasses the other. */
  membership: RoleReader;
  /** Verify the request's session (same contract as the read API). */
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /** Fail-closed escape hatch — when no verifier is wired, refuse (503) unless this
   *  is explicitly set (local dev/tests only). NOT keyed on NODE_ENV. */
  allowUnauthenticated?: boolean;
  /** Audit sink for human writes. Optional — absent → audit is logged only. */
  audit?: WriteAuditSink;
  /** Marks the CSRF cookie `Secure` (prod, https). Default true; set false for http dev. */
  secureCookies?: boolean;
  logger?: Logger;
}

type WriteRoute =
  | { kind: 'csrf' }
  | { kind: 'escalate'; id: string }
  | { kind: 'retier'; id: string }
  | { kind: 'reassign'; id: string }
  | { kind: 'interrupt'; id: string }
  | { kind: 'force_reset'; id: string }
  | { kind: 'pause'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'profile'; id: string };

/**
 * The minimum role each gated write requires (slice 5b). Task interventions are a member-level
 * action; agent/roster writes (pause/resume/edit-profile) are roster management → admin+.
 * force_reset force-discards a wedged run mid-flight (a roster/operator-grade recovery,
 * stronger than the graceful member-level interrupt) → admin+.
 */
const WRITE_ROUTE_MIN_ROLE: Record<Exclude<WriteRoute, { kind: 'csrf' }>['kind'], OrgRole> = {
  escalate: 'member',
  retier: 'member',
  reassign: 'member',
  interrupt: 'member',
  force_reset: 'admin',
  pause: 'admin',
  resume: 'admin',
  profile: 'admin',
};

function matchWriteRoute(method: string, path: string): WriteRoute | null {
  if (method === 'GET' && path === '/api/csrf') return { kind: 'csrf' };
  if (method !== 'POST') return null;
  const task = /^\/api\/tasks\/([^/]+)\/(escalate|retier|reassign|interrupt|force-reset)$/.exec(path);
  if (task) {
    const id = decodeURIComponent(task[1]!);
    const action = task[2]!;
    if (action === 'escalate') return { kind: 'escalate', id };
    if (action === 'retier') return { kind: 'retier', id };
    if (action === 'interrupt') return { kind: 'interrupt', id };
    if (action === 'force-reset') return { kind: 'force_reset', id };
    return { kind: 'reassign', id };
  }
  const agent = /^\/api\/agents\/([^/]+)\/(pause|resume|profile)$/.exec(path);
  if (agent) {
    const id = decodeURIComponent(agent[1]!);
    return { kind: agent[2] as 'pause' | 'resume' | 'profile', id };
  }
  return null;
}

/** Map a store TaskWriteOutcome to an HTTP response. The three non-ok "couldn't apply"
 *  reasons all return 409 but each carries a distinct machine-readable `code`, so the UI
 *  reconciles to the TRUTH of what happened — "already finished" (too_late) is NEVER
 *  conflated with "running in-process" (no_inflight) or a generic state conflict. The
 *  returned string is also the audit outcome, so the three are distinct in the audit log. */
function sendOutcome(res: ServerResponse, outcome: TaskWriteOutcome): string {
  if (outcome.ok) {
    sendJson(res, 200, { ok: true, status: outcome.status });
    return `ok:${outcome.status}`;
  }
  if (outcome.reason === 'not_found') {
    sendJson(res, 404, { error: 'task not found' });
    return 'not_found';
  }
  const message =
    outcome.reason === 'too_late'
      ? 'the agent already finished — showing the result'
      : outcome.reason === 'no_inflight'
        ? 'this run can’t be interrupted (it is running in-process)'
        : 'action not allowed in the task’s current state';
  sendJson(res, 409, { error: message, code: outcome.reason });
  return outcome.reason;
}

/** Map a versioned AgentWriteOutcome to an HTTP response. A version_conflict returns
 *  409 WITH the current version so the client reconciles to truth (never overwrites). */
function sendAgentOutcome(res: ServerResponse, outcome: AgentWriteOutcome): string {
  if (outcome.ok) {
    sendJson(res, 200, { ok: true, version: outcome.version });
    return `ok:v${outcome.version}`;
  }
  if (outcome.reason === 'not_found') {
    sendJson(res, 404, { error: 'agent not found' });
    return 'not_found';
  }
  sendJson(res, 409, { error: 'agent was changed by someone else', currentVersion: outcome.currentVersion });
  return 'version_conflict';
}

/**
 * Handle a write-API request. Returns `true` when it owned the request (so the
 * caller stops), `false` otherwise. Owns GET /api/csrf and POST /api/tasks/:id/{escalate,retier,reassign,interrupt}.
 */
export async function writeApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WriteApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const url = new URL(req.url, 'http://localhost');
  const route = matchWriteRoute(req.method, url.pathname);
  if (!route) return false;

  // GET /api/csrf — issue the double-submit token (cookie + body). Public-but-harmless:
  // the token only authorizes a write WHEN paired with a valid session below.
  if (route.kind === 'csrf') {
    const token = issueCsrfToken(res, { secure: deps.secureCookies !== false });
    sendJson(res, 200, { token });
    return true;
  }

  // ── session enforcement (mirrors the read API) ──────────────────────────────
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('write-api: session verification threw', { err: String(err) });
      sendJson(res, 401, { authenticated: false });
      return true;
    }
    if (!session) {
      sendJson(res, 401, { authenticated: false });
      return true;
    }
  } else if (!deps.allowUnauthenticated) {
    sendJson(res, 503, { error: 'auth not configured' });
    return true;
  }
  const userId = session?.userId ?? '(dev)';
  // Resolve the org this write acts in from the user's membership (slice 4 RBAC). A verified user
  // with NO membership fails CLOSED (403). Every task write below is org-scoped to the resolved
  // org, so an operator can only ever mutate their own tenant's tasks (a cross-tenant target 404s).
  const orgId = await resolveOrg(deps.membership, session);
  if (orgId === null) {
    sendJson(res, 403, { error: 'no organization membership' });
    return true;
  }

  // ── CSRF double-submit ──────────────────────────────────────────────────────
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }

  // ── role gate (slice 5b) — ADDITIVE over the membership/tenant gate above ────
  // Membership (resolveOrg) already proved the user belongs to `orgId`; now check their ROLE in
  // that org meets the action's minimum. Authenticated requests only — the dev/no-auth path
  // (session null, allowUnauthenticated) keeps full access, consistent with resolveOrg's DEFAULT.
  if (session) {
    const role = await deps.membership.getRole(session.userId, orgId);
    if (role === null || !atLeast(role, WRITE_ROUTE_MIN_ROLE[route.kind])) {
      sendJson(res, 403, { error: 'insufficient role for this action' });
      return true;
    }
  }

  try {
    await handleWrite(route, req, res, deps, userId, orgId);
  } catch (err) {
    deps.logger?.error('write-api: handler failed', { path: url.pathname, err: String(err) });
    sendJson(res, 500, { error: 'internal error' });
  }
  return true;
}

async function handleWrite(
  route: Exclude<WriteRoute, { kind: 'csrf' }>,
  req: IncomingMessage,
  res: ServerResponse,
  deps: WriteApiDeps,
  userId: string,
  orgId: string
): Promise<void> {
  const audit = async (action: string, outcome: string, payload?: Record<string, unknown>) => {
    deps.logger?.info?.('write-api: human write', { userId, action, target: route.id, outcome, ...payload });
    try {
      await deps.audit?.record({ userId, action, target: route.id, outcome, ...(payload ? { payload } : {}) });
    } catch (err) {
      deps.logger?.error('write-api: audit sink threw', { err: String(err) });
    }
  };

  switch (route.kind) {
    case 'escalate': {
      const outcome = await deps.store.escalateTask(orgId, route.id);
      await audit('task.escalate', sendOutcome(res, outcome));
      return;
    }
    case 'reassign': {
      const outcome = await deps.store.reassignTask(orgId, route.id);
      await audit('task.reassign', sendOutcome(res, outcome));
      return;
    }
    case 'interrupt': {
      const outcome = await deps.store.interruptTask(orgId, route.id);
      await audit('task.interrupt', sendOutcome(res, outcome));
      return;
    }
    case 'force_reset': {
      const outcome = await deps.store.forceResetTask(orgId, route.id);
      await audit('task.force_reset', sendOutcome(res, outcome));
      return;
    }
    case 'retier': {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid body' });
        await audit('task.retier', 'bad_request');
        return;
      }
      const tier = (body as { tier?: unknown }).tier;
      if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier)) {
        sendJson(res, 400, { error: 'tier must be one of ' + TIERS.join(', ') });
        await audit('task.retier', 'bad_request');
        return;
      }
      const outcome = await deps.store.overrideTierEstimate(orgId, route.id, tier as Tier);
      await audit('task.retier', sendOutcome(res, outcome), { tier });
      return;
    }
    case 'pause':
    case 'resume':
    case 'profile': {
      if (!deps.identity) {
        // 503 (not 404): the agent exists/readable — agent writes just aren't wired.
        // The client maps 503 → an honest "actions aren't enabled" message, whereas
        // 404 would wrongly tell the user the agent no longer exists.
        sendJson(res, 503, { error: 'agent writes not configured' });
        return;
      }
      let body: {
        version?: unknown; maxTier?: unknown; concurrencyLimit?: unknown; costCeiling?: unknown;
        tiersCovered?: unknown; languageSpecialties?: unknown; frameworkSpecialties?: unknown;
      };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'invalid body' });
        await audit(`agent.${route.kind}`, 'bad_request');
        return;
      }
      // Optimistic concurrency: the client MUST send the version it last saw.
      if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 0) {
        sendJson(res, 400, { error: 'version (integer) is required' });
        await audit(`agent.${route.kind}`, 'bad_request');
        return;
      }
      if (route.kind === 'profile') {
        const { maxTier, concurrencyLimit, costCeiling } = body;
        if (typeof maxTier !== 'string' || !(TIERS as readonly string[]).includes(maxTier)) {
          sendJson(res, 400, { error: 'maxTier must be one of ' + TIERS.join(', ') });
          await audit('agent.profile', 'bad_request');
          return;
        }
        if (!isIntOrNull(concurrencyLimit) || !isIntOrNull(costCeiling)) {
          sendJson(res, 400, { error: 'concurrencyLimit and costCeiling must be an integer or null' });
          await audit('agent.profile', 'bad_request');
          return;
        }
        // Optional capability fields (the editor's tier-range + structured specialties). The server
        // is the authority: specialties MUST come from the @tasca/domain taxonomy (not free text),
        // and a covered tier may not exceed maxTier. Absent fields are left unchanged downstream.
        const langs = cleanSpecialties(body.languageSpecialties, isLanguageSpecialty);
        const frameworks = cleanSpecialties(body.frameworkSpecialties, isFrameworkSpecialty);
        const tiers = cleanTiersCovered(body.tiersCovered, maxTier as Tier);
        if (langs === 'invalid' || frameworks === 'invalid' || tiers === 'invalid') {
          sendJson(res, 400, { error: 'specialties must come from the known taxonomy; tiersCovered must be valid tiers ≤ maxTier' });
          await audit('agent.profile', 'bad_request');
          return;
        }
        const outcome = await deps.identity.updateCapabilityProfile(
          route.id,
          {
            maxTier: maxTier as Tier,
            concurrencyLimit,
            costCeiling,
            ...(tiers !== undefined ? { tiersCovered: tiers } : {}),
            ...(langs !== undefined ? { languageSpecialties: langs } : {}),
            ...(frameworks !== undefined ? { frameworkSpecialties: frameworks } : {}),
          },
          body.version
        );
        await audit('agent.profile', sendAgentOutcome(res, outcome), {
          maxTier,
          concurrencyLimit,
          costCeiling,
          ...(tiers !== undefined ? { tiersCovered: tiers } : {}),
          ...(langs !== undefined ? { languageSpecialties: langs } : {}),
          ...(frameworks !== undefined ? { frameworkSpecialties: frameworks } : {}),
        });
        return;
      }
      const status: AgentStatus = route.kind === 'pause' ? 'paused' : 'active';
      const outcome = await deps.identity.setAgentStatus(route.id, status, body.version);
      await audit(`agent.${route.kind}`, sendAgentOutcome(res, outcome), { status });
      return;
    }
  }
}

/** True for an integer or explicit null (the editable numeric profile fields). */
function isIntOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v));
}

/** Validate an optional specialty array against a domain-taxonomy guard. Returns undefined when the
 *  field was absent (→ leave unchanged), 'invalid' on any non-taxonomy entry, else the deduped list. */
function cleanSpecialties(v: unknown, guard: (s: string) => boolean): string[] | undefined | 'invalid' {
  if (v === undefined) return undefined;
  // Bound the work before walking/stringifying: a valid set can't exceed the taxonomy size, so a
  // long array is malformed (dupes/garbage) — reject it rather than process an unbounded payload.
  if (!Array.isArray(v) || v.length > 64) return 'invalid';
  if (v.some((x) => typeof x !== 'string' || !guard(x))) return 'invalid';
  return [...new Set(v as string[])];
}

/** Validate an optional tiers-covered array. Each entry must be a known tier and not exceed maxTier
 *  (a covered tier above the cap is incoherent). Returns undefined when absent, 'invalid' on a bad
 *  entry, else the deduped list. */
function cleanTiersCovered(v: unknown, maxTier: Tier): Tier[] | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > TIERS.length) return 'invalid';
  const maxIdx = TIERS.indexOf(maxTier);
  const out: Tier[] = [];
  for (const t of v) {
    if (typeof t !== 'string' || !(TIERS as readonly string[]).includes(t)) return 'invalid';
    if (TIERS.indexOf(t as Tier) > maxIdx) return 'invalid';
    out.push(t as Tier);
  }
  return [...new Set(out)];
}
