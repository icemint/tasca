// The GitHub PR-merge → task-done side-handler (board states slice). When an
// agent's pull request is merged, GitHub delivers a `pull_request` event with
// action `closed` + `merged === true`. This handler resolves that PR back to the
// task that opened it and auto-advances the task to `done` — the board's
// PR Opened → Completed transition.
//
// It runs at the webhook edge with NO org in hand: the only key it has is the PR's
// globally-unique url. It resolves the owning org/task by that url (the cross-org
// resolver `getTaskIdByPullRequestUrl`) and acts ONLY within that org — never the
// default tenant, never an unrelated task.
//
// Fail-closed + idempotent by construction:
//   - a merge for a PR Tasca did not open (no pull_request row) → no row resolves →
//     no-op (nothing touched);
//   - a task NOT in `in_review` (already done, or never opened a PR via the normal
//     flow) → skipped with an info log, so setStatus's terminal `done` guard is never
//     even reached and a redelivery can't double-advance;
//   - only an `in_review` task is advanced, which the domain transition map allows.
// The handler is best-effort: the server invokes it inside a try/catch that never
// fails the webhook, and the webhook idempotency ledger dedupes redeliveries.

import type { TaskStatus } from '@tasca/domain';
import type { VerifiedEvent } from '@tasca/contracts';
import type { Logger } from './ports';

/** The PR-merge parser this handler needs (the GitHub adapter's `parseMergedPr`). */
export interface MergedPrParser {
  parseMergedPr(verified: VerifiedEvent): { prUrl: string } | null;
}

/** The narrow store surface the merge handler reads/writes. */
export interface MergeHandlerStore {
  getTaskIdByPullRequestUrl(url: string): Promise<{ orgId: string; taskId: string } | null>;
  getTask(orgId: string, taskId: string): Promise<{ status: TaskStatus } | null>;
  markPullRequestMerged(orgId: string, url: string): Promise<void>;
  setStatus(orgId: string, taskId: string, status: TaskStatus): Promise<void>;
}

export interface GitHubMergeHandlerDeps {
  store: MergeHandlerStore;
  parser: MergedPrParser;
  logger: Logger;
}

/**
 * Build the `(rawBody) => Promise<void>` side-handler the server invokes on a
 * verified github webhook. Pure of HTTP concerns: it takes the raw body, parses the
 * merge signal, and drives the store. Errors propagate to the caller, which wraps
 * the call best-effort (a handler failure must not fail the webhook).
 */
export function makeGitHubMergeHandler(deps: GitHubMergeHandlerDeps): (rawBody: string) => Promise<void> {
  const { store, parser, logger } = deps;
  return async (rawBody: string): Promise<void> => {
    const merged = parser.parseMergedPr({ ok: true, rawBody });
    if (!merged) return; // not a merge event (closed-not-merged / non-PR / malformed)

    const owner = await store.getTaskIdByPullRequestUrl(merged.prUrl);
    if (!owner) {
      // A PR Tasca did not open (no recorded row). Do not touch anything.
      logger.info?.('coordination: pr-merge for an unknown PR — skipped', { prUrl: merged.prUrl });
      return;
    }
    const { orgId, taskId } = owner;

    const task = await store.getTask(orgId, taskId);
    if (!task) {
      logger.info?.('coordination: pr-merge for a vanished task — skipped', { taskId });
      return;
    }

    // Record the merge on the PR row FIRST, regardless of the task's current status — so the merge fact
    // is durably captured even if an operator escalated the task out of in_review before it merged (the
    // PR row then reads merged while the task sits in needs_attention: honest + recoverable, not lost).
    // rowCount is intentionally unchecked: a 0-row update means the PR row was deleted in a near-
    // impossible race, whose only effect is a skipped state-mirror — never the task lifecycle.
    await store.markPullRequestMerged(orgId, merged.prUrl);

    // Advance ONLY from `in_review`. A task already `done` (a duplicate merge redelivery) or moved
    // elsewhere (e.g. operator-escalated to needs_attention) is left as-is — the merge is recorded
    // above, the board shows the task's real state, and the terminal `done` guard is never hit (so a
    // redelivery is a clean no-op, not a throw).
    if (task.status !== 'in_review') {
      logger.info?.('coordination: pr-merge recorded; task not in in_review — not advanced', {
        taskId,
        status: task.status,
      });
      return;
    }
    await store.setStatus(orgId, taskId, 'done');
    logger.info?.('coordination: task auto-completed on pr merge', { taskId });
  };
}
