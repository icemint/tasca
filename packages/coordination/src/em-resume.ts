// The EM reply-resume handler (EM v1 slice 3) — closes the clarify loop.
//
// When a human replies to the EM's clarifying questions ON a Shortcut story, the connection-scoped intake
// emits a `task.clarification_reply` event. This handler re-triggers the EM review for the parked task:
//
//   resolve the org-scoped task PARKED at awaiting_clarification for the story   [store]
//     → none → no-op (a comment on a story with no parked task — ignore)
//   resolve the task's project → its EM (manager)                               [store]
//     → the replier IS the EM (member id == manager.shortcutMemberId) → no-op    (the EM's own
//       posted questions round-trip back as a comment; they must not re-trigger the EM)
//   resume the task: awaiting_clarification → routable                          [store]
//     → em_cleared stays false (the gate re-runs) + the round PERSISTS (the cap still counts)
//   re-orchestrate via a SYNTHETIC task.assigned event for the story            [orchestrate]
//     → the gate re-runs WITH the conversation (its questions + the reply) → clear → dispatch,
//       or still-unclear → park again (round++, capped — all from slice 2).
//
// BEST-EFFORT off the verified webhook: this NEVER fails the webhook (the server runs it detached after the
// 202, like the orchestration path). A reply for an unknown / non-parked story is a clean no-op; the org is
// the CONNECTION's org (never the wrong tenant). Idempotent: a redelivered reply is dropped by the webhook
// ledger; a reply on an already-resumed/cleared/dispatched task finds no awaiting_clarification row → no-op.
//
// The EM-dedupe lives HERE, not in the adapter, because the adapter doesn't know the org's managers (it
// only carries the registered AGENT self-set). Resolving project → manager is org-scoped, so the dedupe is
// done where the manager identity is actually available.

import type { TaskAssignedEvent, TaskClarificationReplyEvent } from '@tasca/contracts';
import type { CoordinationStore } from './store';
import type { Logger } from './ports';
import { orchestrateTaskAssigned, type OrchestrationDeps } from './orchestrate';

/** The connection scope a Shortcut delivery resolved to (slice SC-1) — the org + repo + connection id the
 *  synthetic re-orchestration event must carry so the re-driven task keeps the connection's repo + read
 *  token (so the gate's story-content + comment fetch resolve the same connection). */
export interface ReplyConnectionContext {
  connectionId: string;
  orgId: string;
  repoRef: string | null;
}

/** The store slice the resume handler reads. */
type EmResumeStore = Pick<
  CoordinationStore,
  | 'getAwaitingClarificationTask'
  | 'getOrCreateProject'
  | 'getManagerForProject'
  | 'getManager'
  | 'resumeFromClarification'
>;

/** The outcome of one reply-resume pass (for the boundary log; the server doesn't branch on it). */
export type EmResumeOutcome =
  | { kind: 'no_parked_task' }
  | { kind: 'em_own_comment'; taskId: string }
  | { kind: 'already_moved'; taskId: string }
  | { kind: 'resumed'; taskId: string };

/**
 * Handle one `task.clarification_reply`. Resolves the parked task (org-scoped), drops the EM's own comment
 * (replier == the project manager's member id), resumes the task to `routable`, and re-orchestrates it via
 * a synthetic `task.assigned` event carrying the connection's repo + id. Returns a structured outcome for
 * the boundary log. Throws only on a genuine store/orchestration fault (the server's detached runner logs
 * + swallows it — it must never fail the webhook).
 */
export async function handleClarificationReply(
  event: TaskClarificationReplyEvent,
  deps: OrchestrationDeps,
  orgId: string,
  connection: ReplyConnectionContext,
  logger?: Logger
): Promise<EmResumeOutcome> {
  const store = deps.store as EmResumeStore;

  // The parked task for this story, in THIS org (the connection's org — never the wrong tenant). None →
  // the comment is on a story with no parked task (already routable / cleared / dispatched / done, or
  // never parked) → clean no-op.
  const task = await store.getAwaitingClarificationTask(orgId, 'shortcut', event.externalStoryId);
  if (!task) {
    logger?.info?.('em resume: no parked task for reply — ignoring', {
      externalStoryId: event.externalStoryId,
    });
    return { kind: 'no_parked_task' };
  }

  // Drop the EM's OWN comment: resolve the task's project → its EM, and if the replier is that EM's
  // Shortcut member id, this is the EM's posted questions round-tripping back — it must NOT re-trigger the
  // review. Resolved org-scoped here (the adapter can't, it doesn't know the managers).
  const projectId = await store.getOrCreateProject(orgId, task.repoRef);
  const managerId = await store.getManagerForProject(orgId, projectId);
  if (managerId && event.replierMemberId) {
    const manager = await store.getManager(orgId, managerId);
    if (manager?.shortcutMemberId && manager.shortcutMemberId === event.replierMemberId) {
      logger?.info?.('em resume: reply is the EM\'s own comment — ignoring', {
        taskId: task.id,
        externalStoryId: event.externalStoryId,
      });
      return { kind: 'em_own_comment', taskId: task.id };
    }
  }

  // Resume: awaiting_clarification → routable so the gate re-runs. Guarded — a concurrent move (operator
  // intervention, a racing redelivery already resumed) wins and this no-ops. em_cleared stays false; the
  // clarification round PERSISTS so the cap still fires.
  const resumed = await store.resumeFromClarification(orgId, task.id);
  if (!resumed) {
    logger?.info?.('em resume: task already moved out of awaiting_clarification — skipping re-orchestration', {
      taskId: task.id,
      externalStoryId: event.externalStoryId,
    });
    return { kind: 'already_moved', taskId: task.id };
  }

  // Re-orchestrate via a SYNTHETIC task.assigned event for the story. It carries the connection's repo
  // (so the re-driven task keeps its repo) + the connection id (so the content + comment fetch resolve
  // THIS connection's read/manager tokens). agentExternalId is not meaningful on a re-drive (routing
  // re-picks the winner from the hired roster), so a stable placeholder is used. The EDGE-resolved org is
  // threaded (never re-resolved from the event — a Shortcut event has no workspace).
  const syntheticEvent: TaskAssignedEvent = {
    type: 'task.assigned',
    platform: 'shortcut',
    externalStoryId: event.externalStoryId,
    agentExternalId: 'em-resume',
    shortcutConnectionId: connection.connectionId,
    ...(connection.repoRef ? { repoHint: connection.repoRef } : {}),
  };
  const outcome = await orchestrateTaskAssigned(syntheticEvent, deps, orgId);
  logger?.info?.('em resume: re-orchestrated after clarification reply', {
    taskId: task.id,
    externalStoryId: event.externalStoryId,
    kind: outcome.kind,
  });
  return { kind: 'resumed', taskId: task.id };
}
