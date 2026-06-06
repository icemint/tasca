export type BreakerOutcome = 'retry' | 'needs_attention';

/**
 * Escalation / mis-tier recovery. After `n` failures (default 2) the task trips
 * the breaker → `needs_attention` (human-gated; no silent auto-escalation).
 * Below the threshold it is eligible to re-tier/retry.
 */
export function breaker(failureCount: number, n = 2): BreakerOutcome {
  return failureCount >= n ? 'needs_attention' : 'retry';
}
