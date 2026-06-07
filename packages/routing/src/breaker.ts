/**
 * `re-tier` is modeled for Stage-2: a multi-agent escalation can re-tier a task
 * to a more capable agent below the breaker threshold instead of a plain retry.
 * Stage-1 is single-agent — there is no re-tier target — so `breaker()` never
 * emits it yet; the arm is in the type so a Stage-2 escalation that returns
 * `re-tier` won't reshape this signature (and break callers) later.
 */
export type BreakerOutcome = 'retry' | 're-tier' | 'needs_attention';

/**
 * Escalation / mis-tier recovery. After `n` failures (default 2) the task trips
 * the breaker → `needs_attention` (human-gated; no silent auto-escalation).
 * Below the threshold it is eligible to re-tier/retry — Stage-1 returns `retry`
 * (the `re-tier` arm is reserved for the Stage-2 multi-agent path).
 */
export function breaker(failureCount: number, n = 2): BreakerOutcome {
  return failureCount >= n ? 'needs_attention' : 'retry';
}
