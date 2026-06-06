import type { CapabilityProfile, CapabilityMatch, TierEstimate, AgentState } from '@tasca/domain';
import { tierAtLeast } from '@tasca/domain';

export interface MatchCandidate {
  profile: CapabilityProfile;
  state: AgentState;
  activeCount: number;
}

/**
 * Rank agents that can take the work. N-agent from day one (Stage 1 has one).
 * Eligible = max tier covers the estimate AND the agent is idle with headroom.
 * Score = success history × headroom (eligible only). Returns sorted desc.
 */
export function matchCapability(
  estimate: TierEstimate,
  candidates: MatchCandidate[]
): CapabilityMatch[] {
  return candidates
    .map((c): CapabilityMatch => {
      const reasons: string[] = [];
      const tierOk = tierAtLeast(c.profile.maxTier, estimate.tier);
      if (!tierOk) reasons.push(`maxTier ${c.profile.maxTier} < ${estimate.tier}`);
      const available = c.state === 'idle' && c.activeCount < c.profile.concurrencyLimit;
      if (!available) reasons.push(`unavailable (${c.state}, ${c.activeCount}/${c.profile.concurrencyLimit})`);
      const eligible = tierOk && available;
      const history = c.profile.successRate ?? 0.5;
      const headroom = 1 - c.activeCount / Math.max(1, c.profile.concurrencyLimit);
      const score = eligible ? history * 0.7 + headroom * 0.3 : 0;
      return { agentId: c.profile.agentId, score, eligible, reasons };
    })
    .sort((a, b) => b.score - a.score);
}
