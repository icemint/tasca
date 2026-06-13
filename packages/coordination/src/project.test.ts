import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
import { AUTH_SCHEMA_DDL } from '@tasca/auth';
import {
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
  ORG_SCOPING_DDL,
  ORG_CONTRACT_DDL,
  ORG_DISPATCH_CONTRACT_DDL,
  PROJECT_TABLE_DDL,
  PROJECT_BACKFILL_DDL,
  COORDINATION_SCHEMA_DDL,
} from './schema';
import { ORG_MEMBERSHIP_TABLE_DDL, USER_ACTIVE_ORG_TABLE_DDL, USER_ACTIVE_PROJECT_TABLE_DDL } from './membership';
import { PgCoordinationStore } from './store';

// DB-backed proof of the Project-A slice. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

// The pre-Project-A schema (the org-scoped task layer, WITHOUT the project bits) — so we can seed
// "legacy" tasks linked only by repo_ref, then apply PROJECT_BACKFILL_DDL and prove the promotion.
const PRE_PROJECT_DDL = [
  TASK_TABLE_DDL,
  DISPATCH_JOB_DDL,
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
  ORG_SCOPING_DDL, // organization + org_default + task.org_id NOT NULL (the backfill depends on this)
  ORG_CONTRACT_DDL,
  ORG_DISPATCH_CONTRACT_DDL,
  PROJECT_TABLE_DDL, // the project table exists BEFORE the backfill (production order: it precedes it in COORDINATION_SCHEMA_DDL)
];

run('project backfill migration (slice Project-A) — promote repo_ref → structured project_id', () => {
  const SCHEMA = 'project_backfill_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    for (const ddl of PRE_PROJECT_DDL) await pool.query(ddl);

    // Two orgs, so we also prove cross-org isolation. org_default exists; add org_b.
    await pool.query(`INSERT INTO organization (id, name) VALUES ('org_b', 'B') ON CONFLICT (id) DO NOTHING`);

    // org_default: repo_refs {owner/a, owner/a, owner/b, NULL} → projects a, b + one Unassigned.
    const seed = (id: string, story: string, org: string, repo: string | null) =>
      pool.query(
        `INSERT INTO task (id, org_id, external_story_id, platform, status, repo_ref) VALUES ($1,$2,$3,'github','executing',$4)`,
        [id, org, story, repo]
      );
    await seed('da1', 'owner/a#1', 'org_default', 'owner/a');
    await seed('da2', 'owner/a#2', 'org_default', 'owner/a');
    await seed('db1', 'owner/b#1', 'org_default', 'owner/b');
    await seed('dn1', 'noref#1', 'org_default', null);
    // org_b: its OWN task with the SAME repo string — must get its own org_b project, not org_default's.
    await seed('bc1', 'owner/a#9', 'org_b', 'owner/a');

    // Apply the backfill TWICE — proving idempotency (deterministic ids → no dup, no error).
    await pool.query(PROJECT_BACKFILL_DDL);
    await pool.query(PROJECT_BACKFILL_DDL);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('creates one project per distinct (org, repo) + one Unassigned per org with a null-repo task', async () => {
    const r = await pool.query<{ org_id: string; name: string; repo_ref: string | null }>(
      `SELECT org_id, name, repo_ref FROM project`
    );
    // Order-independent (the DB collation orders names; the SET is what we assert).
    const key = (x: { org_id: string; name: string; repo_ref: string | null }) => `${x.org_id}|${x.name}|${x.repo_ref}`;
    expect(r.rows.map(key).sort()).toEqual(
      [
        { org_id: 'org_b', name: 'a', repo_ref: 'owner/a' }, // org_b's OWN project for the same repo string
        { org_id: 'org_default', name: 'Unassigned', repo_ref: null },
        { org_id: 'org_default', name: 'a', repo_ref: 'owner/a' }, // name = the repo's last path segment
        { org_id: 'org_default', name: 'b', repo_ref: 'owner/b' },
      ]
        .map(key)
        .sort()
    );
  });

  it('backfills EXHAUSTIVELY — every task.project_id set, NOT NULL holds, correct project', async () => {
    const nulls = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM task WHERE project_id IS NULL`);
    expect(nulls.rows[0]!.c).toBe(0); // the SET NOT NULL safety net could not have fired

    // Each task points at the project for its (org, repo); the two owner/a tasks share ONE project.
    const rows = await pool.query<{ id: string; pid: string; pname: string; prepo: string | null; porg: string }>(
      `SELECT t.id, p.id AS pid, p.name AS pname, p.repo_ref AS prepo, p.org_id AS porg
         FROM task t JOIN project p ON p.id = t.project_id ORDER BY t.id`
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
    expect(byId.da1!.pid).toBe(byId.da2!.pid); // same repo → SAME project id (no duplicate)
    expect(byId.da1!.pname).toBe('a');
    expect(byId.db1!.pname).toBe('b');
    expect(byId.dn1).toMatchObject({ pname: 'Unassigned', prepo: null, porg: 'org_default' });
    // CROSS-ORG: org_b's owner/a task points at org_b's project, never org_default's.
    expect(byId.bc1!.porg).toBe('org_b');
    expect(byId.bc1!.prepo).toBe('owner/a');
    expect(byId.da1!.porg).toBe('org_default');
  });

  it('idempotent re-run: no duplicate projects, identical mapping (deterministic ids)', async () => {
    // The migration already ran twice in beforeAll. Run it a THIRD time → still no dup / no error.
    const before = await pool.query<{ id: string }>(`SELECT id FROM project ORDER BY id`);
    await pool.query(PROJECT_BACKFILL_DDL);
    const after = await pool.query<{ id: string }>(`SELECT id FROM project ORDER BY id`);
    expect(after.rows).toEqual(before.rows); // same set of project ids, same count
    expect(after.rows).toHaveLength(4); // a/b/Unassigned (org_default) + a (org_b)
  });

  it('the project ids are DETERMINISTIC: re-deriving the seed maps to the SAME id', async () => {
    // The store's getOrCreateProject must agree with the migration on the id — proven directly by
    // the seed formula `proj_ || md5(org || ' ' || repo-or-∅)`.
    const expected = await pool.query<{ id: string }>(
      `SELECT 'proj_' || md5('org_default' || ' ' || 'owner/a') AS id`
    );
    const actual = await pool.query<{ id: string }>(
      `SELECT id FROM project WHERE org_id = 'org_default' AND repo_ref = 'owner/a'`
    );
    expect(actual.rows[0]!.id).toBe(expected.rows[0]!.id);
  });
});

run('PgCoordinationStore — project resolution, listing, active-project (slice Project-A)', () => {
  const SCHEMA = 'project_store_test';
  let pool: Pool;
  let store: PgCoordinationStore;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    await pool.query(DISPATCH_JOB_DDL);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl); // app_user
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl); // organization + project + task.project_id
    await pool.query(ORG_MEMBERSHIP_TABLE_DDL);
    await pool.query(USER_ACTIVE_ORG_TABLE_DDL);
    await pool.query(USER_ACTIVE_PROJECT_TABLE_DDL);
    store = new PgCoordinationStore(pool);

    // Two orgs + a user who is a member of org_a (their active org), plus an outsider project in org_b.
    await pool.query(`INSERT INTO organization (id, name) VALUES ('org_a','A'),('org_b','B') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO app_user (id, email) VALUES ('u1','u1@x.test')`);
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('u1','org_a','owner')`);
    await pool.query(`INSERT INTO user_active_org (user_id, org_id) VALUES ('u1','org_a')`);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('getOrCreateProject: creates a per-repo project, then RESOLVES the existing one (idempotent)', async () => {
    const p1 = await store.getOrCreateProject('org_a', 'owner/widgets');
    const p2 = await store.getOrCreateProject('org_a', 'owner/widgets');
    expect(p1).toBe(p2); // same (org, repo) → same project
    const row = await pool.query<{ name: string; repo_ref: string }>(`SELECT name, repo_ref FROM project WHERE id = $1`, [p1]);
    expect(row.rows[0]).toEqual({ name: 'widgets', repo_ref: 'owner/widgets' }); // last-segment name
  });

  it('getOrCreateProject: a NULL repo resolves the org’s single Unassigned project', async () => {
    const u1 = await store.getOrCreateProject('org_a', null);
    const u2 = await store.getOrCreateProject('org_a', null);
    expect(u1).toBe(u2);
    const row = await pool.query<{ name: string; repo_ref: string | null }>(`SELECT name, repo_ref FROM project WHERE id = $1`, [u1]);
    expect(row.rows[0]).toEqual({ name: 'Unassigned', repo_ref: null });
  });

  it('getOrCreateTask sets task.project_id from its repoRef', async () => {
    const task = await store.getOrCreateTask('org_a', { externalStoryId: 'owner/svc#1', platform: 'github', repoRef: 'owner/svc' });
    const expected = await store.getOrCreateProject('org_a', 'owner/svc');
    const row = await pool.query<{ project_id: string }>(`SELECT project_id FROM task WHERE id = $1`, [task.id]);
    expect(row.rows[0]!.project_id).toBe(expected); // structured link set, agreeing with getOrCreateProject
  });

  it('listProjects is ORG-SCOPED + name-ordered — never another org’s projects', async () => {
    await store.getOrCreateProject('org_b', 'foreign/repo'); // an org_b project u1 must NOT see
    const projects = await store.listProjects('org_a');
    expect(projects.every((p) => p.repoRef !== 'foreign/repo')).toBe(true); // org-scoped: no org_b project
    expect(projects.map((p) => p.name)).toContain('widgets');
    // Name-ordered per the DB collation — assert against a raw ORDER BY name (not a JS sort, whose
    // UTF-16 order disagrees with PG's collation on 'Unassigned' vs lowercase names).
    const ordered = await pool.query<{ name: string }>(
      `SELECT name FROM project WHERE org_id = 'org_a' ORDER BY name, id`
    );
    expect(projects.map((p) => p.name)).toEqual(ordered.rows.map((r) => r.name));
  });

  it('listTasks filters by projectId; absent → all of the org’s tasks', async () => {
    await store.getOrCreateTask('org_a', { externalStoryId: 'owner/a#1', platform: 'github', repoRef: 'owner/a' });
    await store.getOrCreateTask('org_a', { externalStoryId: 'owner/b#1', platform: 'github', repoRef: 'owner/b' });
    const projA = await store.getOrCreateProject('org_a', 'owner/a');

    const all = await store.listTasks('org_a');
    const filtered = await store.listTasks('org_a', { projectId: projA });
    expect(all.length).toBeGreaterThan(filtered.length); // the filter narrows
    expect(filtered.every((t) => t.repoRef === 'owner/a')).toBe(true); // only project-a tasks
  });

  it('setActiveProject REJECTS a foreign-org project (not_found — no existence oracle) + ACCEPTS an in-org one; getActiveProject round-trips', async () => {
    const inOrg = await store.getOrCreateProject('org_a', 'owner/widgets');
    const foreign = await store.getOrCreateProject('org_b', 'foreign/repo');

    // Foreign-org project → 'not_found' (indistinguishable from a nonexistent id — no cross-tenant
    // existence oracle), never activated.
    expect(await store.setActiveProject('u1', foreign)).toBe('not_found');
    expect(await store.getActiveProject('u1')).toBeNull(); // nothing activated

    // Unknown project → also 'not_found' (same outcome as the foreign one, by design).
    expect(await store.setActiveProject('u1', 'proj_does_not_exist')).toBe('not_found');

    // In-org project → ok, and getActiveProject reflects it.
    expect(await store.setActiveProject('u1', inOrg)).toBe('ok');
    expect(await store.getActiveProject('u1')).toBe(inOrg); // round-trips
  });

  it('getActiveProject returns null for a stale active project whose org is no longer the user’s active org', async () => {
    // u1 is parked on an org_a project (from the previous test). Switch their active org to org_b
    // (where they are NOT a member of record here) — the stale org_a selection must resolve to null.
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('u1','org_b','member') ON CONFLICT DO NOTHING`);
    await pool.query(`UPDATE user_active_org SET org_id = 'org_b' WHERE user_id = 'u1'`);
    expect(await store.getActiveProject('u1')).toBeNull(); // the org_a project is no longer in the active org
    // restore for any later ordering
    await pool.query(`UPDATE user_active_org SET org_id = 'org_a' WHERE user_id = 'u1'`);
  });
});
