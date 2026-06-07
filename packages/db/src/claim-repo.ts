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

  async tryClaim(taskId: string, agentId: string, expectedVersion: number): Promise<ClaimOutcome> {
    const res = await this.db.query<{ version: number }>(
      `UPDATE task
          SET status = 'claimed', claimed_by = $2, version = version + 1
        WHERE id = $1 AND status = 'routable' AND version = $3
      RETURNING version`,
      [taskId, agentId, expectedVersion]
    );
    if (res.rowCount === 1) {
      const v = res.rows[0]!.version;
      return { won: true, newVersion: v, found: true, currentStatus: 'claimed', currentVersion: v };
    }
    // Loss: the conditional UPDATE matched no row. Re-read the row (a fast PK
    // lookup) so the caller can tell WHY — another worker holds it (lost race),
    // the expectedVersion was stale, or the task doesn't exist — and re-issue a
    // retry with the right version if appropriate.
    const cur = await this.db.query<{ status: TaskStatus; version: number }>(
      `SELECT status, version FROM task WHERE id = $1`,
      [taskId]
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
