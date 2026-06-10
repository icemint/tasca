// Org resolution at the REQUEST EDGE (Wave 2, slice 3b-2).
//
// Multi-tenant isolation is app-level WHERE org_id (not RLS — see the slice-3 decision).
// The store layer is honest by construction: every tenant method REQUIRES an orgId, the
// cross-org resolvers (getOrgForConnection / getOrgForTask / getInstallationIdForOwner)
// return null when nothing matches, and NO scoped method has a default-org fallback. The
// single place a default org is materialized is HERE, at the edge — so a forgotten orgId
// is a compile error in the store, never a silent cross-tenant default.
//
// resolveOrg() is the ONE session→org stub. Until RBAC/onboarding (slice 4) the platform
// is single-org, so it returns the default org for any session. Slice 4 swaps THIS one
// function for a real session→membership lookup; nothing else in the request path changes.

import type { SessionInfo } from './read-api';

/** The single default org every existing row was backfilled onto (schema.ts ORG_SCOPING_DDL).
 *  Referenced ONLY at edges (this module + the webhook/install edges) — never inside a scoped
 *  store method, where a missing orgId must stay a compile error rather than a silent default. */
export const DEFAULT_ORG_ID = 'org_default';

/**
 * Resolve the org a request acts in from its session. SLICE-4 SWAP POINT: RBAC replaces this
 * single stub with a real session→org-membership lookup. Until then the platform is single-org,
 * so every authenticated (or dev-unauthenticated) request resolves to the default org.
 */
export function resolveOrg(_session: SessionInfo | null): string {
  return DEFAULT_ORG_ID;
}
