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
import { GitHubWebhookSchema, type AdapterEvent, type VerifiedEvent } from '@tasca/contracts';
import type { WebhookVerifier, RawWebhook, VerifiedWebhook, Logger } from './ports';

/** First Zod issue as `path: message`, so a schema reject names the offending field. */
function firstSchemaError(err: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  const issue = err.issues[0];
  if (!issue) return 'unknown schema error';
  return `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

/**
 * Per-delivery parse diagnostic. Beyond action/assignee, it re-runs the SAME
 * validation parseEvent uses (GitHubWebhookSchema.safeParse) and reports WHY a
 * delivery produced matched:0 — the schema rejected it (`schemaOk:false` +
 * `schemaError` naming the field), or repository/issue couldn't be resolved
 * (`repoResolved:false`). Without this, a schema reject reads as a phantom
 * "in set but matched:0" because diagnose reads the raw JSON, not the schema.
 */
function diagnose(
  rawBody: string,
  registeredGitHubIds: ReadonlySet<string>,
  matched: number
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return { jsonOk: false, matched, registeredCount: registeredGitHubIds.size };
  }
  const body = raw as {
    action?: unknown;
    assignee?: { id?: unknown } | null;
    comment?: unknown;
    repository?: { full_name?: unknown } | null;
    issue?: { number?: unknown } | null;
  };
  const action = typeof body.action === 'string' ? body.action : null;
  const assigneeId =
    action === 'assigned' && body.assignee && body.assignee.id !== undefined && body.assignee.id !== null
      ? String(body.assignee.id)
      : null;
  const parsed = GitHubWebhookSchema.safeParse(raw);
  const repoResolved =
    parsed.success &&
    parsed.data.repository?.full_name !== undefined &&
    parsed.data.issue?.number !== undefined;
  return {
    action,
    assigneeId,
    assigneeInSet: assigneeId !== null ? registeredGitHubIds.has(assigneeId) : null,
    hasComment: Boolean(body.comment),
    matched,
    registeredCount: registeredGitHubIds.size,
    // Why parseEvent may have returned [] before reaching the assignee match:
    schemaOk: parsed.success,
    ...(parsed.success ? { repoResolved } : { schemaError: firstSchemaError(parsed.error) }),
  };
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
