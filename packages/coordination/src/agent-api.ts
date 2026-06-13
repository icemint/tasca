// The create-agent API (slice Wizard-A) — the USER-FACING create flow for the roster. One route:
//   POST /api/agents  {name, vendor, model, avatarUrl?, maxTier?}  — mint a named agent, derive its
//     capability tier (so it is immediately routable), and AUTO-HIRE it into the caller's active org.
//
// Session-gated; CSRF on the POST; MEMBER+ (the schema's lowest role = product "User" has full agent
// CRUD). This is the user's OWN agent-CRUD — distinct from the admin-gated hire-an-EXISTING-agent in
// org-api (which changes which shared agents serve the org). Agents are KEYLESS (the org vault key runs
// them); vendor/model are metadata. DEFERRED: the capability editor + per-platform identity provisioning.
//
// ATOMICITY: create + profile + hire run in ONE transaction (the Pg creator owns a client and runs all
// three over it), so a partial failure leaves NO orphan global agent. The handler is HTTP-only — it
// validates input and calls the injected creator port; the tier math is pure (defaultTierForModel /
// tiersUpTo) and the persistence lives behind AgentCreator.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { TIERS, type Tier } from '@tasca/domain';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type RoleReader } from './membership';
import type { HireOutcome } from './roster';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';

/** The vendor set the agent table accepts (CHECK vendor IN ('claude','openai','local')). */
const VENDORS = ['claude', 'openai', 'local'] as const;
export type AgentVendor = (typeof VENDORS)[number];
const isVendor = (v: unknown): v is AgentVendor =>
  typeof v === 'string' && (VENDORS as readonly string[]).includes(v);
const isTier = (v: unknown): v is Tier =>
  typeof v === 'string' && (TIERS as readonly string[]).includes(v);

/** What a created+hired agent looks like to the caller. */
export interface CreatedAgentSummary {
  id: string;
  name: string;
  vendor: AgentVendor;
  model: string;
  maxTier: Tier;
}

/** The validated create request the creator port receives (HTTP already stripped + range-checked). */
export interface CreateAgentRequest {
  name: string;
  vendor: AgentVendor;
  model: string;
  avatarUrl?: string;
  maxTier: Tier;
}

/** Outcome of an atomic create+profile+hire. `ok` carries the created agent; the rest are the hire's
 *  fail-closed terminals (the agent was rolled back — no orphan). `not_found` would only arise from a
 *  vanished org and is mapped to 403; `already_hired` is unreachable for a freshly minted id but kept
 *  exhaustive. */
export type CreateAgentOutcome =
  | { ok: true; agent: CreatedAgentSummary }
  | { ok: false; reason: Exclude<HireOutcome, 'ok'> };

/**
 * Mint an agent + capability profile + auto-hire into `orgId`, ATOMICALLY. The implementation owns the
 * transaction so a hire failure rolls the just-minted agent back (no orphan global agent). Business
 * logic boundary: the handler hands it a fully validated request; it returns a domain outcome, never an
 * HTTP concern.
 */
export interface AgentCreator {
  create(orgId: string, req: CreateAgentRequest): Promise<CreateAgentOutcome>;
}

export interface AgentApiDeps {
  creator: AgentCreator;
  /** Resolve the caller's active org + role (the tenant boundary + the member+ gate). */
  membership: RoleReader;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /** Fail-closed escape hatch: no verifier wired → 503 unless explicitly opened (dev/tests only). */
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const NAME_MAX = 80;
const MODEL_MAX = 120;
const AVATAR_MAX = 500;

/**
 * A sensible DEFAULT capability tier derived from the model name — the value the user gets when they
 * don't pick one (and overrides). Substring match on the lowercased model; this is a heuristic default,
 * NOT a contract, so the table stays small and is the one place to tweak the mapping.
 */
export function defaultTierForModel(vendor: AgentVendor, model: string): Tier {
  const m = model.toLowerCase();
  if (vendor === 'claude') {
    if (m.includes('opus')) return 'ultra';
    if (m.includes('sonnet')) return 'hard';
    if (m.includes('haiku')) return 'low';
  }
  if (vendor === 'openai') {
    // gpt-4o-mini / gpt-3.5 are the cheap tier; o1 + the gpt-4 family are the capable tier. Order
    // matters: the cheap-mini check precedes the gpt-4 family check (gpt-4o-mini contains 'gpt-4').
    if (m.includes('gpt-3.5') || m.includes('gpt-4o-mini')) return 'low';
    if (m.includes('o1') || m.includes('gpt-4')) return 'hard';
  }
  // Unknown models and all local models default to the middle of the ladder.
  return 'medium';
}

/**
 * Every tier at or below `maxTier` on the ladder (basic < low < medium < hard < ultra). An `ultra` agent
 * covers all five; a `low` agent covers ['basic','low']. Keeps `tiers_covered` consistent with `max_tier`
 * so the routing engine's eligibility set is sane (an agent is eligible for any tier it covers).
 */
export function tiersUpTo(maxTier: Tier): Tier[] {
  const cap = TIERS.indexOf(maxTier);
  return TIERS.slice(0, cap + 1);
}

function matchRoute(method: string, path: string): 'create' | null {
  if (path === '/api/agents' && method === 'POST') return 'create';
  return null;
}

export async function agentApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  if (matchRoute(req.method, path) === null) return false;

  // ── session enforcement (mirrors org-api / vendor-credential-api) ────────────
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('agent-api: session verification threw', { err: String(err) });
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

  const orgId = await deps.membership.getActiveOrg(userId);
  if (orgId === null) {
    sendJson(res, 403, { error: 'no organization membership' });
    return true;
  }

  // ── mutation: CSRF double-submit ─────────────────────────────────────────────
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }

  // MEMBER+ gate: any real member of the active org may create their own agent (the schema's lowest
  // role = product "User" has full agent CRUD). Written explicitly so the gate is visible and a future
  // tighter role is a one-line change. dev (no session) = full access.
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner';
  if (callerRole === null || !atLeast(callerRole, 'member')) {
    sendJson(res, 403, { error: 'organization membership required to create an agent' });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return true;
  }

  const { name, vendor, model, avatarUrl, maxTier } = body as {
    name?: unknown;
    vendor?: unknown;
    model?: unknown;
    avatarUrl?: unknown;
    maxTier?: unknown;
  };

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName.length === 0 || trimmedName.length > NAME_MAX) {
    sendJson(res, 400, { error: `name (1–${NAME_MAX} chars) is required` });
    return true;
  }
  if (!isVendor(vendor)) {
    sendJson(res, 400, { error: 'vendor must be one of ' + VENDORS.join(', ') });
    return true;
  }
  const trimmedModel = typeof model === 'string' ? model.trim() : '';
  if (trimmedModel.length === 0 || trimmedModel.length > MODEL_MAX) {
    sendJson(res, 400, { error: `model (1–${MODEL_MAX} chars) is required` });
    return true;
  }
  if (avatarUrl !== undefined) {
    if (typeof avatarUrl !== 'string' || avatarUrl.length > AVATAR_MAX || !looksLikeUrl(avatarUrl)) {
      sendJson(res, 400, { error: `avatarUrl must be an http(s) URL (≤${AVATAR_MAX} chars)` });
      return true;
    }
  }
  if (maxTier !== undefined && !isTier(maxTier)) {
    sendJson(res, 400, { error: 'maxTier must be one of ' + TIERS.join(', ') });
    return true;
  }

  // Override beats the derived default: the explicit maxTier wins; otherwise derive from the model.
  const tier = maxTier !== undefined ? maxTier : defaultTierForModel(vendor, trimmedModel);

  try {
    const outcome = await deps.creator.create(orgId, {
      name: trimmedName,
      vendor,
      model: trimmedModel,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      maxTier: tier,
    });
    if (outcome.ok) {
      sendJson(res, 200, outcome.agent);
      return true;
    }
    // The hire could not attach the agent to the org — the agent was rolled back (no orphan). A
    // vanished org (not_found) maps to 403 (the caller's active org is gone); already_hired is
    // unreachable for a fresh id but maps to 409 defensively.
    if (outcome.reason === 'not_found') {
      sendJson(res, 403, { error: 'no organization membership' });
      return true;
    }
    sendJson(res, 409, { error: 'agent already hired', code: 'already_hired' });
    return true;
  } catch (err) {
    deps.logger?.error('agent-api: create failed', { orgId, err: String(err) });
    sendJson(res, 500, { error: 'internal error' });
    return true;
  }
}

/** Light URL check: http(s) origin parses. Not a deep validator — the avatar is cosmetic metadata. */
function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
