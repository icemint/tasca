// The live fail-soft proof (slice: LLM wiring). The REAL Anthropic-backed ports (not a stub) against
// a failing/garbage transport: routing must degrade to the heuristic (never throw/block), and the
// decomposition proposer must return null (never throw). This is the property the consumers already
// own (estimateTier's catch+Zod, proposeDecompositionFailSoft's catch+Zod) — proven here end to end
// with the concrete client, so an Anthropic outage in production degrades, it does not stall.

import { describe, it, expect } from 'vitest';
import { estimateTier, proposeDecompositionFailSoft, DefaultPmProposer } from '@tasca/routing';
import { AnthropicChat, AnthropicClassifier, AnthropicDecomposer, type FetchLike } from '@tasca/llm';

const failing: FetchLike = async () => ({ ok: false, status: 500, async text() { return 'overloaded'; } });
const garbage: FetchLike = async () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({ content: [{ type: 'text', text: 'I cannot classify this task.' }] });
  },
});
const chat = (fetch: FetchLike) => new AnthropicChat({ apiKey: 'k', model: 'm', fetch });

describe('LLM degradation — a real Anthropic client outage degrades, never blocks', () => {
  // classifierConfidenceThreshold: 2 forces the classifier to be CALLED (the prior never clears it),
  // so we exercise the call → failure → fallback path, not the skip-on-high-confidence path.
  const force = { classifierConfidenceThreshold: 2 };

  it('routing: a FAILING classifier (500) → estimateTier falls back to the heuristic prior, never throws', async () => {
    const classifier = new AnthropicClassifier(chat(failing));
    const est = await estimateTier({ title: 'Add a config flag', body: 'small change' }, { classifier, ...force });
    expect(est.classifierUsed).toBe(false); // the LLM was called + failed → degraded to heuristics
    expect(est.tier).toBeTruthy();
  });

  it('routing: a GARBAGE classifier response → rejected at the Zod boundary → heuristic, never throws', async () => {
    const classifier = new AnthropicClassifier(chat(garbage));
    const est = await estimateTier({ title: 'Refactor things', body: 'medium' }, { classifier, ...force });
    expect(est.classifierUsed).toBe(false);
  });

  it('decomposition: a FAILING decomposer → the proposer returns null, never throws (live path)', async () => {
    // The real path: AnthropicDecomposer (failing) → DefaultPmProposer.proposeDecomposition → the
    // fail-soft wrapper → null.
    const proposer = new DefaultPmProposer({ decomposer: new AnthropicDecomposer(chat(failing)) });
    await expect(proposeDecompositionFailSoft(proposer, { task: { title: 't', body: 'b' } })).resolves.toBeNull();
  });

  it('decomposition: a GARBAGE decomposer response → null', async () => {
    const proposer = new DefaultPmProposer({ decomposer: new AnthropicDecomposer(chat(garbage)) });
    await expect(proposeDecompositionFailSoft(proposer, { task: { title: 't', body: 'b' } })).resolves.toBeNull();
  });
});
