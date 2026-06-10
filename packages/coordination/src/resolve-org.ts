// Org resolution at the REQUEST EDGE.
//
// Multi-tenant isolation is app-level WHERE org_id (not RLS — see the slice-3 decision and
// docs/decisions/2026-06-10-org-scoping-app-level.md). The store layer is honest by construction:
// every tenant method REQUIRES an orgId and there is NO default-org fallback inside it. The single
// place a default org may be materialized is HERE, at the edge — and as of slice 4 (RBAC) even the
// edge no longer defaults in a request context: it resolves the user's REAL org from membership.
//
// resolveOrg() is the ONE session→org function. Slice 4 turned it from a constant stub into a
// membership lookup: an authenticated user resolves to their org; NO membership → null → the
// caller fails CLOSED (403). The only path that still returns DEFAULT_ORG_ID is a null session,
// reachable solely behind the read/write API's explicit `allowUnauthenticated` dev opt-in.

import type { SessionInfo } from './read-api';

/** The default org existing rows were backfilled onto (schema.ts ORG_SCOPING_DDL), and the org
 *  every existing user is enrolled into by the slice-4 backfill so it becomes the first REAL org.
 *  Referenced only at edges — never inside a scoped store method, and (slice 4) never as a
 *  request-context fallback: a missing membership rejects rather than silently defaulting. */
export const DEFAULT_ORG_ID = 'org_default';

/**
 * Resolves which org a user acts in — implemented over `org_membership` at the composition root.
 * This is the seam RBAC owns: slice 4 reads a single membership; slice 5 adds the active-org
 * switcher (multi-org-per-user).
 */
export interface OrgMembershipReader {
  /** The org the user belongs to (single-org resolution), or null when the user has NO
   *  membership. RBAC is fail-closed, so a null MUST reject — never default to someone's data. */
  getOrgForUser(userId: string): Promise<string | null>;
}

/**
 * Resolve the org a request acts in (slice 4 — RBAC). The tenant boundary is now REAL:
 * - an authenticated session → the user's org via membership; NO membership → `null`, and the
 *   caller MUST fail closed (403). Never DEFAULT_ORG_ID in a request context — that is exactly the
 *   silent-default escape hatch slice 3 eliminated in the store; the edge holds the same line.
 * - a `null` session is only reachable behind the read/write API's explicit `allowUnauthenticated`
 *   dev opt-in (production always has a verified session here, or already 401'd), so the
 *   DEFAULT_ORG_ID fallback is structurally dev-only — gated by that opt-in, not a code default.
 */
export async function resolveOrg(
  membership: OrgMembershipReader,
  session: SessionInfo | null
): Promise<string | null> {
  if (session === null) return DEFAULT_ORG_ID; // dev/no-auth ONLY (allowUnauthenticated-gated)
  return membership.getOrgForUser(session.userId); // prod: the user's org, or null → caller 403s
}
