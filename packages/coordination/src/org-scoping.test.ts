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
