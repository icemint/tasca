import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { TASK_STATUSES } from '@tasca/domain';
import { PgClaimRepository, TASK_TABLE_DDL } from './index';

// The real concurrency proof. Runs only when DATABASE_URL points at a Postgres;
// otherwise skipped (kept green in environments without a DB).
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Block until `n` sessions are *waiting* on the exclusive advisory lock `gateKey`.
 * Single-bigint advisory locks under 2^32 register in pg_locks as
 * (classid=0, objid=key, objsubid=1). Used to know every worker has reached the
 * gate before we release them all at once.
 */
async function waitForWaiters(pool: Pool, gateKey: number, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND NOT granted`,
      [gateKey]
    );
    if ((r.rows[0]?.c ?? 0) >= n) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${n} advisory-lock waiters`);
}

run('PgClaimRepository CAS (Postgres) — exactly one claim wins', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(TASK_TABLE_DDL);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('exactly one wins when N transactions are released to race the row simultaneously', async () => {
    const N = 50;
    const GATE = 918273; // advisory-lock latch key
    // A pool big enough to hold every worker's connection + the gate holder at once,
    // so all N UPDATEs are genuinely in-flight against the same row (not pool-serialized).
    const racePool = new Pool({ connectionString: url, max: N + 4 });
    const taskId = 'task-cas-latch';
    try {
      await racePool.query('DELETE FROM task WHERE id=$1', [taskId]);
      await racePool.query(
        `INSERT INTO task (id, external_story_id, status, version) VALUES ($1,'s','routable',0)`,
        [taskId]
      );

      // Hold the gate exclusively; every worker will block on a *shared* acquire of it.
      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      // Each worker: own connection → block on the gate → the instant it releases,
      // run the conditional UPDATE. All N fire together → maximal row contention.
      const workers = Array.from({ length: N }, (_, i) =>
        (async () => {
          const client = await racePool.connect();
          try {
            await client.query('SELECT pg_advisory_lock_shared($1)', [GATE]); // parks here
            return await new PgClaimRepository(client).tryClaim(taskId, `agent-${i}`, 0);
          } finally {
            await client.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
            client.release();
          }
        })()
      );

      await waitForWaiters(racePool, GATE, N); // all N parked at the gate
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE]); // release the hounds
      gate.release();

      const results = await Promise.all(workers);
      expect(results.filter((r) => r.won).length).toBe(1);

      const row = await racePool.query<{ status: string; version: number; claimed_by: string }>(
        'SELECT status, version, claimed_by FROM task WHERE id=$1',
        [taskId]
      );
      expect(row.rows[0]!.status).toBe('claimed');
      expect(row.rows[0]!.version).toBe(1);
      expect(row.rows[0]!.claimed_by).toMatch(/^agent-/);
    } finally {
      await racePool.end();
    }
  });

  it('a stale-version claim after a win loses, and surfaces the current row state', async () => {
    const repo = new PgClaimRepository(pool);
    const taskId = 'task-cas-stale';
    await pool.query('DELETE FROM task WHERE id=$1', [taskId]);
    await pool.query(
      `INSERT INTO task (id, external_story_id, status, version) VALUES ($1,'s2','routable',0)`,
      [taskId]
    );
    const first = await repo.tryClaim(taskId, 'a', 0);
    const stale = await repo.tryClaim(taskId, 'b', 0);
    expect(first.won).toBe(true);
    // A winning claim describes the post-claim row.
    expect(first).toMatchObject({ won: true, newVersion: 1, found: true, currentStatus: 'claimed', currentVersion: 1 });
    // The stale loser learns WHY: the row is now claimed at version 1 (not a
    // retryable routable state) — enough to decide terminal vs retry.
    expect(stale).toMatchObject({ won: false, newVersion: null, found: true, currentStatus: 'claimed', currentVersion: 1 });
  });

  it('distinguishes a lost-race loss (row claimed) from a missing task', async () => {
    const repo = new PgClaimRepository(pool);
    // Missing task → found:false (terminal: never retryable).
    const missing = await repo.tryClaim('task-cas-does-not-exist', 'a', 0);
    expect(missing).toMatchObject({ won: false, found: false, currentStatus: null, currentVersion: null });

    // A loser in the race learns the row is claimed at v1 (lost-race, terminal here).
    const taskId = 'task-cas-loser-state';
    await pool.query('DELETE FROM task WHERE id=$1', [taskId]);
    await pool.query(
      `INSERT INTO task (id, external_story_id, status, version) VALUES ($1,'s3','routable',0)`,
      [taskId]
    );
    await repo.tryClaim(taskId, 'winner', 0);
    const loser = await repo.tryClaim(taskId, 'loser', 0);
    expect(loser).toMatchObject({ won: false, found: true, currentStatus: 'claimed', currentVersion: 1 });
  });

  it('storage rejects an illegal status (task_status_chk)', async () => {
    // Self-sufficient: on a fresh DB the CHECK comes from TASK_TABLE_DDL, but on a
    // dirty persistent DB an older `task` predating the CHECK would let CREATE
    // TABLE IF NOT EXISTS skip it. Ensure the constraint idempotently so the test
    // asserts the CHECK's behavior regardless of how the table was created.
    const statusIn = TASK_STATUSES.map((s) => `'${s}'`).join(', ');
    await pool.query(
      `DO $$ BEGIN
         ALTER TABLE task ADD CONSTRAINT task_status_chk CHECK (status IN (${statusIn}));
       EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
    );
    await expect(
      pool.query(
        `INSERT INTO task (id, external_story_id, status, version) VALUES ('task-cas-badstatus','s','bogus',0)`
      )
    ).rejects.toThrow(/task_status_chk|violates check constraint/);
  });
});
