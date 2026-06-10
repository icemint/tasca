import type { ClaimResult } from '@tasca/domain';
import type { ClaimPort } from './ports';

/**
 * Atomic single-claim. Delegates to the persistence port's CAS; the engine adds
 * no locking of its own — the conditional write is the hard exactly-one guarantee.
 */
export async function atomicClaim(
  port: ClaimPort,
  orgId: string,
  taskId: string,
  agentId: string,
  expectedVersion: number
): Promise<ClaimResult> {
  // ClaimResult is an alias of ClaimOutcome (the engine adds no fields), so the
  // port's outcome — including the enriched loss diagnostics (found /
  // currentStatus / currentVersion) — is returned directly.
  return port.tryClaim(orgId, taskId, agentId, expectedVersion);
}
