// The EM (Engineering Manager) requirements gate (EM v1 slice 2) — the pre-dispatch clarity review.
//
// Before a story is routed to a worker, the EM for the task's project LLM-judges "is this clear enough
// to build?". Unclear → it posts clarifying questions on the story AS ITSELF (its slice-1 Shortcut
// identity) and the orchestration loop parks the task in `awaiting_clarification`; clear → the task
// proceeds to routing.
//
// FAIL-OPEN BY CONTRACT. The EM is an enhancement, never a hard gate — it must NEVER block the pipeline.
// Every problem resolves `{clear:true}` (skip → proceed), and the gate NEVER throws:
//   - non-Shortcut event   → {clear:true}  (v1 is Shortcut-first; GitHub-issue EM review is a later add)
//   - no manager on project → {clear:true}  (the project has no EM)
//   - no manager token      → {clear:true}  (the EM has no Shortcut identity configured)
//   - no org vault key      → {clear:true}  (BYOK: no key → no LLM)
//   - ANY error (resolve / LLM) → {clear:true}  (logged at warn, swallowed)
//
// A failed clarifying-comment POST does NOT change the verdict (still `{clear:false}` — the task parks
// regardless so a human can act); the post failure is logged. Secrets (the manager token, the vault key)
// are NEVER logged.
//
// Boundary: coordination is the composition root; this composes the store seam, the manager + vault
// resolvers, the LLM reviewer factory, and the Shortcut write-back. The factory wires it as
// OrchestrationDeps.emReviewGate.

import type { Task } from '@tasca/domain';
import type { TaskAssignedEvent } from '@tasca/contracts';
import type { TaskInput } from '@tasca/routing';
import type { ClarificationComment, EmReviewerPort } from '@tasca/llm';
import type { Logger } from './ports';
import type { ManagerCredentialResolver } from './vendor-credential';
import type { ShortcutWriteBack } from './shortcut-status-reporter';
import { withUsageContext } from './usage-context';

/** The slice of the Shortcut adapter the gate reads for its conversation-aware re-review (EM v1 slice 3):
 *  the story's comment thread (its own questions + the human's answer). A fetch failure degrades to judging
 *  on the story alone (fail-soft) — never blocks the gate. The token rides ONLY in the header. */
export interface ShortcutCommentReader {
  fetchStoryComments(input: { token: string; storyId: string }): Promise<ClarificationComment[]>;
}

/** The narrow store slice the gate reads — resolve the task's project, then its EM. */
export interface EmGateStore {
  getOrCreateProject(orgId: string, repoRef: string | null): Promise<string>;
  getManagerForProject(orgId: string, projectId: string): Promise<string | null>;
}

export interface EmReviewGateDeps {
  store: EmGateStore;
  /** Resolves the EM's OWN Shortcut Agent-User token (org+manager-scoped), or null when none is set. */
  managerCredentials: Pick<ManagerCredentialResolver, 'resolve'>;
  /** Resolve the org's OWN Anthropic vault key (BYOK), or null when the org has no key. */
  vendorKeyFor(orgId: string): Promise<string | null>;
  /** Build the EM clarity reviewer on a resolved vault key — the LLM call path (the latest Anthropic
   *  model, metered as source='manager' via the ambient usage context). */
  reviewerFor(apiKey: string): EmReviewerPort;
  /** Post the EM's clarifying questions as a story comment under the EM's token. */
  shortcut: ShortcutWriteBack;
  /** Read the story's comment thread (the EM's questions + the human's reply) so the re-review is
   *  conversation-aware (EM v1 slice 3). A fetch failure degrades to judging on the story alone. */
  comments: ShortcutCommentReader;
  logger?: Logger;
}

/** Format the EM's clarifying questions as a Shortcut story comment, posted AS the EM. No tooling /
 *  provenance text — the EM's identity IS the token the comment is posted under. */
export function formatEmQuestions(questions: string[]): string {
  return [
    'Before I route this to an engineer, I need a few things clarified:',
    ...questions.map((q) => `- ${q}`),
  ].join('\n');
}

/**
 * Build the EM requirements gate (the OrchestrationDeps.emReviewGate shape). Fail-open everywhere:
 * the returned function NEVER throws and resolves `{clear:true}` on any missing dependency or error.
 */
export function makeEmReviewGate(
  deps: EmReviewGateDeps
): (orgId: string, task: Task, content: TaskInput, event: TaskAssignedEvent) => Promise<{ clear: boolean }> {
  const logger = deps.logger;
  return async (orgId, task, content, event) => {
    // v1 is Shortcut-first: only Shortcut stories get EM review. GitHub-issue EM review is a later add.
    if (event.platform !== 'shortcut') return { clear: true };

    try {
      // Resolve the EM for the task's project. No manager → the project has no EM → proceed (fail-open).
      const projectId = await deps.store.getOrCreateProject(orgId, task.repoRef);
      const managerId = await deps.store.getManagerForProject(orgId, projectId);
      if (!managerId) return { clear: true };

      // Resolve the EM's Shortcut token + the org vault key. Either missing → no identity / no LLM →
      // proceed (fail-open). Neither secret is ever logged.
      const [managerToken, apiKey] = await Promise.all([
        deps.managerCredentials.resolve(orgId, managerId, 'shortcut'),
        deps.vendorKeyFor(orgId),
      ]);
      if (!managerToken || !apiKey) return { clear: true };

      // CONVERSATION-AWARE re-review (EM v1 slice 3): fetch the story's comment thread (the EM's earlier
      // questions + the human's answer) so a satisfactory reply can CLEAR the story — without it the judge
      // re-reads the unchanged title/body and loops to the cap. The first review has no comments yet (empty
      // thread → judge on the story alone, unchanged). A fetch error degrades to the story alone (fail-soft,
      // never blocks). The manager token rides ONLY in the adapter header — it is NEVER logged.
      let thread: ClarificationComment[] = [];
      try {
        thread = await deps.comments.fetchStoryComments({ token: managerToken, storyId: event.externalStoryId });
      } catch (err) {
        logger?.error?.('em gate: story-comment fetch failed — judging on the story alone (fail-soft)', {
          taskId: task.id,
          externalStoryId: event.externalStoryId,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      // The clarity judge, metered as source='manager' for this task (the EM's spend).
      const review = await withUsageContext({ orgId, taskId: task.id, source: 'manager' }, () =>
        deps.reviewerFor(apiKey).review({ title: content.title, body: content.body, thread })
      );
      if (review.clear) return { clear: true };

      // Unclear → post the clarifying questions AS the EM (best-effort; a failed post still parks the
      // task — the verdict is unclear regardless). The token rides only in the adapter header.
      try {
        await deps.shortcut.postStoryComment({
          token: managerToken,
          storyId: event.externalStoryId,
          text: formatEmQuestions(review.questions),
        });
      } catch (err) {
        logger?.error?.('em gate: clarifying-comment post failed (task still parks)', {
          taskId: task.id,
          externalStoryId: event.externalStoryId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return { clear: false };
    } catch (err) {
      // FAIL-OPEN: ANY error in the gate (manager/key resolve, LLM) must not block dispatch. Log + proceed.
      logger?.error?.('em gate: review failed — proceeding to dispatch (fail-open)', {
        taskId: task.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { clear: true };
    }
  };
}
