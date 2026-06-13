// Org-invite token helpers + the store seam (slice 3.5-B.3.1).
//
// An invite is a possession-based capability to JOIN an org at a specific role. The token is a 256-bit
// base64url secret — unguessable; the create response (and the email) carry the RAW token ONCE, and only
// its sha256 hash is ever persisted (hashed-at-rest). Accept is single-use + expiring, enforced in one
// transaction in the store. The token IS the authorization; the invitee's OAuth identity is only WHO they
// are — the invite `email` is informational and is never matched on accept.

import { randomBytes, createHash } from 'node:crypto';
import type { OrgRole } from './membership';

/** Mint a fresh, unguessable invite token (256 bits, url-safe). The RAW token leaves the server only in
 *  the create response + the email; the store persists only `hashToken(token)`. */
export function mintInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The at-rest form of a token: sha256(token) hex. The raw token is never stored, so a DB read cannot
 *  recover a usable link; accept hashes the presented token and looks the row up by this. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create one invite (org-scoped). The caller mints the token and passes only its hash + expiry. */
export interface CreateInviteInput {
  email: string;
  role: OrgRole;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
}

/** A pending invite as the admin list shows it — NEVER the token or its hash. */
export interface InviteSummary {
  id: string;
  email: string;
  role: OrgRole;
  createdAt: string;
  expiresAt: string;
}

/**
 * Outcome of an accept. Deliberately NON-enumerating on failure: 'invalid' (no such token) and 'consumed'
 * (revoked / expired / already used) are the ONLY two failure shapes, and the API collapses BOTH into one
 * generic message — a caller can never learn whether a token never existed vs. expired vs. was used.
 */
export type AcceptInviteResult =
  | { kind: 'ok'; orgId: string; role: OrgRole }
  | { kind: 'invalid' }
  | { kind: 'consumed' };

/**
 * The org-invite store seam (a narrow surface so handler fakes stay small). The first three methods are
 * org-scoped; `acceptInvite` is the one lookup keyed by the global token_hash secret (the token IS the
 * capability — the org is unknown until the row is found). All of it lives in the org-scoped store layer.
 */
export interface InviteStore {
  createInvite(orgId: string, input: CreateInviteInput): Promise<{ id: string }>;
  listPendingInvites(orgId: string): Promise<InviteSummary[]>;
  /** Revoke a pending invite. Returns whether a row changed (false → no such pending invite in this org). */
  revokeInvite(orgId: string, id: string): Promise<boolean>;
  /** Single-use accept: mark the invite accepted + enroll the user, in ONE transaction. */
  acceptInvite(tokenHash: string, acceptingUserId: string): Promise<AcceptInviteResult>;
}
