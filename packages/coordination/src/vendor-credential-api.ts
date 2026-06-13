// BYOK vendor-credential API (slice 3.5-A). Routes (session-gated; mutations CSRF + ADMIN+):
//   GET    /api/orgs/credentials            — status + fingerprint per provider (NO key). member+.
//   POST   /api/orgs/credentials  {provider, key} — validate live → seal → store. admin+.
//   DELETE /api/orgs/credentials/:provider  — remove. admin+.
//
// WRITE-ONLY: no route ever returns the key. The plaintext is taken in on POST, validated, sealed, and
// dropped; it is never echoed, never logged, never read back. Reads return only status + fingerprint.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type RoleReader } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';
import type { GovernanceAuditSink } from './governance-audit';
import {
  isVendorProvider,
  sealVendorKey,
  fingerprintVendorKey,
  type VendorProvider,
  type VendorCredentialStore,
  type VendorKeyResolver,
  type VendorValidator,
} from './vendor-credential';

export interface VendorCredentialApiDeps {
  store: VendorCredentialStore;
  resolver: VendorKeyResolver; // for cache-bust on write/delete
  validator: VendorValidator;
  /** The env-held master key. ABSENT → the BYOK surface is disabled (503) — fail closed, never store
   *  a key we cannot seal. */
  masterKey: Buffer | null;
  membership: RoleReader;
  /** Governance audit trail (slice 3.5-A.2c.1). OPTIONAL: absent → no trail recorded and the audit
   *  read returns an empty list. The record write is best-effort relative to the credential op (the
   *  key is already sealed+stored) — a failed audit write is logged, never failing the credential op. */
  audit?: GovernanceAuditSink;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

type Route =
  | { kind: 'list' }
  | { kind: 'audit' }
  | { kind: 'set' }
  | { kind: 'delete'; provider: string };

function matchRoute(method: string, path: string): Route | null {
  if (path === '/api/orgs/credentials') {
    if (method === 'GET') return { kind: 'list' };
    if (method === 'POST') return { kind: 'set' };
    return null;
  }
  if (path === '/api/orgs/credentials/audit') {
    if (method === 'GET') return { kind: 'audit' };
    return null;
  }
  const m = /^\/api\/orgs\/credentials\/([^/]+)$/.exec(path);
  if (m && method === 'DELETE') return { kind: 'delete', provider: decodeURIComponent(m[1]!) };
  return null;
}

export async function vendorCredentialApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VendorCredentialApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors org-api) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('vendor-credential-api: session verification threw', { err: String(err) });
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

  // GET — status only (no key). Any member may see whether a key is configured (drives the
  // "no API key configured — ask an admin" UX for non-admins).
  if (route.kind === 'list') {
    sendJson(res, 200, { credentials: await deps.store.getVendorCredentialStatuses(orgId) });
    return true;
  }

  // GET /audit — the governance trail. ADMIN+ (governance-sensitive, gated like the write paths, not
  // like the member+ status GET); no CSRF (a read changes no state). Absent audit sink → empty list.
  if (route.kind === 'audit') {
    const role = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
    if (role === null || !atLeast(role, 'admin')) {
      sendJson(res, 403, { error: 'admin role required to view the credential audit trail' });
      return true;
    }
    const events = deps.audit ? await deps.audit.listGovernanceAudit(orgId, { limit: 50 }) : [];
    sendJson(res, 200, { events });
    return true;
  }

  // ── mutations: CSRF + ADMIN+ (keys are governance, slice 5b/D5) ──
  if (!verifyCsrf(req)) {
    sendJson(res, 403, { error: 'missing or invalid CSRF token' });
    return true;
  }
  const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
  if (callerRole === null || !atLeast(callerRole, 'admin')) {
    sendJson(res, 403, { error: 'admin role required to manage vendor keys' });
    return true;
  }
  // No master key configured → cannot seal; refuse rather than store an unsealable key.
  if (!deps.masterKey) {
    deps.logger?.error('vendor-credential-api: TASCA_SECRET_STORE_KEY not configured — cannot seal');
    sendJson(res, 503, { error: 'credential storage is not configured on this server' });
    return true;
  }

  if (route.kind === 'set') {
    const body = await readBody(req, res);
    if (body === undefined) return true;
    const provider = (body as { provider?: unknown }).provider;
    const key = (body as { key?: unknown }).key;
    if (typeof provider !== 'string' || !isVendorProvider(provider)) {
      sendJson(res, 400, { error: 'unsupported or missing provider' });
      return true;
    }
    if (typeof key !== 'string' || key.trim().length === 0) {
      sendJson(res, 400, { error: 'key is required' });
      return true;
    }
    const plaintext = key.trim();
    // VALIDATE LIVE before storing — never persist a key the vendor rejects.
    const verdict = await deps.validator.validate(provider, plaintext);
    if (!verdict.ok) {
      sendJson(res, 400, { error: verdict.reason, code: 'key_invalid' });
      return true;
    }
    const sealed = sealVendorKey(plaintext, deps.masterKey);
    const fingerprint = fingerprintVendorKey(provider, plaintext);
    await deps.store.setVendorCredential(orgId, provider, sealed, fingerprint, userId === '(dev)' ? null : userId);
    deps.resolver.invalidate(orgId, provider); // rotation takes effect immediately on this node
    // Governance trail: record the set with the fingerprint + status — NEVER the key. Best-effort:
    // the key is already sealed+stored, so a failed audit write must not turn this into a 500.
    await recordAudit(deps, orgId, userId, {
      action: 'credential.set',
      target: provider,
      payload: { fingerprint, status: 'active' },
    });
    // WRITE-ONLY response: status + fingerprint, never the key.
    sendJson(res, 200, { ok: true, provider, status: 'active', fingerprint });
    return true;
  }

  // DELETE /api/orgs/credentials/:provider
  if (!isVendorProvider(route.provider)) {
    sendJson(res, 400, { error: 'unsupported provider' });
    return true;
  }
  const removed = await deps.store.deleteVendorCredential(orgId, route.provider as VendorProvider);
  deps.resolver.invalidate(orgId, route.provider as VendorProvider);
  if (removed) {
    await recordAudit(deps, orgId, userId, { action: 'credential.delete', target: route.provider, payload: {} });
  }
  sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no key configured for that provider' });
  return true;
}

/** Best-effort governance-audit write: records the action when an audit sink is wired, and swallows a
 *  write failure into a logged error (the credential op already succeeded — its key is sealed+stored —
 *  so the audit trail must never be what fails the response). NEVER pass the raw key in `payload`. */
async function recordAudit(
  deps: VendorCredentialApiDeps,
  orgId: string,
  userId: string,
  e: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.recordGovernanceAudit(orgId, { actorUserId: userId, ...e });
  } catch (err) {
    deps.logger?.error('vendor-credential-api: governance audit write failed', {
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
