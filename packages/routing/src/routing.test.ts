import { describe, it, expect } from 'vitest';
import { estimateTier, heuristics, matchCapability, breaker, canDispatch, atomicClaim } from './index';
import { TIERS } from '@tasca/domain';
import type {
  Tier,
  ClaimPort,
  ClaimOutcome,
  CapabilityProfile,
  TierEstimate,
  LlmClassifierPort,
} from '@tasca/domain';

const failClassifier: LlmClassifierPort = {
  classify: async () => {
    throw new Error('classifier should not be called');
  },
};

describe('tier estimation', () => {
  it('reads an explicit tier label with high confidence and skips the classifier', async () => {
    const est = await estimateTier(
      { title: 'Fix typo', body: 'one liner', labels: ['tier:hard'] },
      { classifier: failClassifier }
    );
    expect(est.tier).toBe('hard');
    expect(est.classifierUsed).toBe(false);
    expect(est.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('calls the classifier when the heuristic prior is low-confidence', async () => {
    const est = await estimateTier(
      { title: 'do', body: 'thing' },
      { classifier: { classify: async () => ({ tier: 'medium', confidence: 0.77 }) }, classifierConfidenceThreshold: 0.8 }
    );
    expect(est.tier).toBe('medium');
    expect(est.classifierUsed).toBe(true);
  });

  it('extracts reasoning + scope features', () => {
    const f = heuristics({ title: 'Refactor the auth guard in src/auth/guard.ts and middleware.ts', body: '' });
    expect(f.hasReasoningVerb).toBe(true);
    expect(f.scopeHint).toBe('multi-file');
  });

  it('falls back to the heuristic prior when the classifier returns malformed output', async () => {
    const malformed: LlmClassifierPort = {
      // tier not in TIERS, confidence out of [0,1] — must be rejected
      classify: async () => ({ tier: 'urgent', confidence: 5 }) as unknown as { tier: Tier; confidence: number },
    };
    const est = await estimateTier({ title: 'do', body: 'thing' }, { classifier: malformed });
    expect(est.classifierUsed).toBe(false);
    expect(TIERS).toContain(est.tier);
    expect(est.confidence).toBeGreaterThanOrEqual(0);
    expect(est.confidence).toBeLessThanOrEqual(1);
  });

  it('falls back to the heuristic prior when the classifier call throws', async () => {
    const throwing: LlmClassifierPort = {
      classify: async () => {
        throw new Error('429 rate limited');
      },
    };
    const est = await estimateTier({ title: 'do', body: 'thing' }, { classifier: throwing });
    expect(est.classifierUsed).toBe(false);
    expect(est.tier).toBe('basic'); // the prior for this low-signal task
  });
});

describe('capability matching', () => {
  const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
    agentId: 'elvis',
    maxTier: 'hard',
    tiersCovered: ['basic', 'low', 'medium', 'hard'],
    languageSpecialties: [],
    frameworkSpecialties: [],
    concurrencyLimit: 2,
    costCeiling: 100,
    successRate: 0.9,
    avgLatencyMs: null,
    ...over,
  });
  const est: TierEstimate = {
    tier: 'medium',
    confidence: 0.6,
    signals: { wordCount: 10, hasReasoningVerb: false, scopeHint: 'unknown', labelTier: null },
    classifierUsed: false,
  };

  it('ranks the eligible higher-success agent first', () => {
    const m = matchCapability(est, [
      { profile: profile({ agentId: 'a', successRate: 0.5 }), state: 'idle', activeCount: 0 },
      { profile: profile({ agentId: 'b', successRate: 0.95 }), state: 'idle', activeCount: 0 },
    ]);
    expect(m[0]!.agentId).toBe('b');
    expect(m.every((x) => x.eligible)).toBe(true);
  });

  it('marks an over-tier agent ineligible', () => {
    const m = matchCapability({ ...est, tier: 'ultra' }, [
      { profile: profile({ maxTier: 'hard' }), state: 'idle', activeCount: 0 },
    ]);
    expect(m[0]!.eligible).toBe(false);
  });

  it('marks a busy agent ineligible', () => {
    const m = matchCapability(est, [{ profile: profile({ concurrencyLimit: 1 }), state: 'idle', activeCount: 1 }]);
    expect(m[0]!.eligible).toBe(false);
  });
});

describe('escalation breaker', () => {
  it('retries below N and needs_attention at N=2', () => {
    expect(breaker(0)).toBe('retry');
    expect(breaker(1)).toBe('retry');
    expect(breaker(2)).toBe('needs_attention');
  });
});

describe('atomicClaim over an in-memory CAS port', () => {
  // JS is single-threaded, so this proves the engine *logic*; the real
  // concurrency guarantee is proven against Postgres in @tasca/db.
  function inMemoryPort(initialVersion = 0) {
    let status = 'routable';
    let version = initialVersion;
    let claimedBy: string | null = null;
    const port: ClaimPort = {
      async tryClaim(_t, agentId, expected): Promise<ClaimOutcome> {
        if (status === 'routable' && version === expected) {
          status = 'claimed';
          version += 1;
          claimedBy = agentId;
          return { won: true, newVersion: version };
        }
        return { won: false, newVersion: null };
      },
    };
    return {
      port,
      get claimedBy() {
        return claimedBy;
      },
    };
  }

  it('first claim wins, stale-version claim loses', async () => {
    const store = inMemoryPort(0);
    const a = await atomicClaim(store.port, 't1', 'a', 0);
    const b = await atomicClaim(store.port, 't1', 'b', 0);
    expect(a.won).toBe(true);
    expect(a.newVersion).toBe(1);
    expect(b.won).toBe(false);
    expect(store.claimedBy).toBe('a');
  });

  it('exactly one wins across many attempts', async () => {
    const store = inMemoryPort(0);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => atomicClaim(store.port, 't', `a${i}`, 0))
    );
    expect(results.filter((r) => r.won).length).toBe(1);
  });
});

describe('concurrency gate', () => {
  const p: CapabilityProfile = {
    agentId: 'x',
    maxTier: 'hard',
    tiersCovered: [],
    languageSpecialties: [],
    frameworkSpecialties: [],
    concurrencyLimit: 4,
    costCeiling: 1,
    successRate: null,
    avgLatencyMs: null,
  };
  it('blocks on same-repo serialization, allows otherwise', () => {
    expect(canDispatch(p, { perAgentActive: 0, perProjectActive: 0, repoBusy: true }, { perProjectLimit: 10 }).ok).toBe(false);
    expect(canDispatch(p, { perAgentActive: 0, perProjectActive: 0, repoBusy: false }, { perProjectLimit: 10 }).ok).toBe(true);
  });
});
