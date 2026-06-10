import type { Pool, PoolClient } from 'pg';
import type { ClaimPort, ClaimOutcome, TaskStatus } from '@tasca/domain';

/** A pool or a single checked-out connection — both expose `.query`. */
export type Queryable = Pool | PoolClient;

/**
 * Postgres implementation of the claim CAS (`@tasca/routing`'s `ClaimPort`).
 *
 * The conditional UPDATE is the hard exactly-one guarantee: only the row that is
 * still `routable` at the expected `version` is updated, and Postgres serializes
 * the concurrent writers on that single row — so under N racing claims, exactly
 * one UPDATE affects a row (rowCount === 1) and the rest affect none.
 */
export class PgClaimRepository implements ClaimPort {
  // Accepts a pool or a single connection so tests can drive the CAS on a
  // dedicated connection (needed for the forced-parallelism latch test).
  constructor(private readonly db: Queryable) {}

  async tryClaim(
    orgId: string,
    taskId: string,
    agentId: string,
    expectedVersion: number
  ): Promise<ClaimOutcome> {
    // Org-scoped CAS (slice 3c): the claim is a request-context write, so it carries org_id
    // like every other tenant write. The (id, version) pair already pins the row; AND org_id
    // is defense in depth — a task from another org can never be claimed by this org's loop.
    const res = await this.db.query<{ version: number }>(
      `UPDATE task
          SET status = 'claimed', claimed_by = $3, version = version + 1
        WHERE org_id = $1 AND id = $2 AND status = 'routable' AND version = $4
      RETURNING version`,
      [orgId, taskId, agentId, expectedVersion]
    );
    if (res.rowCount === 1) {
      const v = res.rows[0]!.version;
      return { won: true, newVersion: v, found: true, currentStatus: 'claimed', currentVersion: v };
    }
    // Loss: the conditional UPDATE matched no row. Re-read the row (a fast org-scoped
    // lookup) so the caller can tell WHY — another worker holds it (lost race),
    // the expectedVersion was stale, or the task doesn't exist (in this org) — and re-issue
    // a retry with the right version if appropriate. This is a best-effort SNAPSHOT
    // (a separate statement from the CAS), so currentStatus/currentVersion are a
    // diagnostic hint, not a guarantee — fine for deciding retry-vs-terminal.
    const cur = await this.db.query<{ status: TaskStatus; version: number }>(
      `SELECT status, version FROM task WHERE org_id = $1 AND id = $2`,
      [orgId, taskId]
    );
    if (cur.rowCount === 0) {
      return { won: false, newVersion: null, found: false, currentStatus: null, currentVersion: null };
    }
    return {
      won: false,
      newVersion: null,
      found: true,
      currentStatus: cur.rows[0]!.status,
      currentVersion: cur.rows[0]!.version,
    };
  }
}
