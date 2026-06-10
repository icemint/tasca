// The user↔org membership primitive (slice 4 — RBAC; extended in slice 5 — onboarding). This is
// where org membership becomes the source of truth: a user belongs to one or more orgs with a role
// in each, and `resolveOrg` (resolve-org.ts) reads it to turn a session into a real tenant boundary.
//
// Slice 5 (5a) adds the ACTIVE org: a user may belong to several orgs, and `user_active_org` records
// which one their requests act in. resolveOrg resolves the VALIDATED active org (the active selection
// if it is still a membership, else the user's first membership) — so a user with memberships in A
// and B, active = A, can only ever reach A's data; switching to B is an isMember-authz'd action.
//
// org_membership / user_active_org are NOT tenant tables (they RESOLVE the tenant), so they are not
// under the org-scoping CI guard.

import { randomUUID } from 'node:crypto';
import type { Queryable } from './store';
import type { OrgMembershipReader } from './resolve-org';
import { DEFAULT_ORG_ID } from './resolve-org';

/**
 * user↔org membership. References app_user (auth) and organization (3a) — applied AFTER both
 * (main.ts applySchema order: AUTH_SCHEMA_DDL → COORDINATION_SCHEMA_DDL → this). `role` is
 * owner/admin/member; slice 4 gates coarsely on MEMBERSHIP, the fine per-action matrix is slice 5b.
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
 * The user's ACTIVE org (slice 5a) — which of their memberships their requests currently act in.
 * One row per user. org_id has NO ON-the-row validity guarantee beyond the FK; resolveOrg
 * re-validates it against org_membership at request time (so a revoked membership can't leave a
 * stale active org pointing at a tenant the user no longer belongs to).
 */
export const USER_ACTIVE_ORG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS user_active_org (
  user_id    text PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  org_id     text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

/**
 * ONE-TIME backfill: enroll every EXISTING app_user into the default org (role owner), so
 * org_default becomes the first REAL org and existing org-scoped data stays visible to the users
 * who already had access. A NEW user created after the migration is enrolled by the slice-5a login
 * hook (ensurePersonalOrg), not here.
 *
 * CORRECTNESS vs the empty-table guard — the `WHERE NOT EXISTS` guard is an OPTIMIZATION that
 * minimizes redundant full-table scans on the common boot (this DDL re-runs on EVERY worker boot,
 * and the worker is horizontally scaled). It is NOT a serialization lock — two pods can both see an
 * empty table and both run the INSERT. What makes that safe (and the whole thing idempotent +
 * "exactly one membership per existing user") is the PRIMARY KEY (user_id, org_id) + ON CONFLICT
 * DO NOTHING. The final state is correct regardless of how many boots race the guard.
 */
export const ORG_MEMBERSHIP_BACKFILL_DDL = `
INSERT INTO org_membership (user_id, org_id, role)
SELECT id, '${DEFAULT_ORG_ID}', 'owner' FROM app_user
 WHERE NOT EXISTS (SELECT 1 FROM org_membership)
ON CONFLICT (user_id, org_id) DO NOTHING;`;

/** Membership DDL in apply order (tables, then the guarded one-time backfill). */
export const ORG_MEMBERSHIP_DDL: readonly string[] = [
  ORG_MEMBERSHIP_TABLE_DDL,
  USER_ACTIVE_ORG_TABLE_DDL,
  ORG_MEMBERSHIP_BACKFILL_DDL,
];

/** A user's org as the switcher lists it. */
export interface UserOrgSummary {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  active: boolean;
}

/**
 * The full membership repository — the reader (`getActiveOrg`, used by resolveOrg) plus the
 * org-lifecycle + switcher operations the org-management API needs.
 */
export interface OrgMembershipRepo extends OrgMembershipReader {
  /** Is the user a member of this org? (authz for switching active org / org-scoped actions.) */
  isMember(userId: string, orgId: string): Promise<boolean>;
  /** The user's orgs (for the switcher), newest-membership last, with which is active. */
  listOrgsForUser(userId: string): Promise<UserOrgSummary[]>;
  /**
   * Ensure the user has at least one org (the login hook). Idempotent + race-safe: a user who
   * already has a membership keeps it (only their active org is defaulted if unset); a user with
   * NONE gets a personal org (owner) created. Concurrent first-logins converge to ONE org/membership
   * via a deterministic personal-org id + ON CONFLICT. Returns the user's (now-guaranteed) active org.
   */
  ensurePersonalOrg(userId: string): Promise<string>;
  /** Create a new org owned by the user and switch their active org to it. Returns the new org id. */
  createOrg(userId: string, name: string): Promise<string>;
  /** Set the user's active org (the caller MUST have checked isMember first). Upsert. */
  setActiveOrg(userId: string, orgId: string): Promise<void>;
}

/** Postgres OrgMembershipRepo — the production `resolveOrg` backing + the onboarding ops. */
export class PgOrgMembershipRepo implements OrgMembershipRepo {
  constructor(private readonly db: Queryable) {}

  async getActiveOrg(userId: string): Promise<string | null> {
    // The active org IF it is still a valid membership, else the user's first membership
    // (backward-compatible with slice-4 single-org users + a stale/revoked active selection).
    // null ONLY when the user has no membership at all → resolveOrg fails closed (403). The JOIN
    // is what stops a revoked membership from leaving a stale active org pointing at a foreign tenant.
    const res = await this.db.query<{ org_id: string }>(
      `SELECT COALESCE(
         (SELECT a.org_id FROM user_active_org a
            JOIN org_membership m ON m.user_id = a.user_id AND m.org_id = a.org_id
           WHERE a.user_id = $1),
         (SELECT org_id FROM org_membership WHERE user_id = $1 ORDER BY created_at, org_id LIMIT 1)
       ) AS org_id`,
      [userId]
    );
    return res.rows[0]?.org_id ?? null;
  }

  async isMember(userId: string, orgId: string): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM org_membership WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listOrgsForUser(userId: string): Promise<UserOrgSummary[]> {
    const res = await this.db.query<UserOrgSummary>(
      `SELECT o.id, o.name, m.role,
              (o.id = (SELECT org_id FROM user_active_org WHERE user_id = $1)) AS active
         FROM org_membership m JOIN organization o ON o.id = m.org_id
        WHERE m.user_id = $1
        ORDER BY m.created_at, o.id`,
      [userId]
    );
    return res.rows;
  }

  async ensurePersonalOrg(userId: string): Promise<string> {
    // Create a personal org + owner membership ONLY for a user with no membership yet. The personal
    // org id is DETERMINISTIC (`org_u_<userId>`), so concurrent first-logins both target the same id
    // and ON CONFLICT collapses them to one — race-safe without a lock. An existing member skips the
    // create; we only default their active org below.
    const personalOrgId = `org_u_${userId}`;
    await this.db.query(
      `INSERT INTO organization (id, name)
         SELECT $1, COALESCE(u.display_name, u.email) || $3
           FROM app_user u
          WHERE u.id = $2 AND NOT EXISTS (SELECT 1 FROM org_membership WHERE user_id = $2)
       ON CONFLICT (id) DO NOTHING`,
      [personalOrgId, userId, "'s org"]
    );
    await this.db.query(
      `INSERT INTO org_membership (user_id, org_id, role)
         SELECT $1, $2, 'owner'
          WHERE NOT EXISTS (SELECT 1 FROM org_membership WHERE user_id = $1)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [userId, personalOrgId]
    );
    // Default the active org to the user's first membership if none is set yet (idempotent).
    await this.db.query(
      `INSERT INTO user_active_org (user_id, org_id)
         SELECT $1, (SELECT org_id FROM org_membership WHERE user_id = $1 ORDER BY created_at, org_id LIMIT 1)
          WHERE EXISTS (SELECT 1 FROM org_membership WHERE user_id = $1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const active = await this.getActiveOrg(userId);
    if (active === null) {
      // Unreachable in practice (we just ensured a membership) — but never return a bogus default.
      throw new Error(`ensurePersonalOrg: failed to provision an org for user ${userId}`);
    }
    return active;
  }

  async createOrg(userId: string, name: string): Promise<string> {
    const orgId = randomUUID();
    await this.db.query(`INSERT INTO organization (id, name) VALUES ($1, $2)`, [orgId, name]);
    await this.db.query(
      `INSERT INTO org_membership (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
      [userId, orgId]
    );
    await this.setActiveOrg(userId, orgId); // creating an org switches you into it
    return orgId;
  }

  async setActiveOrg(userId: string, orgId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_active_org (user_id, org_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()`,
      [userId, orgId]
    );
  }
}
