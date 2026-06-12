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
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

type Route =
  | { kind: 'list' }
  | { kind: 'set' }
  | { kind: 'delete'; provider: string };

function matchRoute(method: string, path: string): Route | null {
  if (path === '/api/orgs/credentials') {
    if (method === 'GET') return { kind: 'list' };
    if (method === 'POST') return { kind: 'set' };
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
  sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no key configured for that provider' });
  return true;
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
