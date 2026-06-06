import type { Pool } from 'pg';
import type { ClaimPort, ClaimOutcome } from '@tasca/domain';

/**
 * Postgres implementation of the claim CAS (`@tasca/routing`'s `ClaimPort`).
 *
 * The conditional UPDATE is the hard exactly-one guarantee: only the row that is
 * still `routable` at the expected `version` is updated, and Postgres serializes
 * the concurrent writers on that single row — so under N racing claims, exactly
 * one UPDATE affects a row (rowCount === 1) and the rest affect none.
 */
export class PgClaimRepository implements ClaimPort {
  constructor(private readonly pool: Pool) {}

  async tryClaim(taskId: string, agentId: string, expectedVersion: number): Promise<ClaimOutcome> {
    const res = await this.pool.query<{ version: number }>(
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
