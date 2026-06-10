import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
import { AUTH_SCHEMA_DDL } from '@tasca/auth';
import { PgCoordinationStore } from './store';
import { COORDINATION_SCHEMA_DDL } from './schema';
import { ORG_MEMBERSHIP_TABLE_DDL, USER_ACTIVE_ORG_TABLE_DDL, ORG_MEMBERSHIP_BACKFILL_DDL, PgOrgMembershipRepo } from './membership';
import { GITHUB_INSTALL_STATE_TABLE_DDL, GITHUB_CONNECTION_UNIQUE_DDL, PgGitHubInstallStateRepo } from './github-connect';
import { ORG_AGENT_TABLE_DDL, PgOrgRosterRepo } from './roster';
import { IDENTITY_SCHEMA_DDL } from '@tasca/identity';
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
    await pool.query(USER_ACTIVE_ORG_TABLE_DDL); // slice 5a: the active-org table getActiveOrg JOINs
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

  it('PgOrgMembershipRepo: a member resolves to their org; a non-member / unknown resolves to null', async () => {
    const reader = new PgOrgMembershipRepo(pool);
    expect(await reader.getActiveOrg('u1')).toBe('org_default');
    expect(await reader.getActiveOrg('u3-new')).toBeNull(); // exists but no membership
    expect(await reader.getActiveOrg('nobody')).toBeNull(); // unknown user
  });

  it('resolveOrg: member→org; no-membership→null (caller fails closed); DEFAULT only for a null session', async () => {
    const reader = new PgOrgMembershipRepo(pool);
    expect(await resolveOrg(reader, { userId: 'u1' })).toBe('org_default'); // member → real org
    expect(await resolveOrg(reader, { userId: 'u3-new' })).toBeNull(); // no membership → null (the edge 403s)
    expect(await resolveOrg(reader, null)).toBe(DEFAULT_ORG_ID); // null session = dev/no-auth ONLY
  });

  it('CROSS-TENANT: a user in org A cannot mutate a task in org B — the org-scoped write misses (not_found)', async () => {
    const store = new PgCoordinationStore(pool);
    const reader = new PgOrgMembershipRepo(pool);
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

run('org lifecycle + active-org switcher (Postgres, slice 5a)', () => {
  const SCHEMA = 'membership_slice5a_test';
  let pool: Pool;
  let repo: PgOrgMembershipRepo;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl); // organization (+ org_default)
    await pool.query(ORG_MEMBERSHIP_TABLE_DDL);
    await pool.query(USER_ACTIVE_ORG_TABLE_DDL);
    repo = new PgOrgMembershipRepo(pool);
  });
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  const addUser = (id: string, name = id) =>
    pool.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [id, `${id}@x.test`, name]);

  it('ensurePersonalOrg: a NEW user gets a personal org (owner) + an active org — no fail-closed dead-end', async () => {
    await addUser('newbie', 'Newbie');
    const active = await repo.ensurePersonalOrg('newbie');
    expect(active).toBe('org_u_newbie'); // deterministic personal-org id
    const rows = await pool.query<{ org_id: string; role: string }>(
      `SELECT org_id, role FROM org_membership WHERE user_id = 'newbie'`
    );
    expect(rows.rows).toEqual([{ org_id: 'org_u_newbie', role: 'owner' }]);
    expect(await repo.getActiveOrg('newbie')).toBe('org_u_newbie');
  });

  it('ensurePersonalOrg is idempotent + RACE-SAFE: concurrent first-logins → exactly ONE org', async () => {
    await addUser('racer', 'Racer');
    // Fire many concurrent ensurePersonalOrg for the same brand-new user.
    await Promise.all(Array.from({ length: 8 }, () => repo.ensurePersonalOrg('racer')));
    const orgs = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM org_membership WHERE user_id = 'racer'`);
    expect(orgs.rows[0]!.c).toBe(1); // exactly one membership despite the race
    const act = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM user_active_org WHERE user_id = 'racer'`);
    expect(act.rows[0]!.c).toBe(1);
  });

  it('ensurePersonalOrg for an EXISTING member makes no new org — just ensures an active org', async () => {
    await addUser('member', 'Member');
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('member','org_default','owner')`);
    const active = await repo.ensurePersonalOrg('member');
    expect(active).toBe('org_default'); // their existing membership, not a new personal org
    const orgs = await pool.query<{ org_id: string }>(`SELECT org_id FROM org_membership WHERE user_id = 'member'`);
    expect(orgs.rows).toEqual([{ org_id: 'org_default' }]); // no personal org created
  });

  it('active org IS the tenant boundary: a user in A and B resolves to the ACTIVE one only; switching is by membership', async () => {
    await addUser('multi', 'Multi');
    await pool.query(`INSERT INTO organization (id,name) VALUES ('m_a','A'),('m_b','B') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('multi','m_a','owner'),('multi','m_b','admin')`);

    await repo.setActiveOrg('multi', 'm_a');
    expect(await repo.getActiveOrg('multi')).toBe('m_a');
    expect(await resolveOrg(repo, { userId: 'multi' })).toBe('m_a'); // resolver hands A, never B

    await repo.setActiveOrg('multi', 'm_b');
    expect(await resolveOrg(repo, { userId: 'multi' })).toBe('m_b'); // now B, after an explicit switch

    // isMember is the switch authz: member of A/B, not of org_default.
    expect(await repo.isMember('multi', 'm_a')).toBe(true);
    expect(await repo.isMember('multi', 'org_default')).toBe(false);
  });

  it('a STALE active org (membership revoked) is NOT honored — resolver falls back to a real membership', async () => {
    await addUser('revoked', 'Revoked');
    await pool.query(`INSERT INTO organization (id,name) VALUES ('r_a','A'),('r_b','B') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('revoked','r_a','owner'),('revoked','r_b','member')`);
    await repo.setActiveOrg('revoked', 'r_b');
    expect(await repo.getActiveOrg('revoked')).toBe('r_b');
    // Revoke the r_b membership; the stale active pointer must NOT resolve to r_b anymore.
    await pool.query(`DELETE FROM org_membership WHERE user_id='revoked' AND org_id='r_b'`);
    expect(await repo.getActiveOrg('revoked')).toBe('r_a'); // falls back to a still-valid membership, never the revoked org
  });

  it('createOrg: makes the user the owner of a new org and switches their active org to it', async () => {
    await addUser('founder', 'Founder');
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('founder','org_default','owner')`);
    await repo.setActiveOrg('founder', 'org_default');
    const newOrg = await repo.createOrg('founder', 'Acme Inc');
    expect(await repo.isMember('founder', newOrg)).toBe(true);
    const role = await pool.query<{ role: string }>(`SELECT role FROM org_membership WHERE user_id='founder' AND org_id=$1`, [newOrg]);
    expect(role.rows[0]!.role).toBe('owner');
    expect(await repo.getActiveOrg('founder')).toBe(newOrg); // creating switched the active org
  });
});

run('role matrix + member management (Postgres, slice 5b)', () => {
  const SCHEMA = 'membership_slice5b_test';
  let pool: Pool;
  let repo: PgOrgMembershipRepo;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
    await pool.query(ORG_MEMBERSHIP_TABLE_DDL);
    await pool.query(USER_ACTIVE_ORG_TABLE_DDL);
    repo = new PgOrgMembershipRepo(pool);
    // Users + a 'team' org with one owner + one member.
    for (const u of ['owner1', 'owner2', 'memb', 'outsider']) {
      await pool.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [u, `${u}@x.test`, u]);
    }
    await pool.query(`INSERT INTO organization (id,name) VALUES ('team','Team') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('owner1','team','owner'),('memb','team','member')`);
  });
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('getRole returns the role in the org; null for a non-member', async () => {
    expect(await repo.getRole('owner1', 'team')).toBe('owner');
    expect(await repo.getRole('memb', 'team')).toBe('member');
    expect(await repo.getRole('outsider', 'team')).toBeNull();
  });

  it('listMembers returns the team with roles + emails', async () => {
    // owner1 + memb were inserted in one statement (same created_at), so the ORDER BY tiebreaks on
    // user_id → 'memb' before 'owner1'.
    const members = await repo.listMembers('team');
    expect(members).toEqual([
      { userId: 'memb', email: 'memb@x.test', displayName: 'memb', role: 'member' },
      { userId: 'owner1', email: 'owner1@x.test', displayName: 'owner1', role: 'owner' },
    ]);
  });

  it('addMemberByEmail: ok for an existing user, not_found for unknown, already_member for a dup', async () => {
    expect(await repo.addMemberByEmail('team', 'owner2@x.test', 'admin')).toBe('ok');
    expect(await repo.getRole('owner2', 'team')).toBe('admin');
    expect(await repo.addMemberByEmail('team', 'nobody@x.test', 'member')).toBe('not_found');
    expect(await repo.addMemberByEmail('team', 'memb@x.test', 'admin')).toBe('already_member');
  });

  it('LAST-OWNER protection: demoting/removing the only owner is REFUSED', async () => {
    // 'team' currently has exactly one owner (owner1); owner2 is admin, memb is member.
    expect(await repo.setMemberRole('team', 'owner1', 'admin')).toBe('last_owner');
    expect(await repo.getRole('owner1', 'team')).toBe('owner'); // unchanged
    expect(await repo.removeMember('team', 'owner1')).toBe('last_owner');
    expect(await repo.getRole('owner1', 'team')).toBe('owner'); // still there

    // Promote owner2 to owner → now TWO owners → demoting/removing one is allowed.
    expect(await repo.setMemberRole('team', 'owner2', 'owner')).toBe('ok');
    expect(await repo.setMemberRole('team', 'owner1', 'admin')).toBe('ok'); // owner2 still owns it
    expect(await repo.getRole('owner1', 'team')).toBe('admin');
  });

  it('removeMember clears the removed user’s active org if it pointed there', async () => {
    await pool.query(`INSERT INTO organization (id,name) VALUES ('tmp','Tmp') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('memb','tmp','member')`);
    await repo.setActiveOrg('memb', 'tmp');
    expect(await repo.removeMember('tmp', 'memb')).toBe('ok'); // tmp has no owner, but memb isn't one, so ok
    const act = await pool.query(`SELECT 1 FROM user_active_org WHERE user_id='memb' AND org_id='tmp'`);
    expect(act.rowCount).toBe(0); // active pointer cleared → resolveOrg falls back
  });

  it('role is scoped to the ACTIVE org: owner of A, member of B → owner powers only when A is active', async () => {
    await pool.query(`INSERT INTO organization (id,name) VALUES ('s_a','A'),('s_b','B') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('outsider','s_a','owner'),('outsider','s_b','member')`);
    await repo.setActiveOrg('outsider', 's_a');
    const orgA = await resolveOrg(repo, { userId: 'outsider' });
    expect(orgA).toBe('s_a');
    expect(await repo.getRole('outsider', orgA!)).toBe('owner'); // owner when A is active

    await repo.setActiveOrg('outsider', 's_b');
    const orgB = await resolveOrg(repo, { userId: 'outsider' });
    expect(orgB).toBe('s_b');
    expect(await repo.getRole('outsider', orgB!)).toBe('member'); // only member when B is active
  });

  it('CONCURRENT owner-demotion is serialized (no deadlock/500): exactly one succeeds, the org keeps an owner', async () => {
    // Two owners; fire both demotions at once. The per-org advisory lock serializes them, so one
    // commits ('ok') and the other sees the last-owner guard ('last_owner') — never a deadlock (the
    // old row-lock approach could 40P01 → spurious 500), and never zero owners.
    for (const u of ['cc1', 'cc2']) {
      await pool.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [u, `${u}@x.test`, u]);
    }
    await pool.query(`INSERT INTO organization (id,name) VALUES ('cc','CC') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('cc1','cc','owner'),('cc2','cc','owner')`);

    const [r1, r2] = await Promise.all([
      repo.setMemberRole('cc', 'cc1', 'member'),
      repo.setMemberRole('cc', 'cc2', 'member'),
    ]);
    expect([r1, r2].filter((r) => r === 'ok')).toHaveLength(1); // exactly one demote committed
    expect([r1, r2].filter((r) => r === 'last_owner')).toHaveLength(1); // the other was refused
    const owners = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM org_membership WHERE org_id='cc' AND role='owner'`);
    expect(Number(owners.rows[0]!.n)).toBe(1); // org still has exactly one owner — never stranded
  });
});

run('github connect: install-state nonce + connection store (Postgres, slice 5c)', () => {
  const SCHEMA = 'connect_slice5c_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
    await pool.query(ORG_MEMBERSHIP_TABLE_DDL);
    await pool.query(GITHUB_INSTALL_STATE_TABLE_DDL);
    await pool.query(GITHUB_CONNECTION_UNIQUE_DDL);
    await pool.query(`INSERT INTO app_user (id, email) VALUES ('cu','cu@x.test')`);
    await pool.query(`INSERT INTO organization (id, name) VALUES ('cu_org','CU') ON CONFLICT (id) DO NOTHING`);
  });
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('install-state nonce is SINGLE-USE: consume returns the binding once, then null (replay fails)', async () => {
    const repo = new PgGitHubInstallStateRepo(pool);
    const state = await repo.issue('cu', 'cu_org');
    expect(await repo.consume(state)).toEqual({ userId: 'cu', orgId: 'cu_org' }); // first consume binds
    expect(await repo.consume(state)).toBeNull(); // replay → gone (deleted on consume)
    expect(await repo.consume('never-issued')).toBeNull();
  });

  it('an EXPIRED nonce does not consume', async () => {
    const repo = new PgGitHubInstallStateRepo(pool);
    const state = await repo.issue('cu', 'cu_org');
    await pool.query(`UPDATE github_install_state SET expires_at = now() - interval '1 second' WHERE state = $1`, [state]);
    expect(await repo.consume(state)).toBeNull(); // expired → refused
  });

  it('connection store: callback upsert binds org; webhook update refreshes installation_id; revoke marks revoked', async () => {
    const store = new PgCoordinationStore(pool);
    // The connect callback binds the account to the real org.
    await store.upsertGitHubInstallation('cu_org', { workspaceId: 'acme', installationId: '111' });
    expect(await store.getOrgForConnection('github', 'acme')).toBe('cu_org'); // resolves to the real org
    expect(await store.getInstallationIdForOwner('acme')).toBe('111');

    // The install webhook (confirmation) refreshes installation_id WITHOUT touching org.
    expect(await store.updateInstallationByAccount('acme', '222')).toBe(true);
    expect(await store.getInstallationIdForOwner('acme')).toBe('222');
    expect(await store.getOrgForConnection('github', 'acme')).toBe('cu_org'); // org unchanged by the webhook

    // Uninstall → revoked → STOPS RESOLVING (fail-closed): a revoked account's webhooks/token-mints
    // must not run in the formerly-bound tenant.
    expect(await store.revokeInstallationByAccount('acme')).toBe(true);
    const h = await pool.query<{ health: string }>(`SELECT health FROM platform_connection WHERE workspace_id='acme'`);
    expect(h.rows[0]!.health).toBe('revoked');
    expect(await store.getOrgForConnection('github', 'acme')).toBeNull(); // revoked → no longer resolves
    expect(await store.getInstallationIdForOwner('acme')).toBeNull(); // revoked → no token-mint/write-back

    // A webhook for an account with NO connection is a no-op (the callback hasn't created it yet).
    expect(await store.updateInstallationByAccount('never-installed', '999')).toBe(false);
  });

  it('DB-ENFORCED re-bind guard: one github account cannot be bound to TWO orgs (the partial unique blocks it)', async () => {
    const store = new PgCoordinationStore(pool);
    await pool.query(`INSERT INTO organization (id, name) VALUES ('cu_org2','CU2') ON CONFLICT (id) DO NOTHING`);
    await store.upsertGitHubInstallation('cu_org', { workspaceId: 'beta', installationId: '1' });
    // A DIFFERENT org binding the SAME github account violates the github-account unique → throws.
    // (This is the hard guarantee behind the connect callback's re-bind guard, race-proof.)
    await expect(
      store.upsertGitHubInstallation('cu_org2', { workspaceId: 'beta', installationId: '2' })
    ).rejects.toThrow();
    // The same org re-binding (idempotent re-install) is fine — refreshes installation_id.
    await store.upsertGitHubInstallation('cu_org', { workspaceId: 'beta', installationId: '3' });
    expect(await store.getInstallationIdForOwner('beta')).toBe('3');
  });
});

run('org roster (Postgres) — hire/unhire, org-scoped candidate set, label resolution (slice 5d)', () => {
  const SCHEMA = 'roster_slice5d_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    for (const ddl of IDENTITY_SCHEMA_DDL) await pool.query(ddl); // rbac_role + agent + ...
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl); // organization (+ org_default)
    await pool.query(ORG_AGENT_TABLE_DDL); // the org↔agent join (FKs organization + agent)
    // Two orgs, three global agents (agents stay GLOBAL — no org_id on the agent table).
    await pool.query(`INSERT INTO organization (id, name) VALUES ('o_a','A'),('o_b','B') ON CONFLICT (id) DO NOTHING`);
    await pool.query(
      `INSERT INTO agent (id, name, model, status) VALUES
         ('agent-elvis','Elvis','claude-x','active'),
         ('agent-mona','Mona','gpt-x','active'),
         ('agent-qwen','Qwen-1','local-x','paused')`
    );
  });
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('hire is idempotent (ok then already_hired); unknown agent → not_found', async () => {
    const roster = new PgOrgRosterRepo(pool);
    expect(await roster.hire('o_a', 'agent-elvis')).toBe('ok');
    expect(await roster.hire('o_a', 'agent-elvis')).toBe('already_hired'); // PK makes it idempotent
    expect(await roster.hire('o_a', 'ghost')).toBe('not_found'); // FK violation → not_found, not a throw
    expect(await roster.isHired('o_a', 'agent-elvis')).toBe(true);
    await roster.unhire('o_a', 'agent-elvis'); // clean up for later tests
  });

  it('the candidate set is ORG-SCOPED: org A never sees an agent only org B hired', async () => {
    const roster = new PgOrgRosterRepo(pool);
    await roster.hire('o_a', 'agent-elvis');
    await roster.hire('o_b', 'agent-mona');
    // A's roster is exactly {elvis}; B's is exactly {mona}. A global agent the org hasn't hired
    // (mona for A, elvis for B) is STRUCTURALLY ABSENT from the org's candidate ids — the tenant
    // boundary on the candidate set, so routing in A can never pick mona.
    expect(await roster.hiredAgentIds('o_a')).toEqual(['agent-elvis']);
    expect(await roster.hiredAgentIds('o_b')).toEqual(['agent-mona']);
    expect(await roster.isHired('o_a', 'agent-mona')).toBe(false); // available globally, NOT hired by A
    // unhire is org-scoped too: B unhiring elvis (which B never hired) removes nothing.
    expect(await roster.unhire('o_b', 'agent-elvis')).toBe(false);
    expect(await roster.hiredAgentIds('o_b')).toEqual(['agent-mona']); // unchanged
  });

  it('listHired joins name+status; findHiredAgentByName resolves WITHIN the hired set, case-insensitively', async () => {
    const roster = new PgOrgRosterRepo(pool);
    // o_a currently has elvis hired (from the previous test); add qwen.
    await roster.hire('o_a', 'agent-qwen');
    const hired = await roster.listHired('o_a');
    expect(hired).toEqual([
      { agentId: 'agent-elvis', name: 'Elvis', status: 'active' },
      { agentId: 'agent-qwen', name: 'Qwen-1', status: 'paused' },
    ]); // ordered by name
    // Label resolution is a preference WITHIN the hired set, case-insensitive on name.
    expect(await roster.findHiredAgentByName('o_a', 'elvis')).toBe('agent-elvis');
    expect(await roster.findHiredAgentByName('o_a', 'ELVIS')).toBe('agent-elvis');
    // mona is global+available but NOT hired by A → label resolves to null (fail-closed boundary).
    expect(await roster.findHiredAgentByName('o_a', 'Mona')).toBeNull();
    expect(await roster.findHiredAgentByName('o_a', 'nobody')).toBeNull();
  });

  it('ON DELETE CASCADE: retiring an agent drops its roster rows', async () => {
    const roster = new PgOrgRosterRepo(pool);
    await roster.hire('o_b', 'agent-qwen');
    expect(await roster.isHired('o_b', 'agent-qwen')).toBe(true);
    await pool.query(`DELETE FROM agent WHERE id = 'agent-qwen'`); // global retire
    expect(await roster.isHired('o_b', 'agent-qwen')).toBe(false); // roster row cascaded away
    expect(await roster.isHired('o_a', 'agent-qwen')).toBe(false);
  });
});
