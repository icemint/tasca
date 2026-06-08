import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgDispatchQueue, DISPATCH_JOB_DDL } from './index';

// The exactly-once proof for the dispatch queue — the same forced-parallelism
// discipline that proved the claim CAS. Runs only against a real Postgres.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Block until `n` sessions are waiting on the exclusive advisory lock `gateKey`. */
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

run('PgDispatchQueue (Postgres) — exactly-once dispatch under concurrent runners', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(DISPATCH_JOB_DDL);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE dispatch_job');
  });

  it('TWO RUNNERS NEVER BOTH PULL THE SAME JOB: N claimers race one job → exactly one wins', async () => {
    const N = 50;
    const GATE = 615243;
    const racePool = new Pool({ connectionString: url, max: N + 4 });
    try {
      const { id: jobId } = await new PgDispatchQueue(racePool).enqueue({ taskId: 't1', payload: { a: 1 } });

      // Hold the gate; every claimer blocks on a shared acquire until release.
      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      const claimers = Array.from({ length: N }, (_, i) =>
        (async () => {
          const client = await racePool.connect();
          try {
            await client.query('SELECT pg_advisory_lock_shared($1)', [GATE]); // parks here
            return await new PgDispatchQueue(client).claimNext(`runner-${i}`, 30);
          } finally {
            await client.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
            client.release();
          }
        })()
      );

      await waitForWaiters(racePool, GATE, N); // all parked
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE]); // release the hounds
      gate.release();

      const results = await Promise.all(claimers);
      const winners = results.filter((r) => r !== null);
      // Exactly one claimer got the job; everyone else saw it already taken (null).
      expect(winners).toHaveLength(1);
      expect(winners[0]!.id).toBe(jobId);
      expect(winners[0]!.attempts).toBe(1);
      // The row is `claimed`, attempted exactly once — not double-incremented.
      const row = await racePool.query<{ status: string; attempts: number }>(
        'SELECT status, attempts FROM dispatch_job WHERE id=$1',
        [jobId]
      );
      expect(row.rows[0]).toMatchObject({ status: 'claimed', attempts: 1 });
    } finally {
      await racePool.end();
    }
  });

  it('DRAIN: N jobs across M concurrent looping claimers → each job claimed exactly once, none lost', async () => {
    const JOBS = 200;
    const CLAIMERS = 16;
    const racePool = new Pool({ connectionString: url, max: CLAIMERS + 2 });
    try {
      const enq = new PgDispatchQueue(racePool);
      const ids = new Set<string>();
      for (let i = 0; i < JOBS; i++) ids.add((await enq.enqueue({ taskId: `t${i}`, payload: { i } })).id);

      // Each claimer loops claimNext on its own connection until the queue is dry.
      const claimers = Array.from({ length: CLAIMERS }, (_, c) =>
        (async () => {
          const client = await racePool.connect();
          const got: string[] = [];
          try {
            const q = new PgDispatchQueue(client);
            for (;;) {
              const job = await q.claimNext(`runner-${c}`, 30);
              if (!job) break;
              got.push(job.id);
            }
          } finally {
            client.release();
          }
          return got;
        })()
      );

      const claimedLists = await Promise.all(claimers);
      const allClaimed = claimedLists.flat();
      // Exactly-once: every job claimed, none claimed twice, none invented.
      expect(allClaimed).toHaveLength(JOBS);
      expect(new Set(allClaimed).size).toBe(JOBS);
      expect(new Set(allClaimed)).toEqual(ids);
    } finally {
      await racePool.end();
    }
  });
});

run('PgDispatchQueue (Postgres) — lifecycle: lease reclaim, complete, release, fail', () => {
  let pool: Pool;
  let q: PgDispatchQueue;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(DISPATCH_JOB_DDL);
    q = new PgDispatchQueue(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE dispatch_job');
  });

  it('a claimed job is not re-claimable until its lease lapses; reclaimExpired requeues it', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const first = await q.claimNext('r1', 30);
    expect(first).not.toBeNull();
    // Held under lease → a second runner gets nothing.
    expect(await q.claimNext('r2', 30)).toBeNull();

    // Simulate the runner crashing: force the lease into the past, then reclaim.
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [first!.id]);
    expect(await q.reclaimExpired()).toBe(1);

    // Now re-claimable, with attempts incremented (it's a retry).
    const second = await q.claimNext('r2', 30);
    expect(second!.id).toBe(first!.id);
    expect(second!.attempts).toBe(2);
  });

  it('complete makes a job terminal (never re-claimed)', async () => {
    const { id } = await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    await q.complete(job!.id);
    expect(await q.claimNext('r1', 30)).toBeNull();
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
    expect(await q.reclaimExpired()).toBe(0); // done jobs are not reclaimed
  });

  it('release returns a job to the queue, honoring a delay before it is claimable again', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    await q.release(job!.id, { delaySeconds: 60 });
    // Delayed → not yet claimable.
    expect(await q.claimNext('r2', 30)).toBeNull();
    // Make it available and confirm it comes back.
    await pool.query(`UPDATE dispatch_job SET available_at = now() WHERE id=$1`, [job!.id]);
    expect((await q.claimNext('r2', 30))!.id).toBe(job!.id);
  });

  it('fail makes a job terminal and records the error', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    await q.fail(job!.id, 'boom');
    expect(await q.claimNext('r1', 30)).toBeNull();
    const row = await pool.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM dispatch_job WHERE id=$1',
      [job!.id]
    );
    expect(row.rows[0]).toMatchObject({ status: 'failed', last_error: 'boom' });
  });

  it('claimNext returns null on an empty queue', async () => {
    expect(await q.claimNext('r1', 30)).toBeNull();
  });
});
