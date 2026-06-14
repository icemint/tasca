import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { TASK_TABLE_DDL } from '@tasca/db';
import { AUTH_SCHEMA_DDL } from '@tasca/auth';
import { IDENTITY_SCHEMA_DDL } from '@tasca/identity';
import { COORDINATION_SCHEMA_DDL } from './schema';

// PG proof of the prod-critical status CHECK migration (EM v1 slice 2): the @tasca/db base task table
// creates task_status_chk INLINE with the OLD 8-status set; COORDINATION_SCHEMA_DDL must DROP+ADD it to
// the 9-status superset so a status='awaiting_clarification' UPDATE is accepted (it would VIOLATE the
// old CHECK otherwise). We deliberately apply TASK_TABLE_DDL FIRST (the old constraint), then the
// coordination bundle (the widening) — exactly the prod upgrade order — and prove:
//   1. an existing row is preserved (superset never rejects what was valid),
//   2. awaiting_clarification is now INSERTable/UPDATEable,
//   3. a bogus status is still rejected (the CHECK is widened, not removed),
//   4. re-applying the bundle is idempotent (DROP IF EXISTS + ADD).
// Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('task_status_chk widening for awaiting_clarification (EM v1 slice 2)', () => {
  const SCHEMA = 'em_status_migration_test';
  let pool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });

    // Apply the BASE task table first — it carries the OLD task_status_chk (no awaiting_clarification).
    await pool.query(TASK_TABLE_DDL);
    // Seed a pre-existing routable task UNDER THE OLD CONSTRAINT, to prove the widening never rejects a
    // row that was valid before. org_id is left NULL here (the base table allows it) — ORG_SCOPING_DDL in
    // the bundle backfills NULL org_ids onto the seeded org_default before adding the FK + NOT NULL, which
    // is exactly the real prod-upgrade path for a pre-org-scoping row.
    await pool.query(
      `INSERT INTO task (id, external_story_id, platform, status, version) VALUES ($1,'sc-old','shortcut','routable',0)`,
      [randomUUID()]
    );

    // Now apply the coordination bundle — including the DROP+ADD widening of task_status_chk.
    for (const ddl of IDENTITY_SCHEMA_DDL) await pool.query(ddl);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('preserves the pre-existing routable row (superset never rejects a previously-valid status)', async () => {
    const res = await pool.query<{ status: string }>(`SELECT status FROM task WHERE external_story_id = 'sc-old'`);
    expect(res.rows[0]!.status).toBe('routable');
  });

  it('accepts an UPDATE to awaiting_clarification (the old CHECK would have rejected it)', async () => {
    await pool.query(`UPDATE task SET status = 'awaiting_clarification' WHERE external_story_id = 'sc-old'`);
    const res = await pool.query<{ status: string }>(`SELECT status FROM task WHERE external_story_id = 'sc-old'`);
    expect(res.rows[0]!.status).toBe('awaiting_clarification');
  });

  it('still REJECTS a bogus status (the CHECK is widened, not dropped)', async () => {
    // UPDATE the existing row (no new INSERT → no project_id/org contract to satisfy) so the ONLY thing
    // under test is the status CHECK. A value outside the 9-status set must violate task_status_chk.
    await expect(
      pool.query(`UPDATE task SET status = 'not_a_status' WHERE external_story_id = 'sc-old'`)
    ).rejects.toThrow(/task_status_chk|check constraint/i);
  });

  it('is idempotent — re-applying the bundle does not error (DROP IF EXISTS + ADD)', async () => {
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
    // and awaiting_clarification is still valid after the re-apply (the prior test left sc-old there).
    await pool.query(`UPDATE task SET status = 'awaiting_clarification' WHERE external_story_id = 'sc-old'`);
    const res = await pool.query<{ status: string }>(`SELECT status FROM task WHERE external_story_id = 'sc-old'`);
    expect(res.rows[0]!.status).toBe('awaiting_clarification');
  });
});
