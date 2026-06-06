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
  return { won: outcome.won, newVersion: outcome.newVersion };
}
