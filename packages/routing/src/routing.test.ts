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

  // A counting fake lets us assert the classifier-skip boundary precisely: the
  // prior.confidence >= threshold skip is an exact `>=`, so a prior AT the
  // threshold must skip and a prior just BELOW it must call.
  function countingClassifier(result: { tier: Tier; confidence: number }) {
    let calls = 0;
    const port: LlmClassifierPort = {
      classify: async () => {
        calls += 1;
        return result;
      },
    };
    return {
      port,
      get calls() {
        return calls;
      },
    };
  }

  it('skips the classifier when the prior confidence is EXACTLY the threshold', async () => {
    // A low-signal-but-not-tiny task yields the mid prior confidence (0.55).
    // Setting the threshold to that exact value must skip (>= is inclusive).
    const c = countingClassifier({ tier: 'ultra', confidence: 0.99 });
    const est = await estimateTier(
      { title: 'do', body: 'a thing here please now today' },
      { classifier: c.port, classifierConfidenceThreshold: 0.55 }
    );
    expect(c.calls).toBe(0);
    expect(est.classifierUsed).toBe(false);
    expect(est.confidence).toBe(0.55); // the prior carried through, not the classifier's
  });

  it('calls the classifier when the prior confidence is just BELOW the threshold', async () => {
    // Same mid prior (0.55); a threshold a hair above it crosses the boundary.
    const c = countingClassifier({ tier: 'hard', confidence: 0.82 });
    const est = await estimateTier(
      { title: 'do', body: 'a thing here please now today' },
      { classifier: c.port, classifierConfidenceThreshold: 0.56 }
    );
    expect(c.calls).toBe(1);
    expect(est.classifierUsed).toBe(true);
    expect(est.tier).toBe('hard'); // the valid classifier result is used
    expect(est.confidence).toBe(0.82);
  });

  it('classifies file mentions: prose → unknown, real paths → multi-file, one file → single-file', () => {
    // Prose with abbreviations + a version string — none are real file extensions.
    const prose = heuristics({ title: 'e.g. fix the bug, i.e. the v1.2 regression', body: '' });
    expect(prose.scopeHint).toBe('unknown');

    const multi = heuristics({ title: 'edit src/foo.ts and config.yaml', body: '' });
    expect(multi.scopeHint).toBe('multi-file');

    const single = heuristics({ title: 'tweak README.md', body: '' });
    expect(single.scopeHint).toBe('single-file');

    // Surrounding punctuation must not hide a real path.
    expect(heuristics({ title: 'see (src/a.ts), and b.py.', body: '' }).scopeHint).toBe('multi-file');

    // Extended extension set (infra/config) counts too.
    expect(heuristics({ title: 'update main.tf and schema.graphql', body: '' }).scopeHint).toBe('multi-file');
  });

  it('file-mention scan is linear on adversarial input (no ReDoS)', () => {
    // A long path-like token with no valid extension would blow up a backtracking
    // regex; per-token anchored matching keeps it bounded. Must finish ~instantly.
    const big = `${'a/'.repeat(100000)}b`;
    const start = Date.now();
    expect(heuristics({ title: big, body: '' }).scopeHint).toBe('unknown');
    expect(Date.now() - start).toBeLessThan(500);
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

  it('returns [] for an empty candidate set (no crash)', () => {
    expect(matchCapability(est, [])).toEqual([]);
  });

  it('tie-breaks equal scores deterministically by input order (stable sort)', () => {
    // Two identical eligible candidates score the same; the sort is stable, so
    // the first-listed candidate stays first across repeated calls.
    const candidates = [
      { profile: profile({ agentId: 'first' }), state: 'idle' as const, activeCount: 0 },
      { profile: profile({ agentId: 'second' }), state: 'idle' as const, activeCount: 0 },
    ];
    const m1 = matchCapability(est, candidates);
    const m2 = matchCapability(est, candidates);
    expect(m1[0]!.score).toBe(m1[1]!.score);
    expect(m1.map((x) => x.agentId)).toEqual(['first', 'second']);
    expect(m2.map((x) => x.agentId)).toEqual(['first', 'second']);
  });

  it('returns ranked entries for an all-ineligible set (every entry eligible:false, score 0)', () => {
    // All over-tier → all ineligible. They still come back ranked (all score 0,
    // input order preserved), not dropped or crashed.
    const m = matchCapability({ ...est, tier: 'ultra' }, [
      { profile: profile({ agentId: 'a', maxTier: 'hard' }), state: 'idle', activeCount: 0 },
      { profile: profile({ agentId: 'b', maxTier: 'medium' }), state: 'idle', activeCount: 0 },
    ]);
    expect(m).toHaveLength(2);
    expect(m.every((x) => x.eligible === false)).toBe(true);
    expect(m.every((x) => x.score === 0)).toBe(true);
    expect(m.map((x) => x.agentId)).toEqual(['a', 'b']);
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
      async tryClaim(_org, _t, agentId, expected): Promise<ClaimOutcome> {
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
    const a = await atomicClaim(store.port, 'org_default', 't1', 'a', 0);
    const b = await atomicClaim(store.port, 'org_default', 't1', 'b', 0);
    expect(a.won).toBe(true);
    expect(a.newVersion).toBe(1);
    expect(b.won).toBe(false);
    expect(store.claimedBy).toBe('a');
  });

  it('exactly one wins across many attempts', async () => {
    const store = inMemoryPort(0);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => atomicClaim(store.port, 'org_default', 't', `a${i}`, 0))
    );
    expect(results.filter((r) => r.won).length).toBe(1);
  });

  it('passes the enriched loss diagnostics (found/currentStatus/currentVersion) through', async () => {
    // A port that reports WHY the CAS missed. atomicClaim must surface those
    // fields so a caller can tell a retryable loss from a terminal one.
    const lostRace: ClaimPort = {
      async tryClaim(): Promise<ClaimOutcome> {
        return { won: false, newVersion: null, found: true, currentStatus: 'claimed', currentVersion: 3 };
      },
    };
    expect(await atomicClaim(lostRace, 'org_default', 't', 'a', 0)).toMatchObject({
      won: false,
      found: true,
      currentStatus: 'claimed',
      currentVersion: 3,
    });

    const missing: ClaimPort = {
      async tryClaim(): Promise<ClaimOutcome> {
        return { won: false, newVersion: null, found: false, currentStatus: null, currentVersion: null };
      },
    };
    expect(await atomicClaim(missing, 'org_default', 't', 'a', 0)).toMatchObject({ won: false, found: false, currentStatus: null });
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

  it('covers all four exit paths with the right reason', () => {
    // 1. per-agent limit hit (perAgentActive >= profile.concurrencyLimit = 4)
    expect(
      canDispatch(p, { perAgentActive: 4, perProjectActive: 0, repoBusy: false }, { perProjectLimit: 10 })
    ).toEqual({ ok: false, reason: 'agent concurrency limit' });

    // 2. per-project limit hit (checked after the agent limit passes)
    expect(
      canDispatch(p, { perAgentActive: 0, perProjectActive: 10, repoBusy: false }, { perProjectLimit: 10 })
    ).toEqual({ ok: false, reason: 'project concurrency limit' });

    // 3. repo busy (checked last, after both limits pass)
    expect(
      canDispatch(p, { perAgentActive: 0, perProjectActive: 0, repoBusy: true }, { perProjectLimit: 10 })
    ).toEqual({ ok: false, reason: 'same-repo serialization' });

    // 4. ok path — no reason
    expect(
      canDispatch(p, { perAgentActive: 0, perProjectActive: 0, repoBusy: false }, { perProjectLimit: 10 })
    ).toEqual({ ok: true });
  });
});
