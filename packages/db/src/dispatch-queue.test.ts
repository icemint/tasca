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

  it('RACE: requestCancel vs beginPublish on one CLAIMED job → EXACTLY ONE wins (cancel hinge: no double-finalize, no zombie)', async () => {
    // The cancel-in-flight invariant: an operator's requestCancel (claimed→cancelled) and the
    // runner's beginPublish (claimed→publishing, its point-of-no-return before opening the PR)
    // both target the SAME claimed row. Postgres row-locking must let exactly one win — never
    // both (cancel AND a PR opened = double-finalize) and never neither (zombie). Force them.
    const GATE = 880011;
    const racePool = new Pool({ connectionString: url, max: 6 });
    try {
      const { id: jobId } = await new PgDispatchQueue(racePool).enqueue({ taskId: 't-cancelrace', payload: {} });
      const claimed = await new PgDispatchQueue(racePool).claimNext('runner-1', 30);
      const fence = claimed!.fence;

      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      const canceller = (async () => {
        const c = await racePool.connect();
        try {
          await c.query('SELECT pg_advisory_lock_shared($1)', [GATE]);
          return { who: 'cancel', result: await new PgDispatchQueue(c).requestCancel(jobId) };
        } finally {
          await c.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
          c.release();
        }
      })();
      const publisher = (async () => {
        const c = await racePool.connect();
        try {
          await c.query('SELECT pg_advisory_lock_shared($1)', [GATE]);
          return { who: 'publish', won: await new PgDispatchQueue(c).beginPublish(jobId, fence) };
        } finally {
          await c.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
          c.release();
        }
      })();

      await waitForWaiters(racePool, GATE, 2);
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE]);
      gate.release();

      const [cancel, publish] = await Promise.all([canceller, publisher]);
      const cancelWon = cancel.result === 'signalled';
      const publishWon = publish.won === true;
      // EXACTLY ONE — never both (double-finalize), never neither (zombie).
      expect([cancelWon, publishWon].filter(Boolean)).toHaveLength(1);

      const row = await racePool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [jobId]);
      if (cancelWon) {
        expect(publish.won).toBe(false); // the runner aborts: no PR
        expect(row.rows[0]!.status).toBe('cancelled');
      } else {
        expect(cancel.result).toBe('too_late'); // the operator's cancel is a no-op
        expect(row.rows[0]!.status).toBe('publishing');
      }
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

  it('requestCancel: removes a queued job, signals a claimed one, is too_late once publishing/terminal', async () => {
    // queued → removed
    const { id: a } = await q.enqueue({ taskId: 't', payload: {} });
    expect(await q.requestCancel(a)).toBe('removed');
    expect(await q.claimNext('r', 30)).toBeNull(); // cancelled, not claimable

    // claimed → signalled (a runner holds it; it'll abort + revoke)
    const { id: b } = await q.enqueue({ taskId: 't', payload: {} });
    const jb = await q.claimNext('r1', 30);
    expect(jb!.id).toBe(b);
    expect(await q.requestCancel(b)).toBe('signalled');
    const row = await pool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [b]);
    expect(row.rows[0]!.status).toBe('cancelled');

    // publishing (point of no return passed) → too_late
    const { id: c } = await q.enqueue({ taskId: 't', payload: {} });
    const jc = await q.claimNext('r1', 30);
    expect(await q.beginPublish(jc!.id, jc!.fence)).toBe(true);
    expect(await q.requestCancel(c)).toBe('too_late');
  });

  it('beginPublish → complete: the normal finish path (claimed → publishing → done)', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    expect(await q.beginPublish(job!.id, job!.fence)).toBe(true);
    expect(await q.complete(job!.id, job!.fence, { prUrl: 'u' })).toBe(true);
    const row = await pool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [job!.id]);
    expect(row.rows[0]!.status).toBe('done');
  });

  it('renewLease keeps a PUBLISHING job alive (a slow openPr must not let the lease lapse)', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    expect(await q.beginPublish(job!.id, job!.fence)).toBe(true);
    // The runner's heartbeat fires during openPr — it must still renew while publishing,
    // else the lease lapses and sweep could reclaim a live publisher out from under it.
    expect(await q.renewLease(job!.id, job!.fence, 30)).toBe(true);
    // Fenced: a stale fence never renews, even on a publishing row.
    expect(await q.renewLease(job!.id, job!.fence + 1, 30)).toBe(false);
  });

  it('release requeues a PUBLISHING job (openPr threw after beginPublish) — prompt re-drive, fenced', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    expect(await q.beginPublish(job!.id, job!.fence)).toBe(true);
    // A stale fence cannot clobber a publishing row.
    expect(await q.release(job!.id, job!.fence + 1, { delaySeconds: 0 })).toBe(false);
    // The holding runner releases for an idempotent re-drive instead of waiting for the lease.
    expect(await q.release(job!.id, job!.fence, { delaySeconds: 0 })).toBe(true);
    expect((await q.claimNext('r2', 30))!.id).toBe(job!.id); // claimable again
  });

  it('fail records a terminal failure from a PUBLISHING row (fenced) — drives the breaker without stranding', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = await q.claimNext('r1', 30);
    expect(await q.beginPublish(job!.id, job!.fence)).toBe(true);
    expect(await q.fail(job!.id, job!.fence + 1, 'x')).toBe(false); // stale fence rejected
    expect(await q.fail(job!.id, job!.fence, 'openPr exhausted retries')).toBe(true);
    const row = await pool.query<{ status: string; last_error: string }>('SELECT status, last_error FROM dispatch_job WHERE id=$1', [job!.id]);
    expect(row.rows[0]).toMatchObject({ status: 'failed', last_error: 'openPr exhausted retries' });
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

// The reaper seam: the runner writes its result back to the queue (complete carries the
// PR url), then coordination's reaper leases finished jobs (claimFinished), finalizes,
// and deletes them (markReaped). sweepExpired is the runner-path safety net.
run('PgDispatchQueue (Postgres) — reaper seam: complete-with-result, claimFinished, markReaped, sweepExpired', () => {
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

  it('complete stores the runner result; claimFinished leases it for the reaper; markReaped deletes it', async () => {
    await q.enqueue({ taskId: 't-done', payload: { repoRef: 'acme/widgets' } });
    const job = (await q.claimNext('r1', 30))!;
    expect(await q.complete(job.id, job.fence, { prUrl: 'https://github.com/acme/widgets/pull/9' })).toBe(true);

    const finished = await q.claimFinished(10, 30);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      id: job.id,
      taskId: 't-done',
      status: 'done',
      result: { prUrl: 'https://github.com/acme/widgets/pull/9' },
    });

    // Leased → a concurrent reaper sweep skips it (reaping_at is in the future).
    expect(await q.claimFinished(10, 30)).toHaveLength(0);

    await q.markReaped(job.id);
    const row = await pool.query('SELECT 1 FROM dispatch_job WHERE id=$1', [job.id]);
    expect(row.rowCount).toBe(0);
  });

  it('claimFinished re-selects a job whose reaping lease lapsed (a reaper crash never strands it)', async () => {
    await q.enqueue({ taskId: 't', payload: {} });
    const job = (await q.claimNext('r1', 30))!;
    await q.complete(job.id, job.fence, { prUrl: 'x' });
    expect(await q.claimFinished(10, 30)).toHaveLength(1); // leased
    // Simulate the reaper dying mid-finalize: force the reaping lease into the past.
    await pool.query(`UPDATE dispatch_job SET reaping_at = now() - interval '1 second' WHERE id=$1`, [job.id]);
    const again = await q.claimFinished(10, 30);
    expect(again).toHaveLength(1); // re-selected, status still the source of truth
    expect(again[0]!.status).toBe('done');
  });

  it('claimFinished returns failed jobs too (the reaper drives their breaker), with the error', async () => {
    await q.enqueue({ taskId: 't-fail', payload: {} });
    const job = (await q.claimNext('r1', 30))!;
    await q.fail(job.id, job.fence, 'no committed changes');
    const finished = await q.claimFinished(10, 30);
    expect(finished[0]).toMatchObject({ taskId: 't-fail', status: 'failed', lastError: 'no committed changes' });
  });

  it('sweepExpired requeues an expired claim under the cap, but FAILS OVER one at the cap', async () => {
    // Under the cap (attempts=1, cap=3): a dead runner's claim is requeued for retry.
    await q.enqueue({ taskId: 't-retry', payload: {} });
    const a = (await q.claimNext('r1', 30))!;
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [a.id]);

    // At the cap (force attempts up to the cap): a dead runner's claim fails over.
    await q.enqueue({ taskId: 't-giveup', payload: {} });
    const b = (await q.claimNext('r2', 30))!;
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second', attempts = 3 WHERE id=$1`, [b.id]);

    const swept = await q.sweepExpired(3);
    expect(swept).toEqual({ reclaimed: 1, failedOver: 1 });

    // The under-cap job is claimable again; the at-cap job is terminal failed.
    const re = await q.claimNext('r3', 30);
    expect(re!.id).toBe(a.id);
    const failedRow = await pool.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM dispatch_job WHERE id=$1',
      [b.id]
    );
    expect(failedRow.rows[0]).toMatchObject({ status: 'failed', last_error: 'exceeded max dispatch attempts' });
  });

  it('sweepExpired recovers a PUBLISHING job whose runner died (no zombie): requeues under cap, fails over at cap', async () => {
    // The runner won beginPublish (claimed→publishing) then DIED before complete — without
    // covering `publishing`, sweep would leave it stranded forever (never finalized, never
    // re-claimable). Under the cap it must requeue (openPr is idempotent → safe re-drive).
    await q.enqueue({ taskId: 't-pub-retry', payload: {} });
    const a = (await q.claimNext('r1', 30))!;
    expect(await q.beginPublish(a.id, a.fence)).toBe(true);
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [a.id]);

    // A publishing job at the attempts cap fails over rather than looping forever.
    await q.enqueue({ taskId: 't-pub-giveup', payload: {} });
    const b = (await q.claimNext('r2', 30))!;
    expect(await q.beginPublish(b.id, b.fence)).toBe(true);
    await pool.query(`UPDATE dispatch_job SET lease_expires_at = now() - interval '1 second', attempts = 3 WHERE id=$1`, [b.id]);

    const swept = await q.sweepExpired(3);
    expect(swept).toEqual({ reclaimed: 1, failedOver: 1 });
    expect((await q.claimNext('r3', 30))!.id).toBe(a.id); // re-drivable, not a zombie
    const failed = await pool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE id=$1', [b.id]);
    expect(failed.rows[0]!.status).toBe('failed');
  });
});
