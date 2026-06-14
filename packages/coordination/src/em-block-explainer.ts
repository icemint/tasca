// The EM (Engineering Manager) block-explanation (EM v1 slice 4) — the human one-liner for a blocked task.
//
// When a task is retired to a blocked state (`needs_attention`/`failed`) with a RAW internal reason
// (e.g. "no execution capacity: no agent-runner claimed within 30000ms"), the EM for the task's project
// LLM-rephrases it into ONE calm, operator-facing sentence and writes it back to `last_error` (the
// board's Blocked column already renders it). This is a pure post-step on the text — it never changes the
// task lifecycle, the breaker, or the orchestration outcome.
//
// BEST-EFFORT + FAIL-OPEN BY CONTRACT. The returned function NEVER throws. Every missing dependency or
// error leaves the RAW reason in place (the block itself already happened — the explainer only upgrades
// the text):
//   - no manager on project → return  (the project has no EM)
//   - no org vault key       → return  (BYOK: no key → no LLM)
//   - LLM error / store error → caught, warn-logged, return  (the raw reason stays)
//
// The guard on updateBlockReason (still-blocked status only) means a task that resumed / was re-driven
// between the block and this rephrase is NOT overwritten. Platform-agnostic: it only rewrites text (no
// comment posted), so it works for any blocked task regardless of platform. The org vault key is NEVER
// logged.
//
// Boundary: coordination is the composition root; this composes the store seam, the manager + vault
// resolvers, and the LLM explainer factory. The factory wires it as OrchestrationDeps.emBlockExplainer.

import type { Task } from '@tasca/domain';
import type { TaskInput } from '@tasca/routing';
import type { EmBlockExplainerPort } from '@tasca/llm';
import type { Logger } from './ports';
import { withUsageContext } from './usage-context';

/** The narrow store slice the explainer needs — resolve the task's project + its EM, then write the
 *  rephrased reason back (guarded to a still-blocked status). */
export interface EmBlockExplainerStore {
  getOrCreateProject(orgId: string, repoRef: string | null): Promise<string>;
  getManagerForProject(orgId: string, projectId: string): Promise<string | null>;
  updateBlockReason(orgId: string, taskId: string, humanReason: string): Promise<boolean>;
}

export interface EmBlockExplainerDeps {
  store: EmBlockExplainerStore;
  /** Resolve the org's OWN Anthropic vault key (BYOK), or null when the org has no key. */
  vendorKeyFor(orgId: string): Promise<string | null>;
  /** Build the EM block explainer on a resolved vault key — the LLM call path (the latest Anthropic
   *  model, metered as source='manager' via the ambient usage context). */
  explainerFor(apiKey: string): EmBlockExplainerPort;
  logger?: Logger;
}

/** Max length of the rephrased reason written back to last_error. The model is asked for one sentence; this
 *  bounds a runaway response so the Blocked column never renders an essay. */
const MAX_HUMAN_REASON_CHARS = 280;

/** The block-explanation content the explainer reads — the task title (for context) and the raw reason. */
export interface BlockContent {
  title: string;
}

/**
 * Build the EM block explainer (the OrchestrationDeps.emBlockExplainer shape). Best-effort everywhere: the
 * returned function NEVER throws and leaves the raw reason on any missing dependency or error.
 */
export function makeEmBlockExplainer(
  deps: EmBlockExplainerDeps
): (orgId: string, task: Task, content: BlockContent, rawReason: string) => Promise<void> {
  const logger = deps.logger;
  return async (orgId, task, content, rawReason) => {
    try {
      // Resolve the EM for the task's project. No manager → the project has no EM → keep the raw reason.
      const projectId = await deps.store.getOrCreateProject(orgId, task.repoRef);
      const managerId = await deps.store.getManagerForProject(orgId, projectId);
      if (!managerId) return;

      // Resolve the org vault key. No key → no LLM → keep the raw reason. The key is never logged.
      const apiKey = await deps.vendorKeyFor(orgId);
      if (!apiKey) return;

      // The rephrase, metered as source='manager' for this task (the EM's spend). Trim + bound the text.
      const rephrased = await withUsageContext({ orgId, taskId: task.id, source: 'manager' }, () =>
        deps.explainerFor(apiKey).explainBlock({ rawReason, title: content.title })
      );
      const humanReason = rephrased.trim().slice(0, MAX_HUMAN_REASON_CHARS);
      // An empty rephrase has nothing to upgrade to — keep the raw reason rather than blanking it.
      if (humanReason.length === 0) return;

      // Write the human reason back — guarded to a still-blocked status, so a task that moved on between
      // the block and now is a no-op (no stale overwrite).
      await deps.store.updateBlockReason(orgId, task.id, humanReason);
    } catch (err) {
      // FAIL-OPEN: ANY error (manager/key resolve, LLM, store write) leaves the raw reason in place. Log +
      // return; the block itself already happened. The vault key is NEVER logged.
      logger?.error?.('em block-explainer: rephrase failed — keeping the raw reason (best-effort)', {
        taskId: task.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
