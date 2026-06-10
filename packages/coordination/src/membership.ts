// The user↔org membership primitive (slice 4 — RBAC). This is where org membership becomes the
// source of truth: a user belongs to one or more orgs with a role in each, and `resolveOrg`
// (resolve-org.ts) reads it to turn a session into a real tenant boundary.
//
// The table is N:N from the outset (the schema is multi-org-per-user capable — the real eventual
// state) while slice 4 only RESOLVES a single membership; the active-org switcher is slice 5.
// org_membership is NOT a tenant table (it is the thing that RESOLVES the tenant), so it is not
// under the org-scoping CI guard.

import type { Queryable } from './store';
import type { OrgMembershipReader } from './resolve-org';
import { DEFAULT_ORG_ID } from './resolve-org';

/**
 * user↔org membership. References app_user (auth) and organization (3a) — applied AFTER both
 * (main.ts applySchema order: AUTH_SCHEMA_DDL → COORDINATION_SCHEMA_DDL → this). `role` is
 * populated now (owner/admin/member) but slice 4 gates coarsely on MEMBERSHIP, not on role; a
 * fine per-action permission matrix is a follow-up once onboarding defines the real roles.
 */
export const ORG_MEMBERSHIP_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS org_membership (
  user_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  org_id     text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS org_membership_user_idx ON org_membership (user_id);`;

/**
 * ONE-TIME backfill: enroll every EXISTING app_user into the default org (role owner), so
 * org_default becomes the first REAL org and existing org-scoped data stays visible to the users
 * who already had access. A NEW user created after the migration is NOT auto-enrolled: they are
 * fail-closed (resolveOrg → null → 403) until onboarding (slice 5) grants them a membership.
 *
 * CORRECTNESS vs the empty-table guard — read carefully, the two are different layers:
 *   - The `WHERE NOT EXISTS (SELECT 1 FROM org_membership)` guard is an OPTIMIZATION that minimizes
 *     redundant full-table scans on the common boot (this DDL re-runs on EVERY worker boot, and the
 *     worker is horizontally scaled — multiple pods boot concurrently). It is NOT a serialization
 *     lock: two pods booting together can both observe an empty table and both run the INSERT.
 *   - What actually makes that safe — and the whole thing idempotent + "exactly one membership per
 *     existing user" — is the table's PRIMARY KEY (user_id, org_id) + `ON CONFLICT DO NOTHING`. The
 *     final state is correct regardless of how many boots race the guard.
 * If concurrent-boot full-table re-scans ever become a measured concern, wrap this in a
 * pg_advisory_xact_lock; it is low value while org_membership is only briefly empty, so it's deferred.
 *
 * (Fresh install, no users yet: the guard stays open until the first boot that sees users, then
 * enrolls the founding users into the default org — benign: there is no prior tenant to protect.)
 */
export const ORG_MEMBERSHIP_BACKFILL_DDL = `
INSERT INTO org_membership (user_id, org_id, role)
SELECT id, '${DEFAULT_ORG_ID}', 'owner' FROM app_user
 WHERE NOT EXISTS (SELECT 1 FROM org_membership)
ON CONFLICT (user_id, org_id) DO NOTHING;`;

/** Membership DDL in apply order (table, then the guarded one-time backfill). */
export const ORG_MEMBERSHIP_DDL: readonly string[] = [
  ORG_MEMBERSHIP_TABLE_DDL,
  ORG_MEMBERSHIP_BACKFILL_DDL,
];

/** Postgres OrgMembershipReader — the production `resolveOrg` backing. */
export class PgOrgMembershipReader implements OrgMembershipReader {
  constructor(private readonly db: Queryable) {}

  async getOrgForUser(userId: string): Promise<string | null> {
    // Single-org resolution (slice 4): the user's membership. ORDER BY created_at gives a
    // deterministic pick if a user somehow has more than one row (the active-org switcher that
    // makes multi-org meaningful is slice 5). null when the user has no membership → fail closed.
    const res = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM org_membership WHERE user_id = $1 ORDER BY created_at, org_id LIMIT 1`,
      [userId]
    );
    return res.rows[0]?.org_id ?? null;
  }
}
