import { describe, it, expect } from 'vitest';
import { withUsageContext, currentUsageContext, makeUsageSink } from './usage-context';
import type { UsageRecordInput } from './store';

function captureRecorder() {
  const records: Array<{ orgId: string } & UsageRecordInput> = [];
  return { records, recorder: { async recordUsage(orgId: string, e: UsageRecordInput) { records.push({ orgId, ...e }); } } };
}

describe('usage context — AsyncLocalStorage isolates per async chain (no cross-org bleed)', () => {
  it('currentUsageContext is undefined outside any run, set inside', async () => {
    expect(currentUsageContext()).toBeUndefined();
    await withUsageContext({ orgId: 'o', taskId: 't', source: 'classifier' }, async () => {
      expect(currentUsageContext()).toEqual({ orgId: 'o', taskId: 't', source: 'classifier' });
    });
    expect(currentUsageContext()).toBeUndefined();
  });

  it('attributes a reported call to the ambient context + records it via the store', async () => {
    const { records, recorder } = captureRecorder();
    const sink = makeUsageSink(recorder);
    await withUsageContext({ orgId: 'org_a', taskId: 't1', source: 'classifier' }, async () => {
      sink.record({ model: 'haiku', inputTokens: 100, outputTokens: 10, idempotencyKey: 'k1' });
    });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget insert settle
    expect(records).toEqual([{ orgId: 'org_a', taskId: 't1', source: 'classifier', model: 'haiku', inputTokens: 100, outputTokens: 10, idempotencyKey: 'k1' }]);
  });

  it('CONCURRENT contexts do NOT bleed — each call records its OWN org/task/source', async () => {
    const { records, recorder } = captureRecorder();
    const sink = makeUsageSink(recorder);
    // Two concurrent chains, deliberately interleaved by different await delays. If the context bled
    // across chains (the classic ALS bug), one call would be billed to the other org.
    await Promise.all([
      withUsageContext({ orgId: 'org_a', taskId: 'ta', source: 'classifier' }, async () => {
        await new Promise((r) => setTimeout(r, 6));
        sink.record({ model: 'm', inputTokens: 1, outputTokens: 1, idempotencyKey: 'ka' });
      }),
      withUsageContext({ orgId: 'org_b', taskId: 'tb', source: 'triage' }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        sink.record({ model: 'm', inputTokens: 2, outputTokens: 2, idempotencyKey: 'kb' });
      }),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(records.find((x) => x.idempotencyKey === 'ka')).toMatchObject({ orgId: 'org_a', taskId: 'ta', source: 'classifier' });
    expect(records.find((x) => x.idempotencyKey === 'kb')).toMatchObject({ orgId: 'org_b', taskId: 'tb', source: 'triage' });
  });

  it('a call OUTSIDE any context is skipped (not attributable, never mis-billed)', () => {
    const { records, recorder } = captureRecorder();
    makeUsageSink(recorder).record({ model: 'm', inputTokens: 1, outputTokens: 1, idempotencyKey: 'k' });
    expect(records).toEqual([]);
  });

  it('a recorder failure is swallowed (metering never throws into the LLM path)', async () => {
    const sink = makeUsageSink({ async recordUsage() { throw new Error('db down'); } });
    await withUsageContext({ orgId: 'o', taskId: 't', source: 'classifier' }, async () => {
      expect(() => sink.record({ model: 'm', inputTokens: 1, outputTokens: 1, idempotencyKey: 'k' })).not.toThrow();
    });
    await new Promise((r) => setTimeout(r, 0)); // the rejected promise is caught, not unhandled
  });
});
