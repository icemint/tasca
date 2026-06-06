import type { CapabilityProfile } from '@tasca/domain';

export interface ConcurrencyState {
  perAgentActive: number;
  perProjectActive: number;
  /** True when another run already holds this repo's slot (same-repo serialization). */
  repoBusy: boolean;
}

export interface ConcurrencyLimits {
  perProjectLimit: number;
}

/**
 * Advisory pre-claim gate — avoids obviously-wasted claim attempts. The CAS
 * claim remains the hard guarantee; this is a cheap early-out only.
 */
export function canDispatch(
  profile: CapabilityProfile,
  state: ConcurrencyState,
  limits: ConcurrencyLimits
): { ok: boolean; reason?: string } {
  if (state.perAgentActive >= profile.concurrencyLimit) return { ok: false, reason: 'agent concurrency limit' };
  if (state.perProjectActive >= limits.perProjectLimit) return { ok: false, reason: 'project concurrency limit' };
  if (state.repoBusy) return { ok: false, reason: 'same-repo serialization' };
  return { ok: true };
}
