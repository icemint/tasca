import { describe, it, expect } from 'vitest';
import type { VerifiedEvent } from '@tasca/contracts';
import { githubVerifier } from './github-verifier';
import type { VerifiedWebhook, Logger } from './ports';

const SECRET = 'whsec_test';
const ELVIS_ID = '291630881';
const REGISTERED = new Set([ELVIS_ID, 'tasca-elvis']);

function recordingLogger() {
  const lines: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger: Logger = {
    error(message, context) {
      lines.push({ message, ...(context ? { context } : {}) });
    },
    info(message, context) {
      lines.push({ message, ...(context ? { context } : {}) });
    },
  };
  return { logger, lines };
}

/** A pre-verified webhook the verifier's parse() consumes (verify() already ran). */
function verified(body: Record<string, unknown>): VerifiedWebhook {
  return {
    platform: 'github',
    externalEventId: 'delivery-1',
    payload: { ok: true, rawBody: JSON.stringify(body) } as VerifiedEvent,
  };
}

const REPO = { full_name: 'roadhero/agentic-playground' };

describe('githubVerifier.parse (intake diagnostic)', () => {
  it('matches issues.assigned when the assignee id is registered, and logs assigneeInSet:true', () => {
    const { logger, lines } = recordingLogger();
    const events = githubVerifier(SECRET, REGISTERED, logger).parse(
      verified({ action: 'assigned', repository: REPO, issue: { number: 7 }, assignee: { id: 291630881, login: 'tasca-elvis' } })
    );
    expect(events).toEqual([
      { type: 'task.assigned', platform: 'github', externalStoryId: 'roadhero/agentic-playground#7', agentExternalId: ELVIS_ID, repoHint: 'roadhero/agentic-playground' },
    ]);
    expect(lines[0]!.context).toMatchObject({ action: 'assigned', assigneeId: ELVIS_ID, assigneeInSet: true, matched: 1 });
  });

  it('an UNKNOWN assignee id yields no events and logs assigneeInSet:false (the mismatch is visible)', () => {
    const { logger, lines } = recordingLogger();
    const events = githubVerifier(SECRET, REGISTERED, logger).parse(
      verified({ action: 'assigned', repository: REPO, issue: { number: 7 }, assignee: { id: 99999, login: 'someone-else' } })
    );
    expect(events).toEqual([]);
    expect(lines[0]!.context).toMatchObject({ action: 'assigned', assigneeId: '99999', assigneeInSet: false, matched: 0 });
  });

  it('a non-assigned action (opened, even with the assignee present) yields no events — diagnostic shows the action', () => {
    const { logger, lines } = recordingLogger();
    const events = githubVerifier(SECRET, REGISTERED, logger).parse(
      verified({ action: 'opened', repository: REPO, issue: { number: 7, assignees: [{ id: 291630881, login: 'tasca-elvis' }] }, assignee: { id: 291630881, login: 'tasca-elvis' } })
    );
    expect(events).toEqual([]);
    expect(lines[0]!.context).toMatchObject({ action: 'opened', matched: 0 });
  });

  it('an unassigned action (top-level assignee present, action≠assigned) yields no events and does NOT report assigneeInSet:true', () => {
    // GitHub sends a top-level `assignee` on `unassigned` too; the diagnostic must
    // not read as "in set but matched:0" — assigneeInSet/assigneeId are scoped to
    // the `assigned` action so the action gate is the unambiguous reason.
    const { logger, lines } = recordingLogger();
    const events = githubVerifier(SECRET, REGISTERED, logger).parse(
      verified({ action: 'unassigned', repository: REPO, issue: { number: 7 }, assignee: { id: 291630881, login: 'tasca-elvis' } })
    );
    expect(events).toEqual([]);
    expect(lines[0]!.context).toMatchObject({ action: 'unassigned', assigneeId: null, assigneeInSet: null, matched: 0 });
  });

  it('logs registeredCount so an empty roster is distinguishable', () => {
    const { logger, lines } = recordingLogger();
    githubVerifier(SECRET, new Set(), logger).parse(
      verified({ action: 'assigned', repository: REPO, issue: { number: 7 }, assignee: { id: 291630881, login: 'x' } })
    );
    expect(lines[0]!.context).toMatchObject({ assigneeInSet: false, registeredCount: 0 });
  });
});
