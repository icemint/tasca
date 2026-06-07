import type { ClaimResult } from '@tasca/domain';
import type { ClaimPort } from './ports';

/**
 * Atomic single-claim. Delegates to the persistence port's CAS; the engine adds
 * no locking of its own — the conditional write is the hard exactly-one guarantee.
 */
export async function atomicClaim(
  port: ClaimPort,
  taskId: string,
  agentId: string,
  expectedVersion: number
): Promise<ClaimResult> {
  const outcome = await port.tryClaim(taskId, agentId, expectedVersion);
  // Pass the enriched loss diagnostics (found / currentStatus / currentVersion)
  // straight through so a caller can tell a retryable loss from a terminal one
  // without a second query.
  return {
    won: outcome.won,
    newVersion: outcome.newVersion,
    ...(outcome.found !== undefined ? { found: outcome.found } : {}),
    ...(outcome.currentStatus !== undefined ? { currentStatus: outcome.currentStatus } : {}),
    ...(outcome.currentVersion !== undefined ? { currentVersion: outcome.currentVersion } : {}),
  };
}
