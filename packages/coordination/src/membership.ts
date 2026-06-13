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
import type { Pool, PoolClient } from 'pg';
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

/**
 * The user's ACTIVE project (slice Project-A) — which project (a finer filter WITHIN their active
 * org) their task views are scoped to. One row per user. Like user_active_org, the row carries NO
 * validity guarantee beyond the FK: getActiveProject re-validates it against the user's CURRENT
 * active org at read time, so a stale active project (its org no longer the active one, or its
 * membership revoked) can't leak a foreign tenant's tasks. ON DELETE CASCADE on project: dropping a
 * project clears anyone parked on it. RESOLVES the project scope — NOT a tenant table (mirrors
 * user_active_org), so it is not under the org-scoping CI guard.
 */
export const USER_ACTIVE_PROJECT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS user_active_project (
  user_id    text PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

/** Membership DDL in apply order (tables, then the guarded one-time backfill). user_active_project
 *  FKs project (created in COORDINATION_SCHEMA_DDL, applied before this) + app_user. */
export const ORG_MEMBERSHIP_DDL: readonly string[] = [
  ORG_MEMBERSHIP_TABLE_DDL,
  USER_ACTIVE_ORG_TABLE_DDL,
  USER_ACTIVE_PROJECT_TABLE_DDL,
  ORG_MEMBERSHIP_BACKFILL_DDL,
];

/** A user's role within an org (slice 5b). The lattice is member < admin < owner. */
export type OrgRole = 'owner' | 'admin' | 'member';

const ROLE_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/** Does `role` meet (or exceed) the `min` required for an action? The role gate (5b). */
export function atLeast(role: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** A user's org as the switcher lists it. */
export interface UserOrgSummary {
  id: string;
  name: string;
  role: OrgRole;
  active: boolean;
}

/** A member of an org as the team list shows it. */
export interface OrgMemberSummary {
  userId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
}

/** Outcome of a member-management mutation. `last_owner` = refused to leave the org ownerless. */
export type MemberWriteOutcome = 'ok' | 'not_found' | 'last_owner' | 'already_member';

/**
 * The reader the write-API role gate needs: resolve the active org (the tenant boundary) + the
 * user's role in it (the action gate). A narrow surface so handler fakes stay small; the full repo
 * extends it.
 */
export interface RoleReader extends OrgMembershipReader {
  /** The user's role in this org, or null if not a member. Looked up in the RESOLVED ACTIVE org,
   *  so authority is per-(user, active-org) — switch org, switch role. */
  getRole(userId: string, orgId: string): Promise<OrgRole | null>;
}

/**
 * The full membership repository — the reader (`getActiveOrg`/`getRole`) plus the org-lifecycle +
 * switcher + member-management operations the org-management API needs.
 */
export interface OrgMembershipRepo extends RoleReader {
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
  /**
   * Single-tenant (slice 3.5-B.1) login hook: enroll the user into the ONE instance org and make it
   * active. The FIRST member of the instance org becomes `owner` (the operator/first login); everyone
   * after is `member` — least-privilege; the operator promotes via member management. Idempotent + race-
   * safe (deterministic instance id + ON CONFLICT): a returning user is a no-op (no downgrade/dup), and
   * concurrent first-logins converge to exactly ONE owner.
   */
  ensureInstanceMembership(userId: string, instanceOrgId: string): Promise<void>;
  /** Create a new org owned by the user and switch their active org to it. Returns the new org id. */
  createOrg(userId: string, name: string): Promise<string>;
  /** Set the user's active org (the caller MUST have checked isMember first). Upsert. */
  setActiveOrg(userId: string, orgId: string): Promise<void>;

  // ── org settings (slice 3.5-B.2: Workspace name) ─────────────────────────────
  /** The org's display name, or null if no such org. (`organization` RESOLVES the tenant — it is
   *  not itself a tenant table — so reading/writing its name is allowed outside the org-scoped layer.) */
  getOrgName(orgId: string): Promise<string | null>;
  /** Rename the org. The caller MUST have checked the active org + role (admin+) first. */
  renameOrg(orgId: string, name: string): Promise<void>;

  // ── member management (slice 5b; getRole is inherited from RoleReader) ───────
  /** The org's members (the team list). */
  listMembers(orgId: string): Promise<OrgMemberSummary[]>;
  /** Add an EXISTING app_user (by email) to the org at `role`. `not_found` if no such user;
   *  `already_member` if they are already in the org. (Pending invites for non-users are deferred.) */
  addMemberByEmail(orgId: string, email: string, role: OrgRole): Promise<MemberWriteOutcome>;
  /** Change a member's role. Refuses (`last_owner`) to demote the org's LAST owner. */
  setMemberRole(orgId: string, targetUserId: string, role: OrgRole): Promise<MemberWriteOutcome>;
  /** Remove a member. Refuses (`last_owner`) to remove the org's LAST owner. */
  removeMember(orgId: string, targetUserId: string): Promise<MemberWriteOutcome>;
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

  async ensureInstanceMembership(userId: string, instanceOrgId: string): Promise<void> {
    // Enroll the user into the ONE instance org. Role: the FIRST member (the org has NONE yet) is
    // 'owner' (the operator/first login); everyone after is 'member' (least-privilege — the schema's
    // lowest role; the operator promotes from there). "Exactly one owner" must hold even when TWO
    // DIFFERENT users first-login concurrently — and the (user_id, org_id) PK does NOT serialize that
    // (different user_ids, both INSERTs would land). So serialize per-org under the SAME advisory lock
    // member-management uses (lock-ordering-safe, deterministic on the org id): under it the NOT EXISTS
    // role choice is stable, so at most one row is written 'owner'. A returning member is a plain no-op
    // (ON CONFLICT). org_membership RESOLVES the tenant, so this is not under the org-scoping CI guard.
    await this.withTx(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [instanceOrgId]);
      await db.query(
        `INSERT INTO org_membership (user_id, org_id, role)
           SELECT $1, $2,
                  CASE WHEN NOT EXISTS (SELECT 1 FROM org_membership WHERE org_id = $2) THEN 'owner' ELSE 'member' END
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [userId, instanceOrgId]
      );
      // Point the user's active org at the instance org if unset (idempotent — a returning user keeps
      // theirs, which is already the instance org since it is their only membership).
      await db.query(
        `INSERT INTO user_active_org (user_id, org_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, instanceOrgId]
      );
    });
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

  // ── org settings (slice 3.5-B.2) ────────────────────────────────────────────

  async getOrgName(orgId: string): Promise<string | null> {
    const res = await this.db.query<{ name: string }>(
      `SELECT name FROM organization WHERE id = $1`,
      [orgId]
    );
    return res.rows[0]?.name ?? null;
  }

  async renameOrg(orgId: string, name: string): Promise<void> {
    await this.db.query(`UPDATE organization SET name = $2 WHERE id = $1`, [orgId, name]);
  }

  // ── role + member management (slice 5b) ─────────────────────────────────────

  async getRole(userId: string, orgId: string): Promise<OrgRole | null> {
    const res = await this.db.query<{ role: OrgRole }>(
      `SELECT role FROM org_membership WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId]
    );
    return res.rows[0]?.role ?? null;
  }

  async listMembers(orgId: string): Promise<OrgMemberSummary[]> {
    const res = await this.db.query<{ user_id: string; email: string; display_name: string | null; role: OrgRole }>(
      `SELECT m.user_id, u.email, u.display_name, m.role
         FROM org_membership m JOIN app_user u ON u.id = m.user_id
        WHERE m.org_id = $1
        ORDER BY m.created_at, m.user_id`,
      [orgId]
    );
    return res.rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role }));
  }

  async addMemberByEmail(orgId: string, email: string, role: OrgRole): Promise<MemberWriteOutcome> {
    const user = await this.db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE lower(email) = lower($1)`,
      [email]
    );
    const userId = user.rows[0]?.id;
    if (!userId) return 'not_found';
    const ins = await this.db.query(
      `INSERT INTO org_membership (user_id, org_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO NOTHING`,
      [userId, orgId, role]
    );
    return ins.rowCount === 1 ? 'ok' : 'already_member';
  }

  async setMemberRole(orgId: string, targetUserId: string, role: OrgRole): Promise<MemberWriteOutcome> {
    // Last-owner protection: demoting the org's only owner is refused. A PER-ORG advisory xact lock
    // serializes ALL member-management on this org, so two concurrent owner-demotions can't both
    // pass the count and strand the org at zero owners. (Row-level FOR UPDATE on the target + owner
    // set was rejected: the target lock is taken first and unordered, so two demotes of different
    // owners deadlock — the advisory lock has no lock-ordering hazard and serializes cleanly.)
    return this.withTx(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orgId]);
      const cur = await db.query<{ role: OrgRole }>(
        `SELECT role FROM org_membership WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetUserId]
      );
      if (!cur.rowCount) return 'not_found';
      if (cur.rows[0]!.role === 'owner' && role !== 'owner' && (await this.ownerCount(db, orgId)) <= 1) {
        return 'last_owner';
      }
      await db.query(`UPDATE org_membership SET role = $3 WHERE org_id = $1 AND user_id = $2`, [orgId, targetUserId, role]);
      return 'ok';
    });
  }

  async removeMember(orgId: string, targetUserId: string): Promise<MemberWriteOutcome> {
    return this.withTx(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orgId]); // serialize per-org (see setMemberRole)
      const cur = await db.query<{ role: OrgRole }>(
        `SELECT role FROM org_membership WHERE org_id = $1 AND user_id = $2`,
        [orgId, targetUserId]
      );
      if (!cur.rowCount) return 'not_found';
      if (cur.rows[0]!.role === 'owner' && (await this.ownerCount(db, orgId)) <= 1) {
        return 'last_owner';
      }
      await db.query(`DELETE FROM org_membership WHERE org_id = $1 AND user_id = $2`, [orgId, targetUserId]);
      // If that user's active org was this org, clear it so resolveOrg falls back to a real membership.
      await db.query(`DELETE FROM user_active_org WHERE user_id = $1 AND org_id = $2`, [targetUserId, orgId]);
      return 'ok';
    });
  }

  /** How many owners the org has (called under the per-org advisory lock, so the count is stable). */
  private async ownerCount(db: Queryable, orgId: string): Promise<number> {
    const res = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM org_membership WHERE org_id = $1 AND role = 'owner'`,
      [orgId]
    );
    return Number(res.rows[0]!.n);
  }

  /** Run `fn` in a transaction (member-management holds a per-org advisory lock across reads+write).
   *  A Pool gets a fresh tx; an already-checked-out client reuses the caller's. Discriminate by
   *  release() — a checked-out PoolClient has it, a Pool does not (mirrors store.ts isPool). */
  private async withTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    if (typeof (this.db as { release?: unknown }).release === 'function') {
      return fn(this.db); // already a client — reuse the caller's tx context
    }
    const client: PoolClient = await (this.db as Pool).connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
