import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
import {
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
  ORG_SCOPING_DDL,
  ORG_CONTRACT_DDL,
  ORG_DISPATCH_CONTRACT_DDL,
} from './schema';

// DB-backed proof of the org_id migration (slice 3a). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

// The pre-3a schema (everything EXCEPT the org section) — so we can seed "legacy" rows
// with no org_id, then apply ORG_SCOPING_DDL and prove the backfill.
const PRE_ORG_DDL = [
  TASK_TABLE_DDL,
  DISPATCH_JOB_DDL,
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
];

run('org_id migration (slice 3a) — columns + backfill on an existing DB', () => {
  const SCHEMA = 'org_scoping_3a_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    for (const ddl of PRE_ORG_DDL) await pool.query(ddl);

    // Seed LEGACY rows (no org_id column yet): a task + its children + two independent
    // platform_connections (distinct on the old unique) + a webhook_event.
    await pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t1','acme/widgets#1','github','executing')`);
    await pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t2','acme/widgets#2','github','done')`);
    await pool.query(`INSERT INTO dispatch_job (id, task_id, payload, status) VALUES ($1,'t1','{}'::jsonb,'queued')`, [randomUUID()]);
    await pool.query(`INSERT INTO routing_decision (id, task_id, tier_estimate) VALUES ('rd1','t1','{}'::jsonb)`);
    await pool.query(`INSERT INTO pull_request (id, task_id, url, state) VALUES ('pr1','t2','https://github.com/acme/widgets/pull/9','merged')`);
    await pool.query(`INSERT INTO platform_connection (id, platform, workspace_id) VALUES ('pc1','github','acme')`);
    await pool.query(`INSERT INTO platform_connection (id, platform, workspace_id) VALUES ('pc2','shortcut','acme-sc')`);
    await pool.query(`INSERT INTO webhook_event (id, platform, external_event_id, payload) VALUES ('we1','github','evt-1','{}'::jsonb)`);

    // Apply the migration (twice — proving idempotency).
    await pool.query(ORG_SCOPING_DDL);
    await pool.query(ORG_SCOPING_DDL);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('creates the organization table + the default org', async () => {
    const r = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM organization`);
    expect(r.rows).toEqual([{ id: 'org_default', name: 'Default Organization' }]);
  });

  it('backfills EVERY legacy row to the default org — no row left null, no orphan', async () => {
    const tables = ['task', 'dispatch_job', 'routing_decision', 'pull_request', 'platform_connection', 'webhook_event'];
    for (const t of tables) {
      const nulls = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${t} WHERE org_id IS NULL`);
      expect(nulls.rows[0]!.c).toBe(0); // NOT NULL holds — nothing left behind
      const wrong = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${t} WHERE org_id <> 'org_default'`);
      expect(wrong.rows[0]!.c).toBe(0); // every row on the one default org — no cross-tenant smear
    }
  });

  it('children derive their org from their task via the FK chain (consistent, not guessed)', async () => {
    // dispatch_job/routing_decision belong to t1, pull_request to t2 — all → t*.org_id.
    const dj = await pool.query<{ org_id: string }>(`SELECT d.org_id FROM dispatch_job d JOIN task t ON t.id = d.task_id WHERE d.org_id = t.org_id`);
    expect(dj.rowCount).toBe(1);
    const rd = await pool.query<{ org_id: string }>(`SELECT r.org_id FROM routing_decision r JOIN task t ON t.id = r.task_id WHERE r.org_id = t.org_id`);
    expect(rd.rowCount).toBe(1);
    const pr = await pool.query<{ org_id: string }>(`SELECT p.org_id FROM pull_request p JOIN task t ON t.id = p.task_id WHERE p.org_id = t.org_id`);
    expect(pr.rowCount).toBe(1);
  });

  it('the transitional DEFAULT keeps EXISTING inserts (no org_id column) working — they land on the default org', async () => {
    // This is what makes 3a purely additive: the existing store/queue inserts don't set
    // org_id until 3b, so the column default must fill it (and satisfy NOT NULL).
    await pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t-noorg','acme/widgets#99','github','routable')`);
    const r = await pool.query<{ org_id: string }>(`SELECT org_id FROM task WHERE id='t-noorg'`);
    expect(r.rows[0]!.org_id).toBe('org_default');
  });

  it('the OLD tenant uniques still enforce (existing ON CONFLICT queries are NOT broken in 3a)', async () => {
    // 3a does NOT drop the un-prefixed uniques (that swap is coupled with the ON CONFLICT
    // change in 3b). So a dup on the old key is still rejected — existing code keeps working.
    await expect(
      pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t-dup','acme/widgets#1','github','routable')`)
    ).rejects.toThrow(); // (platform, external_story_id) still unique
    // And ON CONFLICT against the still-present old index resolves (proves it exists):
    await pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t-x','acme/widgets#1','github','routable') ON CONFLICT (platform, external_story_id) DO NOTHING`);
  });
});

run('org_id CONTRACT (slice 3b-2) — unique swap + ON CONFLICT lockstep + dropped default', () => {
  const SCHEMA = 'org_scoping_3b2_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    for (const ddl of PRE_ORG_DDL) await pool.query(ddl);

    // Seed legacy rows, including TWO platform_connections and a webhook_event that are
    // distinct on the OLD (platform, …) uniques — so when the swap re-prefixes with org_id,
    // proving they SURVIVE proves the swap didn't collide on the backfilled (single-org) data.
    await pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t1','acme/widgets#1','github','executing')`);
    await pool.query(`INSERT INTO platform_connection (id, platform, workspace_id) VALUES ('pc1','github','acme')`);
    await pool.query(`INSERT INTO platform_connection (id, platform, workspace_id) VALUES ('pc2','shortcut','acme-sc')`);
    await pool.query(`INSERT INTO webhook_event (id, platform, external_event_id, payload) VALUES ('we1','github','evt-1','{}'::jsonb)`);

    // Expand (3a) then Contract (3b-2). Both applied TWICE to prove idempotency — and the
    // contract step running AT ALL on backfilled data proves no unique collision (a colliding
    // CREATE UNIQUE INDEX would throw here and fail the suite).
    await pool.query(ORG_SCOPING_DDL);
    await pool.query(ORG_CONTRACT_DDL);
    await pool.query(ORG_SCOPING_DDL);
    await pool.query(ORG_CONTRACT_DDL);

    // A second org, for the cross-org same-sub-key proof below.
    await pool.query(`INSERT INTO organization (id, name) VALUES ('org_other','Other Org') ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('swaps the tenant uniques: the un-prefixed are dropped, the org-prefixed exist', async () => {
    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
      [SCHEMA]
    );
    const names = idx.rows.map((r) => r.indexname);
    // Un-prefixed gone (the swap dropped them, in lockstep with the store's ON CONFLICT change).
    expect(names).not.toContain('task_platform_story_uniq');
    // Org-prefixed present.
    expect(names).toContain('task_org_platform_story_uniq');
    expect(names).toContain('platform_connection_org_platform_workspace_uniq');
    expect(names).toContain('webhook_event_org_platform_event_uniq');
  });

  it('the swap did not collide on backfilled default-org data — every distinct sub-key survived', async () => {
    // All legacy rows backfilled onto the SAME default org; the old uniques guaranteed each
    // sub-key unique, so (org_id, …sub-key) is still unique → nothing was dropped by the swap.
    expect((await pool.query(`SELECT count(*)::int AS c FROM platform_connection`)).rows[0]!.c).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS c FROM webhook_event`)).rows[0]!.c).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS c FROM task`)).rows[0]!.c).toBe(1);
  });

  it('ON CONFLICT now resolves against the NEW org-prefixed uniques (store lockstep)', async () => {
    // Mirrors PgCoordinationStore.getOrCreateTask / recordWebhookEvent / upsertGitHubInstallation
    // after the swap — the ON CONFLICT target is the org-prefixed unique. A no-op re-insert of
    // the SAME (org_id, sub-key) must resolve to DO NOTHING/UPDATE, not error.
    await pool.query(
      `INSERT INTO task (id, org_id, external_story_id, platform, status) VALUES ('t-dup','org_default','acme/widgets#1','github','routable')
       ON CONFLICT (org_id, platform, external_story_id) DO NOTHING`
    );
    expect((await pool.query(`SELECT count(*)::int AS c FROM task`)).rows[0]!.c).toBe(1); // still one
    await pool.query(
      `INSERT INTO webhook_event (id, org_id, platform, external_event_id, payload) VALUES ('we-dup','org_default','github','evt-1','{}'::jsonb)
       ON CONFLICT (org_id, platform, external_event_id) DO NOTHING`
    );
    expect((await pool.query(`SELECT count(*)::int AS c FROM webhook_event`)).rows[0]!.c).toBe(1);
    await pool.query(
      `INSERT INTO platform_connection (id, org_id, platform, workspace_id) VALUES ('pc-dup','org_default','github','acme')
       ON CONFLICT (org_id, platform, workspace_id) DO NOTHING`
    );
    expect((await pool.query(`SELECT count(*)::int AS c FROM platform_connection`)).rows[0]!.c).toBe(2);
  });

  it('the SAME sub-key in a DIFFERENT org is now allowed (the unique is truly org-scoped)', async () => {
    // (platform, external_story_id) was globally unique; (org_id, platform, external_story_id)
    // is not — so org_other can hold the same story id as org_default without collision. This
    // is the multi-tenant property the swap exists to provide.
    await pool.query(`INSERT INTO task (id, org_id, external_story_id, platform, status) VALUES ('t-other','org_other','acme/widgets#1','github','routable')`);
    const r = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM task WHERE external_story_id = 'acme/widgets#1'`);
    expect(r.rows[0]!.c).toBe(2); // one per org — no cross-tenant collision
  });

  it('the transitional DEFAULT is dropped — an insert with NO org_id now FAILS (type-layer enforced)', async () => {
    // The whole point of the contract step: once the store sets org_id explicitly, the
    // data-layer fallback must NOT outlive it. A forgotten org_id is now a NOT-NULL violation,
    // never a silent default onto some tenant.
    await expect(
      pool.query(`INSERT INTO task (id, external_story_id, platform, status) VALUES ('t-noorg','acme/widgets#zzz','github','routable')`)
    ).rejects.toThrow(); // org_id NOT NULL, no default
  });
});

run('org_id DISPATCH CONTRACT (slice 3c) — dispatch_job default dropped in lockstep with enqueue', () => {
  const SCHEMA = 'org_scoping_3c_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    for (const ddl of PRE_ORG_DDL) await pool.query(ddl);
    // Expand (3a) → store contract (3b-2) → dispatch contract (3c). Twice, for idempotency.
    await pool.query(ORG_SCOPING_DDL);
    await pool.query(ORG_CONTRACT_DDL);
    await pool.query(ORG_DISPATCH_CONTRACT_DDL);
    await pool.query(ORG_SCOPING_DDL);
    await pool.query(ORG_CONTRACT_DDL);
    await pool.query(ORG_DISPATCH_CONTRACT_DDL);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('dispatch_job: an enqueue WITH org_id works (the queue writer now sets it)', async () => {
    // Mirrors PgDispatchQueue.enqueue after 3c — org_id is supplied explicitly.
    await pool.query(
      `INSERT INTO dispatch_job (id, org_id, task_id, payload) VALUES ($1,'org_default','t-3c','{}'::jsonb)`,
      [randomUUID()]
    );
    const r = await pool.query<{ org_id: string }>(`SELECT org_id FROM dispatch_job WHERE task_id='t-3c'`);
    expect(r.rows[0]!.org_id).toBe('org_default');
  });

  it('dispatch_job: the transitional DEFAULT is dropped — an INSERT with NO org_id now FAILS', async () => {
    // 3c drops dispatch_job's default in lockstep with enqueue setting org_id (per-writer
    // expand/contract). Before 3c this default kept the queue's inserts working; now a
    // forgotten org_id is a NOT-NULL violation, never a silent default. This is exactly the
    // bug the 3b-2 integration tests caught when the default was dropped one slice too early.
    await expect(
      pool.query(`INSERT INTO dispatch_job (id, task_id, payload) VALUES ($1,'t-noorg','{}'::jsonb)`, [randomUUID()])
    ).rejects.toThrow(); // org_id NOT NULL, no default
  });
});
