// The PM-assistant API (slice W3-S1) — the advisory layer's HTTP surface. The assistant only
// ever PROPOSES; accepting a proposal routes through an EXISTING org-scoped CAS-guarded binding
// method (acceptRoutingProposal → the same re-route a reassign performs). There is NO
// proposal-side write to task status / claim / routing_decision — the advisory guarantee is
// structural, not a comment.
//
// Every route is, exactly like the write-API:
//   - SESSION-gated (401 without a valid session);
//   - org-scoped + FAIL-CLOSED on membership (resolveOrg → 403 with no membership) — proposals
//     are tenant data, so a member of org A can never read/accept/dismiss org B's proposals
//     (the org-scoped store methods miss → not_found, which never leaks existence as a conflict);
//   - role-gated: these are task-intervention-level actions → member+ (5b);
//   - mutations CSRF-protected (double-submit);
//   - flag-gated: GENERATION is refused server-side when the PM-assistant flag is off (not just
//     hidden in the UI — the 5b gate-the-endpoint lesson).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Task } from '@tasca/domain';
import type { AdapterEvent } from '@tasca/contracts';
import { RoutingProposalSchema, TriageProposalSchema } from '@tasca/contracts';
import {
  proposeRoutingFailSoft,
  proposeTriageFailSoft,
  type PmProposerPort,
  type RoutingCandidate,
} from '@tasca/routing';
import type { CoordinationStore, ProposalWriteOutcome } from './store';
import type { AgentDirectory, TaskContentSource } from './orchestrate';
import type { OrgRosterRepo } from './roster';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { resolveOrg } from './resolve-org';
import { atLeast, type RoleReader } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';

export interface ProposalApiDeps {
  store: Pick<
    CoordinationStore,
    | 'listProposals'
    | 'getProposal'
    | 'createProposal'
    | 'dismissProposal'
    | 'acceptRoutingProposal'
    | 'acceptTriageProposal'
    | 'getTask'
  >;
  /** Resolves a session → its org (membership = tenant boundary, fail-closed) AND role (5b). */
  membership: RoleReader;
  /** The org's hired roster: candidate names for generation + name→hired-id resolution on accept
   *  (the routing accept fails closed if the proposed agent isn't hired). */
  roster: OrgRosterRepo;
  /** Candidate capability profiles for the proposer (the same source routing uses). */
  directory: Pick<AgentDirectory, 'listCandidates'>;
  /** The PM proposer (routing deterministic, triage = the tier engine). Absent → generation yields
   *  no proposal (the assistant is inert but never errors). */
  proposer?: PmProposerPort;
  /** Task content source (title/body/labels) — needed to triage a task (the routing kind uses the
   *  stored tier estimate and does not need content). Absent → triage generation yields no proposal. */
  content?: TaskContentSource;
  /** The PM-assistant feature flag. When false, the view renders its off-state and GENERATION is
   *  refused here server-side. Listing/accepting/dismissing EXISTING proposals still works. */
  enabled: boolean;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

type Route =
  | { kind: 'list' }
  | { kind: 'generate' }
  | { kind: 'accept'; id: string }
  | { kind: 'dismiss'; id: string };

function matchRoute(method: string, path: string): Route | null {
  if (path === '/api/proposals') {
    if (method === 'GET') return { kind: 'list' };
    return null;
  }
  if (path === '/api/proposals/generate') return method === 'POST' ? { kind: 'generate' } : null;
  const accept = /^\/api\/proposals\/([^/]+)\/accept$/.exec(path);
  if (accept && method === 'POST') return { kind: 'accept', id: decodeURIComponent(accept[1]!) };
  const dismiss = /^\/api\/proposals\/([^/]+)\/dismiss$/.exec(path);
  if (dismiss && method === 'POST') return { kind: 'dismiss', id: decodeURIComponent(dismiss[1]!) };
  return null;
}

/** Map a ProposalWriteOutcome to an HTTP response. `agent_not_hired` is the routing fail-closed
 *  branch (the proposed agent isn't on the org's roster) — a 409, NEVER a route to an unhired
 *  agent. `not_found` (absent/another org) is distinct from `conflict` (already handled), and a
 *  cross-org id resolves to `not_found`, never leaking existence as a conflict. */
function sendProposalOutcome(res: ServerResponse, outcome: ProposalWriteOutcome): void {
  if (outcome.ok) return sendJson(res, 200, { ok: true });
  if (outcome.reason === 'not_found') return sendJson(res, 404, { error: 'proposal not found' });
  if (outcome.reason === 'agent_not_hired') {
    return sendJson(res, 409, { error: 'the proposed agent is not hired by this org', code: 'agent_not_hired' });
  }
  return sendJson(res, 409, { error: 'proposal already handled or its task moved', code: 'conflict' });
}

export async function proposalApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProposalApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors the read/write API) ────────────────────────
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('proposal-api: session verification threw', { err: String(err) });
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

  // Org from membership — FAIL-CLOSED: a verified user with no membership → 403, before any read.
  const orgId = await resolveOrg(deps.membership, session);
  if (orgId === null) {
    sendJson(res, 403, { error: 'no organization membership' });
    return true;
  }
  // Role gate (5b): proposals are task-intervention-level → member+. Authenticated only; the
  // dev/no-auth path keeps full access (consistent with resolveOrg's DEFAULT edge).
  if (session) {
    const role = await deps.membership.getRole(session.userId, orgId);
    if (role === null || !atLeast(role, 'member')) {
      sendJson(res, 403, { error: 'insufficient role for this action' });
      return true;
    }
  }

  try {
    // GET /api/proposals — list (no CSRF; read). `enabled` drives the view's off/on state.
    if (route.kind === 'list') {
      const proposals = await deps.store.listProposals(orgId, { status: 'pending' });
      sendJson(res, 200, { proposals, enabled: deps.enabled });
      return true;
    }

    // ── mutations: CSRF double-submit ─────────────────────────────────────────
    if (!verifyCsrf(req)) {
      sendJson(res, 403, { error: 'missing or invalid CSRF token' });
      return true;
    }

    if (route.kind === 'generate') {
      // FLAG-GATE generation server-side — never trust the UI to hide it.
      if (!deps.enabled) {
        sendJson(res, 403, { error: 'the PM assistant is not enabled', code: 'pm_disabled' });
        return true;
      }
      await handleGenerate(req, res, deps, orgId);
      return true;
    }
    if (route.kind === 'accept') {
      await handleAccept(res, deps, orgId, route.id);
      return true;
    }
    // dismiss
    sendProposalOutcome(res, await deps.store.dismissProposal(orgId, route.id));
    return true;
  } catch (err) {
    deps.logger?.error('proposal-api: handler failed', { path, err: String(err) });
    sendJson(res, 500, { error: 'internal error' });
    return true;
  }
}

/** Generate a proposal for a task (on-demand). `kind` selects routing (uses the stored tier
 *  estimate + hired candidates) or triage (fetches content + runs the tier engine). Both proposers
 *  are fail-soft, so any failure → no proposal (200 with proposal:null), never an error and never a
 *  task write. */
async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProposalApiDeps,
  orgId: string
): Promise<void> {
  let body: { taskId?: unknown; kind?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return;
  }
  const taskId = body.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    sendJson(res, 400, { error: 'taskId is required' });
    return;
  }
  const kind = body.kind === undefined ? 'routing' : body.kind;
  if (kind !== 'routing' && kind !== 'triage') {
    sendJson(res, 400, { error: "kind must be 'routing' or 'triage'" });
    return;
  }
  const task = await deps.store.getTask(orgId, taskId);
  if (!task) {
    sendJson(res, 404, { error: 'task not found' });
    return;
  }
  if (!deps.proposer) {
    sendJson(res, 200, { proposal: null }); // no proposer wired → honestly no suggestion
    return;
  }

  if (kind === 'triage') {
    const payload = await generateTriage(deps, task);
    if (!payload) {
      sendJson(res, 200, { proposal: null });
      return;
    }
    const proposal = await deps.store.createProposal(orgId, {
      kind: 'triage',
      targetTaskId: task.id,
      targetVersion: task.version,
      payload,
    });
    sendJson(res, 200, { proposal });
    return;
  }

  // routing
  if (!task.tierEstimate) {
    sendJson(res, 200, { proposal: null }); // not yet estimated → honestly no routing suggestion
    return;
  }
  const candidates = await buildCandidates(deps, orgId, task);
  const payload = await proposeRoutingFailSoft(deps.proposer, {
    task: { title: task.externalStoryId, body: '' }, // the deterministic proposer ranks by estimate+candidates
    estimate: task.tierEstimate,
    candidates,
  });
  if (!payload) {
    sendJson(res, 200, { proposal: null });
    return;
  }
  const proposal = await deps.store.createProposal(orgId, {
    kind: 'routing',
    targetTaskId: task.id,
    targetVersion: task.version,
    payload,
  });
  sendJson(res, 200, { proposal });
}

/** Triage generation: fetch the task's real content, run the (fail-soft) tier-engine proposer. A
 *  content-fetch failure or an absent content source → no proposal (never throws, never writes). */
async function generateTriage(deps: ProposalApiDeps, task: Task) {
  if (!deps.content || !deps.proposer) return null;
  const event: AdapterEvent = {
    type: 'task.assigned',
    platform: task.platform,
    externalStoryId: task.externalStoryId,
    agentExternalId: '',
    ...(task.repoRef ? { repoHint: task.repoRef } : {}),
  };
  let content: { title: string; body: string; labels?: string[] };
  try {
    content = await deps.content.fetch(event);
  } catch {
    return null; // content fetch failed → fail-soft, no suggestion
  }
  return proposeTriageFailSoft(deps.proposer, {
    task: { title: content.title, body: content.body, ...(content.labels ? { labels: content.labels } : {}) },
  });
}

/** Accept a routing proposal: resolve its agent name to a HIRED id (fail closed if unhired), then
 *  run the binding write (acceptRoutingProposal: CAS proposal + set preference + re-route). */
async function handleAccept(
  res: ServerResponse,
  deps: ProposalApiDeps,
  orgId: string,
  id: string
): Promise<void> {
  const proposal = await deps.store.getProposal(orgId, id);
  if (!proposal) {
    sendJson(res, 404, { error: 'proposal not found' });
    return;
  }

  if (proposal.kind === 'routing') {
    const parsed = RoutingProposalSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      sendJson(res, 409, { error: 'proposal payload is malformed', code: 'conflict' });
      return;
    }
    // Resolve the proposed NAME to a HIRED agent id (org-scoped). Unhired/unknown → fail closed,
    // NEVER a route to an unhired agent — the 5d boundary, enforced before any write.
    const agentId = await deps.roster.findHiredAgentByName(orgId, parsed.data.agentName);
    if (!agentId) {
      sendProposalOutcome(res, { ok: false, reason: 'agent_not_hired' });
      return;
    }
    sendProposalOutcome(res, await deps.store.acceptRoutingProposal(orgId, id, agentId));
    return;
  }

  if (proposal.kind === 'triage') {
    const parsed = TriageProposalSchema.safeParse(proposal.payload);
    if (!parsed.success) {
      sendJson(res, 409, { error: 'proposal payload is malformed', code: 'conflict' });
      return;
    }
    // The ONLY binding write a triage accept reaches is acceptTriageProposal → the overrideTierEstimate
    // tier write (version-fenced, done-guarded). No status/claim/routing write.
    sendProposalOutcome(res, await deps.store.acceptTriageProposal(orgId, id, parsed.data.tier));
    return;
  }

  // decomposition/standup accepts land in 1c/1d.
  sendJson(res, 400, { error: 'this proposal kind cannot be accepted yet', code: 'unsupported_kind' });
}

/** Join the directory's candidate profiles with the roster's display names into the proposer's
 *  input shape. Only agents that are BOTH hired (have a name) and routable candidates are included. */
async function buildCandidates(deps: ProposalApiDeps, orgId: string, task: Task): Promise<RoutingCandidate[]> {
  const [matches, hired] = await Promise.all([
    deps.directory.listCandidates(orgId, task),
    deps.roster.listHired(orgId),
  ]);
  const nameById = new Map(hired.map((h) => [h.agentId, h.name]));
  const out: RoutingCandidate[] = [];
  for (const m of matches) {
    const name = nameById.get(m.profile.agentId);
    if (!name) continue; // not on the roster (shouldn't happen — candidates ARE the hired set)
    out.push({ agentId: m.profile.agentId, name, profile: m.profile, state: m.state, activeCount: m.activeCount });
  }
  return out;
}
