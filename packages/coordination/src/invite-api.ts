// The org-invite API (slice 3.5-B.3.1). Routes (mirroring vendor-credential-api's shape):
//   POST   /api/invites          {email, role} — mint a single-use invite link. ADMIN+; CSRF.
//   GET    /api/invites                        — list the active org's pending invites (no tokens). ADMIN+.
//   DELETE /api/invites/:id                     — revoke a pending invite. ADMIN+; CSRF.
//   POST   /api/invites/accept   {token}        — accept (enroll the session user). ANY session; CSRF.
//
// Security model: an invite is a possession-based capability to JOIN an org. The token is minted here,
// hashed-at-rest in the store, and returned ONCE in the create response (the creator is authorized to
// see it) + emailed. Creation is admin-gated with a PRIVILEGE CAP — the invited role may not exceed the
// inviter's role. Accept is authenticated (the session = the joining identity) but does NOT match the
// session's email against the invite email — possession of the token IS the authorization. Accept
// failures are collapsed into ONE generic non-enumerating message.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import { atLeast, type OrgRole } from './membership';
import { sendJson, readJsonBody, verifyCsrf } from './http-util';
import { mintInviteToken, hashToken, type InviteStore } from './invite';
import { sendInviteEmail } from './email';

/** The membership surface the invite API needs: resolve the active org + the caller's role (the admin
 *  gate + the privilege cap), and the active org's display name (for the email body). */
export interface InviteMembership {
  getActiveOrg(userId: string): Promise<string | null>;
  getRole(userId: string, orgId: string): Promise<OrgRole | null>;
  getOrgName(orgId: string): Promise<string | null>;
}

export interface InviteApiDeps {
  store: InviteStore;
  membership: InviteMembership;
  /** The app origin the accept link is built against (the OAuth redirect base / app origin). The raw
   *  token is appended here for the create response — resolved at the composition root, never in a handler. */
  acceptBaseUrl: string;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

/** Invites live 7 days from creation. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];
const isRole = (v: unknown): v is OrgRole => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

// A simple, conservative email shape check (≤254 chars, one @, non-empty local + domain with a dot). The
// invite email is informational (never matched on accept), so this only guards against obvious junk.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isPlausibleEmail = (v: unknown): v is string => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);

type Route =
  | { kind: 'create' }
  | { kind: 'list' }
  | { kind: 'accept' }
  | { kind: 'revoke'; id: string };

function matchRoute(method: string, path: string): Route | null {
  if (path === '/api/invites') {
    if (method === 'POST') return { kind: 'create' };
    if (method === 'GET') return { kind: 'list' };
    return null;
  }
  if (path === '/api/invites/accept') return method === 'POST' ? { kind: 'accept' } : null;
  const m = /^\/api\/invites\/([^/]+)$/.exec(path);
  if (m && method === 'DELETE') return { kind: 'revoke', id: decodeURIComponent(m[1]!) };
  return null;
}

export async function inviteApiHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InviteApiDeps
): Promise<boolean> {
  if (req.url === undefined || req.method === undefined) return false;
  const path = new URL(req.url, 'http://localhost').pathname;
  const route = matchRoute(req.method, path);
  if (!route) return false;

  // ── session enforcement (mirrors vendor-credential-api / org-api) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('invite-api: session verification threw', { err: String(err) });
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

  try {
    const orgId = await deps.membership.getActiveOrg(userId);
    if (orgId === null) {
      sendJson(res, 403, { error: 'no organization membership' });
      return true;
    }

    // ── all invite routes mutate or list state → CSRF on the writes; the GET list is admin-gated below. ──
    if (route.kind !== 'list' && !verifyCsrf(req)) {
      sendJson(res, 403, { error: 'missing or invalid CSRF token' });
      return true;
    }

    // ── ACCEPT — any authenticated session may accept (possession of the token IS the authorization). No
    //    admin gate; the session's email is NOT compared to the invite email. ──
    if (route.kind === 'accept') {
      const body = await readBody(req, res);
      if (body === undefined) return true;
      const token = (body as { token?: unknown }).token;
      if (typeof token !== 'string' || token.length === 0) {
        sendJson(res, 400, { error: 'token is required' });
        return true;
      }
      const result = await deps.store.acceptInvite(hashToken(token), userId);
      if (result.kind === 'ok') {
        sendJson(res, 200, { ok: true, orgId: result.orgId, role: result.role });
        return true;
      }
      // NON-ENUMERATING: 'invalid' (no such token) and 'consumed' (revoked/expired/used) collapse into one
      // generic message — a caller can never tell which, so a token cannot be probed.
      sendJson(res, 409, { error: 'this invite link is invalid or already used' });
      return true;
    }

    // ── the remaining routes (create / list / revoke) are ADMIN+ on the active org. ──
    const callerRole = session ? await deps.membership.getRole(userId, orgId) : 'owner'; // dev = full access
    if (callerRole === null || !atLeast(callerRole, 'admin')) {
      sendJson(res, 403, { error: 'admin role required to manage invites' });
      return true;
    }

    if (route.kind === 'list') {
      sendJson(res, 200, { invites: await deps.store.listPendingInvites(orgId) });
      return true;
    }

    if (route.kind === 'revoke') {
      const revoked = await deps.store.revokeInvite(orgId, route.id);
      sendJson(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: 'no such pending invite' });
      return true;
    }

    // create
    const body = await readBody(req, res);
    if (body === undefined) return true;
    const { email, role } = body as { email?: unknown; role?: unknown };
    if (!isPlausibleEmail(email)) {
      sendJson(res, 400, { error: 'a valid email is required' });
      return true;
    }
    if (!isRole(role)) {
      sendJson(res, 400, { error: 'role must be one of ' + ROLES.join(', ') });
      return true;
    }
    // PRIVILEGE CAP: the invited role may not exceed the inviter's. An admin cannot mint an owner/admin
    // above itself — only an owner can invite an owner. (callerRole is admin+ here by the gate above.)
    if (!atLeast(callerRole, role)) {
      sendJson(res, 403, { error: 'cannot invite at a role above your own' });
      return true;
    }

    const token = mintInviteToken();
    await deps.store.createInvite(orgId, {
      email,
      role,
      tokenHash: hashToken(token),
      invitedBy: userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    const acceptUrl = `${deps.acceptBaseUrl}/invite?token=${token}`;
    // Best-effort email (the link is also in this response). The inviter email is informational; fall back
    // to the user id when there is no richer identity to hand (dev / no session).
    const orgName = (await deps.membership.getOrgName(orgId)) ?? 'your workspace';
    await sendInviteEmail({ to: email, acceptUrl, orgName, inviterEmail: userId }, deps.logger);
    // The raw token is in the URL — the creator IS authorized to see it (single-use + expiring).
    sendJson(res, 200, { ok: true, email, role, acceptUrl });
    return true;
  } catch (err) {
    deps.logger?.error('invite-api: handler failed', { path, err: String(err) });
    sendJson(res, 500, { error: 'internal error' });
    return true;
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
