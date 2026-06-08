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

  it('RACE: cancel vs claimNext on one job → EXACTLY ONE wins (the fallback safety hinge: no double-run, no orphan)', async () => {
    // The migration safety net rests on this: coordination's cancel (DELETE WHERE
    // queued) and a runner's claimNext (UPDATE WHERE queued) both target the SAME
    // queued row. Postgres row-locking must let exactly one win — never both (double
    // dispatch) and never neither (orphaned job, silent stall). Force them to race.
    const GATE = 771122;
    const racePool = new Pool({ connectionString: url, max: 6 });
    try {
      const { id: jobId } = await new PgDispatchQueue(racePool).enqueue({ taskId: 't-race', payload: {} });

      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      const canceller = (async () => {
        const c = await racePool.connect();
        try {
          await c.query('SELECT pg_advisory_lock_shared($1)', [GATE]);
          return { who: 'cancel', won: await new PgDispatchQueue(c).cancel(jobId) };
        } finally {
          await c.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
          c.release();
        }
      })();
      const claimer = (async () => {
        const c = await racePool.connect();
        try {
          await c.query('SELECT pg_advisory_lock_shared($1)', [GATE]);
          return { who: 'claim', won: (await new PgDispatchQueue(c).claimNext('runner-1', 30)) !== null };
        } finally {
          await c.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
          c.release();
        }
      })();

      await waitForWaiters(racePool, GATE, 2);
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE]);
      gate.release();

      const [a, b] = await Promise.all([canceller, claimer]);
      // EXACTLY ONE side won — never both (double-run), never neither (orphan/stall).
      expect([a.won, b.won].filter(Boolean)).toHaveLength(1);

      // Cross-check the row: if cancel won, the row is gone; if claim won, it's claimed.
      const row = await racePool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [jobId]);
      const cancelWon = (a.who === 'cancel' ? a.won : b.won);
      if (cancelWon) expect(row.rowCount).toBe(0);
      else expect(row.rows[0]!.status).toBe('claimed');
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
    expect(await q.complete(job!.id, job!.fence)).toBe(true);
    expect(await q.claimNext('r1', 30)).toBeNull();
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
    expect(await q.reclaimExpired()).toBe(0); // done jobs are not reclaimed
  });

  it('release returns a job to the queue, honoring a delay before it is claimable again', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    expect(await q.release(job!.id, job!.fence, { delaySeconds: 60 })).toBe(true);
    // Delayed → not yet claimable.
    expect(await q.claimNext('r2', 30)).toBeNull();
    // Make it available and confirm it comes back.
    await pool.query(`UPDATE dispatch_job SET available_at = now() WHERE id=$1`, [job!.id]);
    expect((await q.claimNext('r2', 30))!.id).toBe(job!.id);
  });

  it('fail makes a job terminal and records the error', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    expect(await q.fail(job!.id, job!.fence, 'boom')).toBe(true);
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

  it('cancel removes a still-queued job (true), but refuses one a runner already claimed (false)', async () => {
    // Unclaimed → cancel succeeds and the job is gone (the in-process fallback wins).
    const { id: a } = await q.enqueue({ taskId: 't', payload: {} });
    expect(await q.cancel(a)).toBe(true);
    expect(await q.claimNext('r', 30)).toBeNull(); // removed

    // Claimed by a runner → cancel refuses (false): coordination must defer to it.
    const { id: b } = await q.enqueue({ taskId: 't', payload: {} });
    const claimed = await q.claimNext('runner-1', 30);
    expect(claimed!.id).toBe(b);
    expect(await q.cancel(b)).toBe(false); // a runner owns it — not cancelable
  });
});

// The fencing token: a runner that overran its lease (reclaimed + re-claimed by
// another runner) MUST NOT be able to clobber the new owner's job. complete/release/
// fail are guarded by the claim epoch handed out at claim time.
run('PgDispatchQueue (Postgres) — fencing: a stale runner cannot clobber the new owner', () => {
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

  it('the canonical anomaly: R1 overruns lease → reclaimed → R2 re-claims → R1.complete is FENCED OUT', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const r1 = (await q.claimNext('r1', 30))!; // R1 holds fence=1

    // R1 stalls past its lease; the sweeper reclaims the job.
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [r1.id]);
    expect(await q.reclaimExpired()).toBe(1);

    // R2 legitimately re-claims it (fence advances to 2) and starts running.
    const r2 = (await q.claimNext('r2', 30))!;
    expect(r2.id).toBe(r1.id);
    expect(r2.fence).toBeGreaterThan(r1.fence);

    // R1 wakes and tries to finish — REJECTED (it lost the claim); the job is untouched.
    expect(await q.complete(r1.id, r1.fence)).toBe(false);
    let row = await pool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [r1.id]);
    expect(row.rows[0]!.status).toBe('claimed'); // still R2's, not flipped to done

    // R1's release/fail are fenced too (release must not resurrect R2's active job).
    expect(await q.release(r1.id, r1.fence)).toBe(false);
    expect(await q.fail(r1.id, r1.fence, 'late')).toBe(false);

    // R2, the rightful owner, completes successfully.
    expect(await q.complete(r2.id, r2.fence)).toBe(true);
    row = await pool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [r1.id]);
    expect(row.rows[0]!.status).toBe('done');
  });

  it('renewLease keeps a live long-running claim from being reclaimed; a stale fence cannot renew', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = (await q.claimNext('r1', 1))!; // short lease

    // The live runner heartbeats before the lease lapses → lease extended, not reclaimed.
    expect(await q.renewLease(job.id, job.fence, 60)).toBe(true);
    expect(await q.reclaimExpired()).toBe(0); // lease is in the future → not reclaimed
    expect(await q.claimNext('r2', 30)).toBeNull(); // still held by r1

    // A stale fence (e.g. after a real reclaim) cannot renew.
    expect(await q.renewLease(job.id, job.fence - 1, 60)).toBe(false);
  });
});
