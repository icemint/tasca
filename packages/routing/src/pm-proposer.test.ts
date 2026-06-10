import { describe, it, expect } from 'vitest';
import type { CapabilityProfile, TierEstimate } from '@tasca/domain';
import type { RoutingProposal } from '@tasca/contracts';
import {
  DeterministicRoutingProposer,
  proposeRoutingFailSoft,
  type PmProposerPort,
  type RoutingCandidate,
} from './pm-proposer';

function profile(over: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    agentId: 'a',
    maxTier: 'hard',
    tiersCovered: ['basic', 'low', 'medium', 'hard'],
    languageSpecialties: [],
    frameworkSpecialties: [],
    concurrencyLimit: 2,
    costCeiling: 100,
    successRate: 0.9,
    avgLatencyMs: 1000,
    ...over,
  };
}

function candidate(id: string, name: string, over: Partial<CapabilityProfile> = {}): RoutingCandidate {
  return { agentId: id, name, profile: profile({ agentId: id, ...over }), state: 'idle', activeCount: 0 };
}

const estimate: TierEstimate = {
  tier: 'medium',
  confidence: 0.8,
  signals: { wordCount: 10, hasReasoningVerb: false, scopeHint: 'unknown', labelTier: null },
  classifierUsed: false,
};

const task = { title: 'Fix the thing', body: 'a short task' };

describe('DeterministicRoutingProposer', () => {
  it('proposes the top eligible hired agent, by the SAME engine the binding path uses', async () => {
    const p = new DeterministicRoutingProposer();
    // mona ranks higher (success 0.95) than elvis (0.6); both cover medium + idle.
    const out = await p.proposeRouting({
      task,
      estimate,
      candidates: [candidate('elvis', 'Elvis', { successRate: 0.6 }), candidate('mona', 'Mona', { successRate: 0.95 })],
    });
    expect(out).not.toBeNull();
    expect(out!.agentName).toBe('Mona');
    expect(out!.confidence).toBeGreaterThan(0);
    expect(out!.why).toContain('medium');
  });

  it('returns null (honest no-suggestion) when no candidate is eligible', async () => {
    const p = new DeterministicRoutingProposer();
    // maxTier basic < medium estimate → ineligible.
    const out = await p.proposeRouting({
      task,
      estimate,
      candidates: [candidate('elvis', 'Elvis', { maxTier: 'basic', tiersCovered: ['basic'] })],
    });
    expect(out).toBeNull();
  });

  it('returns null for an empty roster', async () => {
    const out = await new DeterministicRoutingProposer().proposeRouting({ task, estimate, candidates: [] });
    expect(out).toBeNull();
  });
});

describe('proposeRoutingFailSoft — a proposer outage must never touch the loop', () => {
  const input = { task, estimate, candidates: [candidate('mona', 'Mona')] };

  it('happy path: validates and returns the proposal', async () => {
    const out = await proposeRoutingFailSoft(new DeterministicRoutingProposer(), input);
    expect(out?.agentName).toBe('Mona');
  });

  it('a THROWING proposer → null (no proposal), never propagates', async () => {
    const port: PmProposerPort = {
      proposeRouting: async () => {
        throw new Error('LLM 503');
      },
    };
    await expect(proposeRoutingFailSoft(port, input)).resolves.toBeNull();
  });

  it('a SLOW proposer (exceeds the timeout) → null', async () => {
    const port: PmProposerPort = {
      proposeRouting: () => new Promise((resolve) => setTimeout(() => resolve(null), 50)),
    };
    const out = await proposeRoutingFailSoft(port, input, { timeoutMs: 10 });
    expect(out).toBeNull();
  });

  it('a MALFORMED proposal (fails schema validation) → null', async () => {
    const port: PmProposerPort = {
      // confidence out of range + empty name → rejected at the trust boundary.
      proposeRouting: async () => ({ agentName: '', why: 'x', confidence: 5 }) as unknown as RoutingProposal,
    };
    await expect(proposeRoutingFailSoft(port, input)).resolves.toBeNull();
  });

  it('a proposer returning null (no suggestion) → null', async () => {
    const port: PmProposerPort = { proposeRouting: async () => null };
    await expect(proposeRoutingFailSoft(port, input)).resolves.toBeNull();
  });
});
