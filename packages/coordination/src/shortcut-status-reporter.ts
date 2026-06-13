// The Shortcut write-back reporter (StatusReporter impl) — closes the agent loop
// on Shortcut: once a PR is open, post a status COMMENT back onto the source story
// under the AGENT'S OWN Shortcut Agent-User token (its per-agent vault credential),
// so the comment is attributed to the agent's native Shortcut identity.
//
//   resolve the agent's Shortcut token (AgentCredentialResolver, org-scoped)
//     → no token (no Shortcut identity configured) → log a warn + return
//     → build the comment text (the progress comment + PR link)
//     → ShortcutWriteBack.postStoryComment  (token rides only in the header)
//   any failure → log a structured warn + return (NEVER throw).
//
// PROJECTION MODEL: Shortcut's own native GitHub integration moves the story's
// workflow state on PR events, so this reporter writes ONLY a comment — it does
// NOT change state. (StatusUpdate.state is therefore ignored here; mirroring how
// the GitHub reporter owns close-on-done, the Shortcut state is owned upstream.)
//
// Swallow-and-log is deliberate (mirrors github-status-reporter): a status-back
// failure when the PR is ALREADY open must not propagate — propagating would
// re-drive orchestration into a DUPLICATE customer PR. The PR is the durable
// outcome; a missed comment is a soft failure to log, not to retry here.
//
// Boundary: coordination is the composition root; it may import @tasca/adapters.

import type { Logger, StatusReporter, StatusUpdate } from './ports';
import type { AgentCredentialResolver } from './vendor-credential';

/** The subset of the Shortcut adapter the reporter drives (write-back only). */
export interface ShortcutWriteBack {
  postStoryComment(input: { token: string; storyId: string; text: string }): Promise<void>;
}

export interface ShortcutStatusReporterDeps {
  /** Resolves the agent's OWN Shortcut Agent-User token (org-scoped), or null when none is configured. */
  credentials: Pick<AgentCredentialResolver, 'resolve'>;
  adapter: ShortcutWriteBack;
  logger?: Logger;
}

/**
 * Build the story-comment body: the progress comment + PR link, one per line. No
 * provenance/tooling text — just the agent's own update. (The agent's identity IS
 * the Shortcut-Token the comment is posted under.)
 */
function buildCommentBody(update: StatusUpdate): string {
  return [update.comment, update.prUrl ? `PR: ${update.prUrl}` : ''].filter(Boolean).join('\n');
}

/**
 * A StatusReporter that posts a Shortcut story comment under the agent's native
 * identity. Never throws: a missing token or a REST failure is logged (warn) and
 * swallowed, so the already-open PR is not re-driven.
 */
export class ShortcutStatusReporter implements StatusReporter {
  private readonly logger: Logger;

  constructor(private readonly deps: ShortcutStatusReporterDeps) {
    this.logger = deps.logger ?? console;
  }

  async postStatus(update: StatusUpdate): Promise<void> {
    // org-scoped credential read: without the task's org we cannot resolve the agent's token. This
    // should not happen (finalizeDispatch always sets orgId on the update), but fail closed + loud.
    if (!update.orgId) {
      this.logger.error?.('shortcut status-back: no orgId on the update — cannot resolve the agent token', {
        externalStoryId: update.externalStoryId,
        agentId: update.agentId,
      });
      return;
    }

    let token: string | null;
    try {
      token = await this.deps.credentials.resolve(update.orgId, update.agentId, 'shortcut');
    } catch (err) {
      this.logger.error?.('shortcut status-back: token resolve failed (swallowed)', {
        externalStoryId: update.externalStoryId,
        agentId: update.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!token) {
      // The agent has no Shortcut identity configured — skip the comment (the PR is open; the native
      // GitHub integration still moves the story state). A clear warn so the gap is actionable.
      this.logger.error?.('shortcut status-back: no Shortcut identity configured for agent — skipping comment', {
        externalStoryId: update.externalStoryId,
        agentId: update.agentId,
      });
      return;
    }

    try {
      await this.deps.adapter.postStoryComment({
        token,
        storyId: update.externalStoryId,
        text: buildCommentBody(update),
      });
    } catch (err) {
      // The PR is already open; never throw (would re-drive → duplicate PR). Log + swallow.
      this.logger.error?.('shortcut status-back failed (swallowed)', {
        externalStoryId: update.externalStoryId,
        agentId: update.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
