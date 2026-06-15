import { describe, it, expect, beforeEach } from 'vitest';
import type { Task } from '@tasca/domain';
import type { EmBlockExplainerPort } from '@tasca/llm';
import {
  makeEmBlockExplainer,
  type EmBlockExplainerStore,
  type BlockContent,
} from './em-block-explainer';
import { currentUsageContext } from './usage-context';

// Unit proof of the EM block-explanation (EM v1 slice 4). BEST-EFFORT + FAIL-OPEN is the load-bearing
// contract: a missing manager / vault key / a thrown explainer all leave the RAW reason in place (no
// updateBlockReason) and the explainer NEVER throws. The happy path writes the human rephrase back via
// updateBlockReason, metered as source='manager'. All fakes are hand-rolled with real state; no LLM, no DB.

// ── Fakes ───────────────────────────────────────────────────────────────────────
class FakeStore implements EmBlockExplainerStore {
  /** projectId → managerId; absent = the project has no EM. */
  managers = new Map<string, string>();
  /** Records every block-reason write so the test can assert what (if anything) was rephrased. The guard
   *  is simulated by `updateActs`: false = the task moved on (still-blocked guard missed) → no-op. */
  updateCalls: Array<{ taskId: string; humanReason: string }> = [];
  updateActs = true;
  async getOrCreateProject(_orgId: string, repoRef: string | null): Promise<string> {
    return `proj:${repoRef ?? '∅'}`;
  }
  async getManagerForProject(_orgId: string, projectId: string): Promise<string | null> {
    return this.managers.get(projectId) ?? null;
  }
  async updateBlockReason(_orgId: string, taskId: string, humanReason: string): Promise<boolean> {
    this.updateCalls.push({ taskId, humanReason });
    return this.updateActs;
  }
}

/** An explainer that returns canned text (or throws) — and records the ambient usage source so the test
 *  can prove the call was metered as source='manager', plus the inputs it was handed. */
class FakeExplainer implements EmBlockExplainerPort {
  calls = 0;
  observedSource: string | null = null;
  observedInput: { rawReason: string; title: string } | null = null;
  constructor(private readonly result: string | { throw: true }) {}
  async explainBlock(input: { rawReason: string; title: string }): Promise<string> {
    this.calls += 1;
    this.observedSource = currentUsageContext()?.source ?? null;
    this.observedInput = input;
    if (typeof this.result === 'object') throw new Error('anthropic 503 (model=claude-sonnet-4-6)');
    return this.result;
  }
}

const CONTENT: BlockContent = { title: 'Add a thing' };
const RAW = 'no execution capacity: no agent-runner claimed within 30000ms';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    externalStoryId: 'sc-story-42',
    title: null,
    platform: 'shortcut',
    status: 'needs_attention',
    version: 1,
    claimedBy: null,
    failureCount: 0,
    repoRef: 'acme/api',
    tierEstimate: null,
    lastError: RAW,
    preferredAgentId: null,
    emCleared: false,
    emClarificationRound: 0,
    ...over,
  };
}

function makeExplainer(opts: {
  store: FakeStore;
  explainer: FakeExplainer;
  key?: string | null;
}) {
  return makeEmBlockExplainer({
    store: opts.store,
    vendorKeyFor: async () => (opts.key === undefined ? 'sk-org-key' : opts.key),
    explainerFor: () => opts.explainer,
  });
}

describe('makeEmBlockExplainer (EM v1 slice 4)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
    // Default happy wiring: the project has an EM and the org has a key.
    store.managers.set('proj:acme/api', 'mgr-elvis');
  });

  it('manager + key + LLM → writes the human rephrase via updateBlockReason', async () => {
    const explainer = new FakeExplainer('No agents picked this up in time — assign one or check the runner.');
    const run = makeExplainer({ store, explainer });
    await run('org_a', task(), CONTENT, RAW);
    expect(explainer.calls).toBe(1);
    expect(explainer.observedInput).toEqual({ rawReason: RAW, title: 'Add a thing' });
    expect(store.updateCalls).toEqual([
      { taskId: 'task-1', humanReason: 'No agents picked this up in time — assign one or check the runner.' },
    ]);
  });

  it('the rephrase is metered as source="manager" (the EM\'s spend)', async () => {
    const explainer = new FakeExplainer('A clear sentence.');
    const run = makeExplainer({ store, explainer });
    await run('org_a', task(), CONTENT, RAW);
    expect(explainer.observedSource).toBe('manager');
  });

  it('trims + bounds the model text before writing it back', async () => {
    const explainer = new FakeExplainer('  ' + 'x'.repeat(500) + '  ');
    const run = makeExplainer({ store, explainer });
    await run('org_a', task(), CONTENT, RAW);
    expect(store.updateCalls).toHaveLength(1);
    const written = store.updateCalls[0]!.humanReason;
    expect(written.length).toBe(280); // MAX_HUMAN_REASON_CHARS, after trim
    expect(written.startsWith('x')).toBe(true);
  });

  it('NO manager on the project → no-op, keeps the raw reason (no LLM, no write)', async () => {
    store.managers.clear();
    const explainer = new FakeExplainer('unused');
    const run = makeExplainer({ store, explainer });
    await run('org_a', task(), CONTENT, RAW);
    expect(explainer.calls).toBe(0);
    expect(store.updateCalls).toHaveLength(0);
  });

  it('NO org vault key → no-op, keeps the raw reason (no LLM, no write)', async () => {
    const explainer = new FakeExplainer('unused');
    const run = makeExplainer({ store, explainer, key: null });
    await run('org_a', task(), CONTENT, RAW);
    expect(explainer.calls).toBe(0);
    expect(store.updateCalls).toHaveLength(0);
  });

  it('the explainer THROWS (LLM error) → keeps the raw reason, never throws out (no write)', async () => {
    const explainer = new FakeExplainer({ throw: true });
    const run = makeExplainer({ store, explainer });
    await expect(run('org_a', task(), CONTENT, RAW)).resolves.toBeUndefined();
    expect(store.updateCalls).toHaveLength(0);
  });

  it('an EMPTY rephrase → keeps the raw reason (does not blank last_error)', async () => {
    const explainer = new FakeExplainer('   ');
    const run = makeExplainer({ store, explainer });
    await run('org_a', task(), CONTENT, RAW);
    expect(store.updateCalls).toHaveLength(0);
  });

  it('the updateBlockReason guard no-ops (task moved on) → still does not throw', async () => {
    store.updateActs = false; // simulate the still-blocked guard missing (task resumed / re-driven)
    const explainer = new FakeExplainer('A clear sentence.');
    const run = makeExplainer({ store, explainer });
    await expect(run('org_a', task(), CONTENT, RAW)).resolves.toBeUndefined();
    // It still ATTEMPTED the write; the store's guard decided it was too late (returned false).
    expect(store.updateCalls).toHaveLength(1);
  });

  it('works for ANY platform (it only rewrites text, posts nothing)', async () => {
    const explainer = new FakeExplainer('Human reason for a GitHub task.');
    const run = makeExplainer({ store, explainer });
    await run('org_a', task({ platform: 'github' }), CONTENT, RAW);
    expect(store.updateCalls).toHaveLength(1);
  });
});
