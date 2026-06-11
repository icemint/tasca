import { describe, it, expect } from 'vitest';
import type { CapabilityProfile, TierEstimate, TierFeatures } from '@tasca/domain';
import type { RoutingProposal, TriageProposal, DecompositionProposal } from '@tasca/contracts';
import type { LlmClassifierPort } from './ports';
import {
  DefaultPmProposer,
  proposeRoutingFailSoft,
  proposeTriageFailSoft,
  proposeDecompositionFailSoft,
  type PmProposerPort,
  type RoutingCandidate,
  type DecomposerPort,
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

describe('DefaultPmProposer', () => {
  it('proposes the top eligible hired agent, by the SAME engine the binding path uses', async () => {
    const p = new DefaultPmProposer();
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
    const p = new DefaultPmProposer();
    // maxTier basic < medium estimate → ineligible.
    const out = await p.proposeRouting({
      task,
      estimate,
      candidates: [candidate('elvis', 'Elvis', { maxTier: 'basic', tiersCovered: ['basic'] })],
    });
    expect(out).toBeNull();
  });

  it('returns null for an empty roster', async () => {
    const out = await new DefaultPmProposer().proposeRouting({ task, estimate, candidates: [] });
    expect(out).toBeNull();
  });
});

describe('proposeRoutingFailSoft — a proposer outage must never touch the loop', () => {
  const input = { task, estimate, candidates: [candidate('mona', 'Mona')] };

  it('happy path: validates and returns the proposal', async () => {
    const out = await proposeRoutingFailSoft(new DefaultPmProposer(), input);
    expect(out?.agentName).toBe('Mona');
  });

  it('a THROWING proposer → null (no proposal), never propagates', async () => {
    const port: Pick<PmProposerPort, 'proposeRouting'> = {
      proposeRouting: async () => {
        throw new Error('LLM 503');
      },
    };
    await expect(proposeRoutingFailSoft(port, input)).resolves.toBeNull();
  });

  it('a SLOW proposer (exceeds the timeout) → null', async () => {
    const port: Pick<PmProposerPort, 'proposeRouting'> = {
      proposeRouting: () => new Promise((resolve) => setTimeout(() => resolve(null), 50)),
    };
    const out = await proposeRoutingFailSoft(port, input, { timeoutMs: 10 });
    expect(out).toBeNull();
  });

  it('a MALFORMED proposal (fails schema validation) → null', async () => {
    const port: Pick<PmProposerPort, 'proposeRouting'> = {
      // confidence out of range + empty name → rejected at the trust boundary.
      proposeRouting: async () => ({ agentName: '', why: 'x', confidence: 5 }) as unknown as RoutingProposal,
    };
    await expect(proposeRoutingFailSoft(port, input)).resolves.toBeNull();
  });

  it('a proposer returning null (no suggestion) → null', async () => {
    const port: Pick<PmProposerPort, 'proposeRouting'> = { proposeRouting: async () => null };
    await expect(proposeRoutingFailSoft(port, input)).resolves.toBeNull();
  });
});

describe('DefaultPmProposer.proposeTriage — the tier engine surfaced as a suggestion', () => {
  const triageTask = { title: 'Refactor the auth module', body: 'Investigate and redesign the token flow across several files.' };

  it('heuristic-only (no classifier) proposes a tier with a plain-English why', async () => {
    const out = await new DefaultPmProposer().proposeTriage({ task: triageTask });
    expect(out).not.toBeNull();
    expect(out!.tier).toBeTruthy();
    expect(out!.why).toContain('heuristics');
    expect(out!.confidence).toBeGreaterThan(0);
  });

  it('uses the injected classifier when the heuristic prior is low-confidence (LLM-backed)', async () => {
    const classifier: LlmClassifierPort = {
      classify: async (_in: { title: string; body: string; features: TierFeatures }) => ({ tier: 'ultra', confidence: 0.95 }),
    };
    const out = await new DefaultPmProposer({ classifier }).proposeTriage({ task: triageTask });
    expect(out!.tier).toBe('ultra');
    expect(out!.why).toContain('classifier');
  });

  it('a classifier that THROWS degrades to the heuristic prior (estimateTier is fail-soft)', async () => {
    const classifier: LlmClassifierPort = { classify: async () => { throw new Error('LLM down'); } };
    const out = await new DefaultPmProposer({ classifier }).proposeTriage({ task: triageTask });
    expect(out).not.toBeNull(); // never throws — degraded to heuristics
    expect(out!.why).toContain('heuristics');
  });
});

describe('proposeTriageFailSoft — a triage outage never reaches the loop', () => {
  const input = { task: { title: 't', body: 'b' } };

  it('happy path returns the validated triage', async () => {
    const out = await proposeTriageFailSoft(new DefaultPmProposer(), input);
    expect(out?.tier).toBeTruthy();
  });

  it('a THROWING triage proposer → null', async () => {
    const port: Pick<PmProposerPort, 'proposeTriage'> = { proposeTriage: async () => { throw new Error('boom'); } };
    await expect(proposeTriageFailSoft(port, input)).resolves.toBeNull();
  });

  it('a MALFORMED triage (bad tier / out-of-range confidence) → null', async () => {
    const port: Pick<PmProposerPort, 'proposeTriage'> = {
      proposeTriage: async () => ({ tier: 'gigantic', why: 'x', confidence: 9 }) as unknown as TriageProposal,
    };
    await expect(proposeTriageFailSoft(port, input)).resolves.toBeNull();
  });
});

describe('DefaultPmProposer.proposeDecomposition — LLM-backed, no deterministic fallback', () => {
  const task = { title: 'Billing reconciliation v2', body: 'a large, multi-part story' };

  it('returns null when NO decomposer is wired (a split needs a model)', async () => {
    expect(await new DefaultPmProposer().proposeDecomposition({ task })).toBeNull();
  });

  it('uses the injected decomposer when present', async () => {
    const decomposer: DecomposerPort = {
      decompose: async () => ({ children: [{ title: 'migration', body: '' }, { title: 'engine', body: '' }], why: 'splits cleanly' }),
    };
    const out = await new DefaultPmProposer({ decomposer }).proposeDecomposition({ task });
    expect(out!.children).toHaveLength(2);
  });
});

describe('proposeDecompositionFailSoft — an LLM decomposer outage never reaches the loop', () => {
  const input = { task: { title: 't', body: 'b' } };

  it('a THROWING decomposer → null', async () => {
    const port: Pick<PmProposerPort, 'proposeDecomposition'> = { proposeDecomposition: async () => { throw new Error('LLM down'); } };
    await expect(proposeDecompositionFailSoft(port, input)).resolves.toBeNull();
  });

  it('a MALFORMED split (empty children) → null', async () => {
    const port: Pick<PmProposerPort, 'proposeDecomposition'> = {
      proposeDecomposition: async () => ({ children: [], why: 'x' }) as unknown as DecompositionProposal,
    };
    await expect(proposeDecompositionFailSoft(port, input)).resolves.toBeNull();
  });

  it('happy path validates and returns the split', async () => {
    const port: Pick<PmProposerPort, 'proposeDecomposition'> = {
      proposeDecomposition: async () => ({ children: [{ title: 'a', body: '' }], why: 'ok' }),
    };
    const out = await proposeDecompositionFailSoft(port, input);
    expect(out!.children[0]!.title).toBe('a');
  });
});
