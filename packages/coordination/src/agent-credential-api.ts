// Per-agent platform-credential API (slice SC-3-B). Manages an agent's OWN platform tokens (its
// GitHub token + its Shortcut Agent-User token) so it acts on a ticket/PR AS ITSELF. Routes (all under
// /api/orgs/:orgId/agents/:agentId/credentials):
//   GET    .../credentials                — status + fingerprint per provider (NO token). member+.
//   POST   .../credentials  {provider, token} — validate live → seal → store. admin+.
//   DELETE .../credentials/:provider      — remove. admin+.
//   POST   .../credentials/:provider/test {token} — live-probe the submitted token (pre-save). admin+.
//
// WRITE-ONLY: no route ever returns a token. The plaintext is taken in on POST/test, validated, and on
// POST sealed + dropped; it is never echoed, never logged, never read back. Reads return only status +
// fingerprint. /test validates the SUBMITTED (just-entered) token — it never unseals a stored one.
//
// Gating order mirrors agent-identity-api / vendor-credential-api EXACTLY:
//   session → 401, getActiveOrg → 403, path-org must equal the active org → 403, CSRF → 403 (mutations
//   + /test), role gate (GET member+, POST/DELETE/test admin+), master key present → 503 (set + the
//   disabled-surface routes /test + DELETE), agent hired in this org → 404 (NOT 403 — a 404 keeps a
//   caller from enumerating another org's agents).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type RoleReader } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';
import type { GovernanceAuditSink } from './governance-audit';
import type { OrgAgentReader } from './agent-identity-api';
import {
  isAgentCredentialProvider,
  sealVendorKey,
  fingerprintAgentKey,
  type AgentCredentialProvider,
  type AgentCredentialStore,
  type AgentCredentialResolver,
  type AgentCredentialValidator,
} from './vendor-credential';

export interface AgentCredentialApiDeps {
  store: AgentCredentialStore;
  resolver: Pick<AgentCredentialResolver, 'invalidate'>; // cache-bust on write/delete
  validator: AgentCredentialValidator;
  roster: OrgAgentReader;
  /** The env-held master key. ABSENT → the credential surface is disabled (503) — fail closed. */
  masterKey: Buffer | null;
  membership: RoleReader;
  /** Governance audit trail. Best-effort relative to the credential op (already sealed+stored/removed). */
  audit?: GovernanceAuditSink;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

const TOKEN_MAX = 4096;

type Route =
  | { kind: 'list'; orgId: string; agentId: string }
  | { kind: 'set'; orgId: string; agentId: string }
  | { kind: 'delete'; orgId: string; agentId: string; provider: string }
  | { kind: 'test'; orgId: string; agentId: string; provider: string };

function matchRoute(method: string, path: string): Route | null {
  const base = /^\/api\/orgs\/([^/]+)\/agents\/([^/]+)\/credentials$/.exec(path);
  if (base) {
    const orgId = decodeURIComponent(base[1]!);
    const agentId = decodeURIComponent(base[2]!);
    if (method === 'GET') return { kind: 'list', orgId, agentId };
    if (method === 'POST') return { kind: 'set', orgId, agentId };
    return null;
  }
  const test = /^\/api\/orgs\/([^/]+)\/agents\/([^/]+)\/credentials\/([^/]+)\/test$/.exec(path);
  if (test && method === 'POST') {
    return {
      kind: 'test',
      orgId: decodeURIComponent(test[1]!),
      agentId: decodeURIComponent(test[2]!),
      provider: decodeURIComponent(test[3]!),
    };
  }
  const del = /^\/api\/orgs\/([^/]+)\/agents\/([^/]+)\/credentials\/([^/]+)$/.exec(path);
  if (del && method === 'DELETE') {
    return {
      kind: 'delete',
      orgId: decodeURIComponent(del[1]!),
      agentId: decodeURIComponent(del[2]!),
      provider: decodeURIComponent(del[3]!),
    };
  }
  return null;
}

export async function agentCredentialApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentCredentialApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors agent-identity-api / vendor-credential-api) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('agent-credential-api: session verification threw', { err: String(err) });
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

  // GET — status only (no token). Any member may see which platform credentials are configured (drives
  // the "no credential configured — ask an admin" UX for non-admins).
  if (route.kind === 'list') {
    sendJson(res, 200, { credentials: await deps.store.getAgentCredentialStatuses(orgId, route.agentId) });
    return true;
  }

  // ── mutations + /test: CSRF + ADMIN+ (credentials are governance) ──
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
  if (callerRole === null || !atLeast(callerRole, 'admin')) {
    sendJson(res, 403, { error: 'admin role required to manage agent credentials' });
    return true;
  }
  // No master key → the credential surface is disabled (set cannot seal; /test + DELETE present a
  // coherent disabled UX). Refuse rather than imply a half-working surface.
  if (!deps.masterKey) {
    deps.logger?.error('agent-credential-api: TASCA_SECRET_STORE_KEY not configured — credential surface disabled');
    sendJson(res, 503, { error: 'credential storage is not configured on this server' });
    return true;
  }
  // The agent must be hired into THIS org — a 404 (not 403) so a caller can't probe other orgs' agents.
  if (!(await deps.roster.isHired(orgId, route.agentId))) {
    sendJson(res, 404, { error: 'no such agent in this organization' });
    return true;
  }

  // POST .../credentials/:provider/test — live-probe the SUBMITTED token (pre-save). Never unseals a
  // stored token; never persists. Returns {ok} or {ok:false, reason} (the reason is a fixed curated
  // string — never the token, never the raw upstream body).
  if (route.kind === 'test') {
    if (!isAgentCredentialProvider(route.provider)) {
      sendJson(res, 400, { error: 'unsupported provider' });
      return true;
    }
    const body = await readBody(req, res);
    if (body === undefined) return true;
    const token = (body as { token?: unknown }).token;
    if (typeof token !== 'string' || token.trim().length === 0 || token.trim().length > TOKEN_MAX) {
      sendJson(res, 400, { error: `token (1–${TOKEN_MAX} chars) is required` });
      return true;
    }
    const verdict = await deps.validator.validate(route.provider, token.trim());
    sendJson(res, 200, verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason });
    return true;
  }

  if (route.kind === 'set') {
    const body = await readBody(req, res);
    if (body === undefined) return true;
    const provider = (body as { provider?: unknown }).provider;
    const token = (body as { token?: unknown }).token;
    // Validate the provider BEFORE any use so it can never be interpolated raw into a probe URL.
    if (typeof provider !== 'string' || !isAgentCredentialProvider(provider)) {
      sendJson(res, 400, { error: 'unsupported or missing provider' });
      return true;
    }
    if (typeof token !== 'string' || token.trim().length === 0 || token.trim().length > TOKEN_MAX) {
      sendJson(res, 400, { error: `token (1–${TOKEN_MAX} chars) is required` });
      return true;
    }
    const plaintext = token.trim();
    // VALIDATE LIVE before storing — never persist a token the platform rejects. On !ok the store is
    // left untouched (validate-before-persist).
    const verdict = await deps.validator.validate(provider, plaintext);
    if (!verdict.ok) {
      sendJson(res, 400, { error: verdict.reason, code: 'key_invalid' });
      return true;
    }
    const sealed = sealVendorKey(plaintext, deps.masterKey);
    const fingerprint = fingerprintAgentKey(provider, plaintext);
    await deps.store.setAgentCredential(orgId, route.agentId, provider, sealed, fingerprint, userId === '(dev)' ? null : userId);
    deps.resolver.invalidate(orgId, route.agentId, provider); // a re-set takes effect immediately on this node
    // Governance trail: record the set with the fingerprint + status — NEVER the token. Best-effort:
    // the token is already sealed+stored, so a failed audit write must not turn this into a 500.
    await recordAudit(deps, orgId, userId, {
      action: 'agent.credential.set',
      target: `${route.agentId}:${provider}`,
      payload: { provider, fingerprint, status: 'active' },
    });
    // WRITE-ONLY response: provider + fingerprint, never the token.
    sendJson(res, 200, { ok: true, provider, fingerprint });
    return true;
  }

  // DELETE .../credentials/:provider — the row delete + resolver.invalidate is the revocation. NOTE
  // (multi-node): invalidate busts only THIS node's cache, so on a multi-worker fleet a removed token
  // can still be served by another node for up to the resolver TTL (~60s) — see the AgentCredentialResolver
  // KNOWN LIMITATION in vendor-credential.ts. Single-node dispatch (today) has no such window.
  if (!isAgentCredentialProvider(route.provider)) {
    sendJson(res, 400, { error: 'unsupported provider' });
    return true;
  }
  const removed = await deps.store.deleteAgentCredential(orgId, route.agentId, route.provider as AgentCredentialProvider);
  deps.resolver.invalidate(orgId, route.agentId, route.provider as AgentCredentialProvider);
  if (removed) {
    await recordAudit(deps, orgId, userId, {
      action: 'agent.credential.delete',
      target: `${route.agentId}:${route.provider}`,
      payload: { provider: route.provider },
    });
  }
  sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no credential configured for that provider' });
  return true;
}

/** Best-effort governance-audit write (mirrors agent-identity-api): the credential op already
 *  succeeded, so a write failure is logged, never failing the response. NEVER pass the raw token. */
async function recordAudit(
  deps: AgentCredentialApiDeps,
  orgId: string,
  userId: string,
  e: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.recordGovernanceAudit(orgId, { actorUserId: userId, ...e });
  } catch (err) {
    deps.logger?.error('agent-credential-api: governance audit write failed', {
      orgId,
      action: e.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read + JSON-parse the body; on malformed input send 400 and return undefined (mirrors org-api). */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  try {
    return await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'invalid body' });
    return undefined;
  }
}
