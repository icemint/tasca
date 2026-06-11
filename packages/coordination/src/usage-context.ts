// Per-request usage context (slice W3-S4a). orchestrate / proposal-api set {orgId, taskId, source} for
// the duration of an async chain; the UsageSink reads it when the LLM client reports a call, so usage
// is attributed to the right org/task WITHOUT threading org/task through the (generic) LLM ports
// (LlmClassifierPort.classify etc. stay pure). AsyncLocalStorage isolates the context PER async chain —
// two concurrent requests (org A and org B) each see only their OWN context, so spend can never be
// mis-attributed across orgs (the classic ALS-bleed bug, which this storage model structurally prevents).

import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageSink, CallUsage } from '@tasca/llm';
import type { UsageSource, UsageRecordInput } from './store';
import type { Logger } from './ports';

export interface UsageContext {
  orgId: string;
  taskId: string | null;
  source: UsageSource;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Run `fn` with the usage context set, so any LLM call within attributes to this org/task/source. */
export function withUsageContext<T>(ctx: UsageContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** The ambient context (or undefined outside any `withUsageContext`). Exposed for tests. */
export function currentUsageContext(): UsageContext | undefined {
  return storage.getStore();
}

/**
 * A UsageSink that attributes the reported call to the AMBIENT context (orgId/taskId/source) and
 * records it via the store. Fire-and-forget: a meter failure is logged, never thrown — metering must
 * not break or delay an LLM call. The context is read SYNCHRONOUSLY in record() (so it binds to the
 * calling async chain), then the captured values drive the async DB write — concurrent orgs never cross.
 *
 * LOSS-vs-AVAILABILITY tradeoff: a failed recordUsage (e.g. DB briefly down) is LOGGED, not retried or
 * queued — the NON-BLOCKING invariant (metering never affects an LLM call) wins over guaranteed capture.
 * The cost is occasional lost usage rows during an outage (an under-count, reconcilable against the
 * vendor invoice). A durable queue for at-least-once capture is deferred until loss tolerance demands it.
 */
export function makeUsageSink(
  recorder: { recordUsage(orgId: string, e: UsageRecordInput): Promise<void> },
  logger?: Logger
): UsageSink {
  return {
    record(usage: CallUsage): void {
      const ctx = storage.getStore();
      if (!ctx) return; // a call outside any context isn't attributable — skip (shouldn't happen in prod)
      void recorder
        .recordUsage(ctx.orgId, {
          taskId: ctx.taskId,
          source: ctx.source,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          idempotencyKey: usage.idempotencyKey,
        })
        .catch((err) => logger?.error('usage meter: recordUsage failed', { err: String(err) }));
    },
  };
}
