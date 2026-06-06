import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgClaimRepository, TASK_TABLE_DDL } from './index';

// The real concurrency proof. Runs only when DATABASE_URL points at a Postgres;
// otherwise skipped (kept green in environments without a DB).
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('PgClaimRepository CAS (Postgres) — exactly one claim wins under real concurrency', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(TASK_TABLE_DDL);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('exactly one of N concurrent claims wins; the row ends claimed at v1', async () => {
    const repo = new PgClaimRepository(pool);
    const taskId = 'task-cas-1';
    await pool.query('DELETE FROM task WHERE id=$1', [taskId]);
    await pool.query(
      `INSERT INTO task (id, external_story_id, status, version) VALUES ($1,'s1','routable',0)`,
      [taskId]
    );

    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => repo.tryClaim(taskId, `agent-${i}`, 0))
    );
    const winners = results.filter((r) => r.won);
    expect(winners.length).toBe(1);
    expect(winners[0]!.newVersion).toBe(1);

    const row = await pool.query<{ status: string; version: number; claimed_by: string }>(
      'SELECT status, version, claimed_by FROM task WHERE id=$1',
      [taskId]
    );
    expect(row.rows[0]!.status).toBe('claimed');
    expect(row.rows[0]!.version).toBe(1);
    expect(row.rows[0]!.claimed_by).toMatch(/^agent-/);
  });

  it('a stale-version claim after a win loses', async () => {
    const repo = new PgClaimRepository(pool);
    const taskId = 'task-cas-2';
    await pool.query('DELETE FROM task WHERE id=$1', [taskId]);
    await pool.query(
      `INSERT INTO task (id, external_story_id, status, version) VALUES ($1,'s2','routable',0)`,
      [taskId]
    );
    const first = await repo.tryClaim(taskId, 'a', 0);
    const stale = await repo.tryClaim(taskId, 'b', 0);
    expect(first.won).toBe(true);
    expect(stale.won).toBe(false);
  });
});
