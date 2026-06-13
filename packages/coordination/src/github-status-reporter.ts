// The GitHub write-back reporter (StatusReporter impl) — closes the agent loop:
// once a PR is open, post a status comment back onto the source issue (and close
// it when the task is done) under the GitHub App installation, attributed with
// the agent's operator-configured label.
//
//   resolve owner from externalStoryId ("owner/repo#number")
//     → getInstallationIdForOwner — missing → log + swallow + return
//     → resolve the agent's github binding (login) + delegation attribution label
//     → build the comment body (PR link + attribution trailer)
//     → GitHubAdapter.postIssueStatus  (state 'done' → close; 'in_review' → leave open)
//   any failure → log + best-effort audit + return (NEVER throw).
//
// Swallow-and-log is deliberate (resolved design Q5): a status-back failure when
// the PR is ALREADY open must not propagate. Propagating would drive orchestrate's
// breaker → failure reset → re-drive → a DUPLICATE customer PR. The PR is the
// durable outcome; a missed comment is a soft failure to log, not to retry here.
//
// `routingStatusReporter` dispatches on `update.platform`: 'github' → this
// reporter, everything else → the injected gated no-op (shortcut stays gated).
//
// Boundary: coordination is the composition root; it may import @tasca/adapters.

import type { CoordinationStore } from './store';
import type { Logger, StatusReporter, StatusUpdate } from './ports';

/** The subset of the GitHub adapter the reporter drives (write-back only). */
export interface GitHubWriteBack {
  postIssueStatus(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    installationId: string;
    commentBody: string;
    closeIssue?: boolean;
  }): Promise<void>;
}

/** The identity reads the reporter needs (agent github handle + attribution). */
export interface GitHubIdentityReader {
  /** The agent's github binding (for the @handle), or null. */
  getBinding(
    agentId: string,
    platform: 'github'
  ): Promise<{ externalHandle: string | null } | null>;
  /** The agent's delegation (for the attribution label), or null. */
  getDelegation(agentId: string): Promise<{ attributionLabel: string } | null>;
}

/** Best-effort audit append on a swallowed failure (optional). */
export interface StatusAuditSink {
  record(input: {
    agentId: string;
    action: string;
    target?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

export interface GitHubStatusReporterDeps {
  store: Pick<CoordinationStore, 'getInstallationIdForOwner'>;
  identity: GitHubIdentityReader;
  github: GitHubWriteBack;
  logger?: Logger;
  /** Best-effort audit on a swallowed failure; absent → just logged. */
  audit?: StatusAuditSink;
}

/** Parsed `owner/repo#number`, or null when the id is not in that shape. */
export function parseGitHubStoryId(
  externalStoryId: string
): { owner: string; repo: string; issueNumber: number } | null {
  // "owner/repo#number" — owner and repo are non-slash/non-# segments.
  const m = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(externalStoryId);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, issueNumber: Number(m[3]!) };
}

/**
 * Build the issue-comment body: the progress comment + PR link, with the
 * operator-configured attribution label prepended as a single trailer line when
 * one is set. No provenance/tooling text — the label is whatever the operator
 * configured on the agent's delegation.
 */
function buildCommentBody(update: StatusUpdate, attributionLabel: string | null): string {
  const lines: string[] = [];
  if (attributionLabel) lines.push(attributionLabel);
  if (update.comment) lines.push(update.comment);
  if (update.prUrl) lines.push(update.prUrl);
  return lines.join('\n');
}

/**
 * A StatusReporter that posts GitHub issue status-back under the App. Never
 * throws: a missing installation or a REST failure is logged (and best-effort
 * audited) and swallowed, so the already-open PR is not re-driven.
 */
export class GitHubStatusReporter implements StatusReporter {
  private readonly logger: Logger;

  constructor(private readonly deps: GitHubStatusReporterDeps) {
    this.logger = deps.logger ?? console;
  }

  async postStatus(update: StatusUpdate): Promise<void> {
    const target = parseGitHubStoryId(update.externalStoryId);
    if (!target) {
      this.logger.error('github status-back: unparseable story id', {
        externalStoryId: update.externalStoryId,
        agentId: update.agentId,
      });
      return;
    }

    try {
      const installationId = await this.deps.store.getInstallationIdForOwner(target.owner);
      if (!installationId) {
        // No install recorded for this owner — log and swallow (the PR is open;
        // re-driving would duplicate it). The install webhook records the mapping.
        this.logger.error('github status-back: no installation for owner', {
          owner: target.owner,
          externalStoryId: update.externalStoryId,
          agentId: update.agentId,
        });
        return;
      }

      const delegation = await this.deps.identity.getDelegation(update.agentId);
      const commentBody = buildCommentBody(update, delegation?.attributionLabel ?? null);

      await this.deps.github.postIssueStatus({
        owner: target.owner,
        repo: target.repo,
        issueNumber: target.issueNumber,
        installationId,
        commentBody,
        // 'done' closes the issue; 'in_review' (and anything else) leaves it open.
        closeIssue: update.state === 'done',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('github status-back failed (swallowed)', {
        externalStoryId: update.externalStoryId,
        agentId: update.agentId,
        err: message,
      });
      // Best-effort audit; its own failure must not escalate the swallowed path.
      if (this.deps.audit) {
        await this.deps.audit
          .record({
            agentId: update.agentId,
            action: 'status.post.failed',
            target: update.externalStoryId,
            payload: { err: message, prUrl: update.prUrl },
          })
          .catch(() => {});
      }
    }
  }
}

/**
 * Route a StatusUpdate to the reporter for its platform. 'github' → the GitHub
 * reporter; 'shortcut' → the Shortcut reporter when one is wired (slice SC-3),
 * else the fallback; every other platform → the injected fallback (the existing
 * gated no-op — linear write-back stays gated). The orchestration loop injects
 * the routing reporter as its single `status` dependency.
 */
export function routingStatusReporter(byPlatform: {
  github: StatusReporter;
  shortcut?: StatusReporter;
  fallback: StatusReporter;
}): StatusReporter {
  return {
    async postStatus(update: StatusUpdate): Promise<void> {
      let reporter: StatusReporter;
      if (update.platform === 'github') reporter = byPlatform.github;
      else if (update.platform === 'shortcut') reporter = byPlatform.shortcut ?? byPlatform.fallback;
      else reporter = byPlatform.fallback;
      await reporter.postStatus(update);
    },
  };
}
