// The GitHub webhook verifier, wired from the real @tasca/adapters GitHubAdapter.
// Extracted from main.ts so the parse path + its intake diagnostic are unit-testable
// (main.ts runs main() on import and can't be imported by a test).
//
//   verify : HMAC-SHA-256 (X-Hub-Signature-256); idempotency key = X-GitHub-Delivery header.
//   parse  : issues.assigned (top-level assignee.id) + issue_comment.created (@-mention),
//            each ∩ the registered github agent ids → AdapterEvents.
//
// Emits one structured "github intake parse" line per delivery: the action, the
// parsed assignee id, whether that id is in the registered set, and the match count.
// This makes a zero-match delivery diagnosable (wrong action vs unknown assignee vs
// empty roster) instead of silently producing events:0.

import { GitHubAdapter } from '@tasca/adapters';
import type { AdapterEvent, VerifiedEvent } from '@tasca/contracts';
import type { WebhookVerifier, RawWebhook, VerifiedWebhook, Logger } from './ports';

/** Per-delivery parse diagnostic — the same fields parseEvent keys its decision on. */
function diagnose(
  rawBody: string,
  registeredGitHubIds: ReadonlySet<string>,
  matched: number
): Record<string, unknown> {
  try {
    const body = JSON.parse(rawBody) as {
      action?: unknown;
      assignee?: { id?: unknown } | null;
      comment?: unknown;
    };
    const assigneeId =
      body.assignee && body.assignee.id !== undefined && body.assignee.id !== null
        ? String(body.assignee.id)
        : null;
    return {
      action: typeof body.action === 'string' ? body.action : null,
      assigneeId,
      assigneeInSet: assigneeId !== null ? registeredGitHubIds.has(assigneeId) : null,
      hasComment: Boolean(body.comment),
      matched,
      registeredCount: registeredGitHubIds.size,
    };
  } catch {
    return { parseError: true, matched, registeredCount: registeredGitHubIds.size };
  }
}

export function githubVerifier(
  secret: string,
  registeredGitHubIds: ReadonlySet<string>,
  logger?: Logger
): WebhookVerifier {
  const adapter = new GitHubAdapter({ webhookSecret: secret });
  return {
    verify(raw: RawWebhook): VerifiedWebhook | null {
      const v = adapter.verifyWebhook(raw.rawBody, raw.headers);
      if (!v.ok) return null;
      // GitHub's per-delivery id is a header, not a body field.
      const delivery = raw.headers['x-github-delivery'] ?? raw.headers['X-GitHub-Delivery'];
      if (!delivery) return null;
      return { platform: 'github', externalEventId: String(delivery), payload: v };
    },
    parse(verified: VerifiedWebhook): AdapterEvent[] {
      const payload = verified.payload as VerifiedEvent;
      const events = adapter.parseEvent(payload, registeredGitHubIds);
      logger?.info?.('github intake parse', diagnose(payload.rawBody, registeredGitHubIds, events.length));
      return events;
    },
  };
}
