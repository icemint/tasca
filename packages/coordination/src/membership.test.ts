import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
import { AUTH_SCHEMA_DDL } from '@tasca/auth';
import { PgCoordinationStore } from './store';
import { COORDINATION_SCHEMA_DDL } from './schema';
import { ORG_MEMBERSHIP_TABLE_DDL, ORG_MEMBERSHIP_BACKFILL_DDL, PgOrgMembershipReader } from './membership';
import { resolveOrg, DEFAULT_ORG_ID } from './resolve-org';

// DB-backed proof of the slice-4 RBAC membership model. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('org membership (Postgres) — backfill, reader, fail-closed resolve, cross-tenant block', () => {
  const SCHEMA = 'membership_slice4_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    await pool.query(DISPATCH_JOB_DDL);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl); // app_user
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl); // organization + org_default + task.org_id
    await pool.query(ORG_MEMBERSHIP_TABLE_DDL); // table only — the backfill is exercised per-test below
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  const addUser = (id: string) => pool.query(`INSERT INTO app_user (id, email) VALUES ($1, $2)`, [id, `${id}@x.test`]);

  // State accumulates across these ordered tests (no per-test truncate) — u1/u2 created here are
  // read by the reader/resolve tests below.
  it('backfill enrolls every EXISTING user into org_default exactly once + idempotent; NEW users left out', async () => {
    await addUser('u1');
    await addUser('u2');
    await pool.query(ORG_MEMBERSHIP_BACKFILL_DDL); // first run (table empty) → enroll u1, u2
    await pool.query(ORG_MEMBERSHIP_BACKFILL_DDL); // re-run (table non-empty) → no-op (idempotent)

    const rows = await pool.query<{ user_id: string; org_id: string; role: string }>(
      `SELECT user_id, org_id, role FROM org_membership ORDER BY user_id`
    );
    expect(rows.rows).toEqual([
      { user_id: 'u1', org_id: 'org_default', role: 'owner' },
      { user_id: 'u2', org_id: 'org_default', role: 'owner' },
    ]); // every existing user → exactly one org_default owner membership

    // A NEW user created AFTER the backfill ran is NOT auto-enrolled — the empty-table guard blocks
    // re-application, so they stay membership-less and are fail-closed until onboarding (slice 5).
    await addUser('u3-new');
    await pool.query(ORG_MEMBERSHIP_BACKFILL_DDL);
    const u3 = await pool.query(`SELECT 1 FROM org_membership WHERE user_id = 'u3-new'`);
    expect(u3.rowCount).toBe(0);
  });

  it('PgOrgMembershipReader: a member resolves to their org; a non-member / unknown resolves to null', async () => {
    const reader = new PgOrgMembershipReader(pool);
    expect(await reader.getOrgForUser('u1')).toBe('org_default');
    expect(await reader.getOrgForUser('u3-new')).toBeNull(); // exists but no membership
    expect(await reader.getOrgForUser('nobody')).toBeNull(); // unknown user
  });

  it('resolveOrg: member→org; no-membership→null (caller fails closed); DEFAULT only for a null session', async () => {
    const reader = new PgOrgMembershipReader(pool);
    expect(await resolveOrg(reader, { userId: 'u1' })).toBe('org_default'); // member → real org
    expect(await resolveOrg(reader, { userId: 'u3-new' })).toBeNull(); // no membership → null (the edge 403s)
    expect(await resolveOrg(reader, null)).toBe(DEFAULT_ORG_ID); // null session = dev/no-auth ONLY
  });

  it('CROSS-TENANT: a user in org A cannot mutate a task in org B — the org-scoped write misses (not_found)', async () => {
    const store = new PgCoordinationStore(pool);
    const reader = new PgOrgMembershipReader(pool);
    await pool.query(`INSERT INTO organization (id, name) VALUES ('org_a','A'),('org_b','B') ON CONFLICT (id) DO NOTHING`);
    await addUser('u-a');
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('u-a','org_a','owner')`);
    const taskB = await store.getOrCreateTask('org_b', { externalStoryId: 'b/repo#1', platform: 'github' });

    // The full chain: resolveOrg(u-a) = org_a; an escalate scoped to org_a cannot reach the org_b task.
    const org = await resolveOrg(reader, { userId: 'u-a' });
    expect(org).toBe('org_a');
    const outcome = await store.escalateTask(org!, taskB.id);
    expect(outcome).toEqual({ ok: false, reason: 'not_found' }); // cross-tenant write blocked at the store
  });
});
