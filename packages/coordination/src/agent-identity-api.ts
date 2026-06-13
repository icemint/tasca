// Per-agent platform identity API (slice SC-3). Configures an agent's NATIVE Shortcut identity + its
// own Agent-User token, so the status reporter can post to a story AS the agent. One route:
//   POST /api/orgs/:orgId/agents/:agentId/identity/shortcut  {memberId, token, handle?}  — admin+.
//
// WRITE-ONLY: the token is taken in on POST, sealed, and dropped; it is NEVER echoed, NEVER logged,
// NEVER read back. The response carries only a fingerprint + ok.
//
// Gating order mirrors vendor-credential-api / agent-api EXACTLY:
//   session → 401, getActiveOrg → 403, path-org must equal the active org → 403, CSRF → 403,
//   role admin+ → 403, master key present → 503, agent hired in this org → 404.
// admin+ because this is identity/credential GOVERNANCE (matching the vendor-key set-endpoint), not a
// member-level action.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type RoleReader } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';
import type { GovernanceAuditSink } from './governance-audit';
import {
  sealVendorKey,
  fingerprintAgentKey,
  type AgentCredentialStore,
  type AgentCredentialResolver,
} from './vendor-credential';

/** The binding upsert seam (the @tasca/identity repo's upsertBinding, narrowed to what we set). */
export interface IdentityBindingWriter {
  upsertBinding(input: {
    agentId: string;
    platform: 'shortcut';
    externalId: string;
    externalHandle?: string;
    credentialRef?: string;
    state?: 'active';
  }): Promise<unknown>;
}

/** Confirms an agent is hired into an org (the org-ownership gate). */
export interface OrgAgentReader {
  isHired(orgId: string, agentId: string): Promise<boolean>;
}

export interface AgentIdentityApiDeps {
  store: AgentCredentialStore;
  resolver: Pick<AgentCredentialResolver, 'invalidate'>; // cache-bust on write
  identity: IdentityBindingWriter;
  roster: OrgAgentReader;
  /** The env-held master key. ABSENT → the credential surface is disabled (503) — fail closed. */
  masterKey: Buffer | null;
  membership: RoleReader;
  /** Governance audit trail. Best-effort relative to the credential op (already sealed+stored). */
  audit?: GovernanceAuditSink;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const MEMBER_ID_MAX = 200;
const TOKEN_MAX = 4096;
const HANDLE_MAX = 80;

/** `POST /api/orgs/:orgId/agents/:agentId/identity/shortcut` → the path org + agent, or null. */
function matchRoute(method: string, path: string): { orgId: string; agentId: string } | null {
  if (method !== 'POST') return null;
  const m = /^\/api\/orgs\/([^/]+)\/agents\/([^/]+)\/identity\/shortcut$/.exec(path);
  if (!m) return null;
  return { orgId: decodeURIComponent(m[1]!), agentId: decodeURIComponent(m[2]!) };
}

export async function agentIdentityApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentIdentityApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors vendor-credential-api / agent-api) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('agent-identity-api: session verification threw', { err: String(err) });
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

  const activeOrg = await deps.membership.getActiveOrg(userId);
  if (activeOrg === null) {
    sendJson(res, 403, { error: 'no organization membership' });
    return true;
  }
  // The path org MUST be the caller's active org — never let a caller act on another tenant's agent by
  // naming a different org in the URL (fail closed on tenant ambiguity).
  if (route.orgId !== activeOrg) {
    sendJson(res, 403, { error: 'org mismatch' });
    return true;
  }
  const orgId = activeOrg;

  // ── mutation: CSRF + ADMIN+ (identity/credential governance) ──
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
  if (callerRole === null || !atLeast(callerRole, 'admin')) {
    sendJson(res, 403, { error: 'admin role required to manage agent identities' });
    return true;
  }
  // No master key → cannot seal; refuse rather than store an unsealable token.
  if (!deps.masterKey) {
    deps.logger?.error('agent-identity-api: TASCA_SECRET_STORE_KEY not configured — cannot seal');
    sendJson(res, 503, { error: 'credential storage is not configured on this server' });
    return true;
  }
  // The agent must be hired into THIS org — a 404 (not 403) so a caller can't probe other orgs' agents.
  if (!(await deps.roster.isHired(orgId, route.agentId))) {
    sendJson(res, 404, { error: 'no such agent in this organization' });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return true;
  }
  const { memberId, token, handle } = body as { memberId?: unknown; token?: unknown; handle?: unknown };

  if (typeof memberId !== 'string' || memberId.trim().length === 0 || memberId.trim().length > MEMBER_ID_MAX) {
    sendJson(res, 400, { error: `memberId (1–${MEMBER_ID_MAX} chars) is required` });
    return true;
  }
  if (typeof token !== 'string' || token.trim().length === 0 || token.trim().length > TOKEN_MAX) {
    sendJson(res, 400, { error: `token (1–${TOKEN_MAX} chars) is required` });
    return true;
  }
  if (handle !== undefined && (typeof handle !== 'string' || handle.length > HANDLE_MAX)) {
    sendJson(res, 400, { error: `handle must be a string (≤${HANDLE_MAX} chars)` });
    return true;
  }
  const trimmedMemberId = memberId.trim();
  const trimmedToken = token.trim();

  // Seal the token (never persist plaintext) + a non-reversible fingerprint for display/dedup.
  const sealed = sealVendorKey(trimmedToken, deps.masterKey);
  const fingerprint = fingerprintAgentKey('shortcut', trimmedToken);
  await deps.store.setAgentCredential(
    orgId,
    route.agentId,
    'shortcut',
    sealed,
    fingerprint,
    userId === '(dev)' ? null : userId
  );
  deps.resolver.invalidate(orgId, route.agentId, 'shortcut'); // a re-set takes effect immediately on this node

  // Upsert the identity_binding row (the projection of the agent's native Shortcut identity). The
  // credential_ref is a STRUCTURED POINTER into the per-agent vault — never the token. The credential is
  // already sealed+stored above; if the binding write throws it surfaces as a 500 (the projection the
  // caller expects didn't land) — better than a silent half-write.
  await deps.identity.upsertBinding({
    agentId: route.agentId,
    platform: 'shortcut',
    externalId: trimmedMemberId,
    ...(handle !== undefined ? { externalHandle: handle } : {}),
    credentialRef: `org_agent_cred:${orgId}:${route.agentId}:shortcut`,
    state: 'active',
  });

  // Governance trail: record the set with the fingerprint — NEVER the token. Best-effort (the
  // credential + binding already landed, so a failed audit write must not turn this into a 500).
  await recordAudit(deps, orgId, userId, {
    action: 'agent.identity.shortcut.set',
    target: route.agentId,
    payload: { memberId: trimmedMemberId, fingerprint },
  });

  // WRITE-ONLY response: ok + fingerprint, never the token.
  sendJson(res, 200, { ok: true, agentId: route.agentId, provider: 'shortcut', fingerprint });
  return true;
}

/** Best-effort governance-audit write (mirrors vendor-credential-api): the credential op already
 *  succeeded, so a write failure is logged, never failing the response. NEVER pass the raw token. */
async function recordAudit(
  deps: AgentIdentityApiDeps,
  orgId: string,
  userId: string,
  e: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.recordGovernanceAudit(orgId, { actorUserId: userId, ...e });
  } catch (err) {
    deps.logger?.error('agent-identity-api: governance audit write failed', {
      orgId,
      action: e.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
