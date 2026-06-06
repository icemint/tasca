import type { Pool, PoolClient } from 'pg';
import type { ClaimPort, ClaimOutcome } from '@tasca/domain';

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
      return { won: true, newVersion: res.rows[0]!.version };
    }
    return { won: false, newVersion: null };
  }
}
