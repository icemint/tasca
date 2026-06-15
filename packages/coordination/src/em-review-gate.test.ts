import { describe, it, expect, beforeEach } from 'vitest';
import type { Task } from '@tasca/domain';
import type { TaskAssignedEvent } from '@tasca/contracts';
import type { TaskInput } from '@tasca/routing';
import type { ClarificationComment, EmClarityReview, EmReviewerPort } from '@tasca/llm';
import { makeEmReviewGate, formatEmQuestions, type EmGateStore, type ShortcutCommentReader } from './em-review-gate';
import { currentUsageContext } from './usage-context';
import type { ShortcutWriteBack } from './shortcut-status-reporter';

// Unit proof of the EM requirements gate (EM v1 slice 2). FAIL-OPEN is the load-bearing contract: a
// missing manager / token / vault key / a thrown reviewer / a non-Shortcut event all resolve {clear:true}
// (proceed) and the gate NEVER throws. Unclear → it posts clarifying questions AS the EM and returns
// {clear:false}. All fakes are hand-rolled with real state; no LLM, no DB, no mocking framework.

// ── Fakes ───────────────────────────────────────────────────────────────────────
class FakeGateStore implements EmGateStore {
  /** projectId → managerId; absent = the project has no EM. */
  managers = new Map<string, string>();
  async getOrCreateProject(_orgId: string, repoRef: string | null): Promise<string> {
    return `proj:${repoRef ?? '∅'}`;
  }
  async getManagerForProject(_orgId: string, projectId: string): Promise<string | null> {
    return this.managers.get(projectId) ?? null;
  }
}

class FakeManagerCredentials {
  /** `${orgId} ${managerId}` → token; absent = no Shortcut identity configured. */
  tokens = new Map<string, string>();
  async resolve(orgId: string, managerId: string, _provider: 'shortcut'): Promise<string | null> {
    return this.tokens.get(`${orgId} ${managerId}`) ?? null;
  }
}

class FakeShortcut implements ShortcutWriteBack {
  posts: Array<{ token: string; storyId: string; text: string }> = [];
  throwOnPost = false;
  async postStoryComment(input: { token: string; storyId: string; text: string }): Promise<void> {
    if (this.throwOnPost) throw new Error('shortcut 500');
    this.posts.push(input);
  }
}

/** A comment reader for the conversation-aware re-review (EM v1 slice 3): returns a canned thread (records
 *  the token it was called with so the test can prove the EM's OWN token was used), or throws (fail-soft). */
class FakeCommentReader implements ShortcutCommentReader {
  thread: ClarificationComment[] = [];
  throwOnFetch = false;
  calledWithToken: string | null = null;
  async fetchStoryComments(input: { token: string; storyId: string }): Promise<ClarificationComment[]> {
    this.calledWithToken = input.token;
    if (this.throwOnFetch) throw new Error('shortcut 500 (fetch comments)');
    return this.thread;
  }
}

/** A reviewer that returns a canned verdict — and records the ambient usage source so the test can prove
 *  the call was metered as source='manager', plus the thread it was handed (slice 3). */
class FakeReviewer implements EmReviewerPort {
  calls = 0;
  observedSource: string | null = null;
  observedThread: ClarificationComment[] | undefined = undefined;
  constructor(
    private readonly verdict: EmClarityReview | { throw: true }
  ) {}
  async review(input: { title: string; body: string; thread?: ClarificationComment[] }): Promise<EmClarityReview> {
    this.calls += 1;
    this.observedSource = currentUsageContext()?.source ?? null;
    this.observedThread = input.thread;
    if ('throw' in this.verdict) throw new Error('anthropic 503 (model=claude-sonnet-4-6)');
    return this.verdict;
  }
}

const SHORTCUT_EVENT: TaskAssignedEvent = {
  type: 'task.assigned',
  platform: 'shortcut',
  externalStoryId: 'sc-story-42',
  agentExternalId: 'sc-agent-elvis',
  repoHint: 'acme/api',
};

const CONTENT: TaskInput = { title: 'Add a thing', body: 'somewhere, somehow' };

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    externalStoryId: 'sc-story-42',
    title: null,
    platform: 'shortcut',
    status: 'routable',
    version: 0,
    claimedBy: null,
    failureCount: 0,
    repoRef: 'acme/api',
    tierEstimate: null,
    lastError: null,
    preferredAgentId: null,
    emCleared: false,
    emClarificationRound: 0,
    ...over,
  };
}

// Wire a gate over the fakes. `key` null simulates the org having no vault key.
function makeGate(opts: {
  store: FakeGateStore;
  managerCredentials: FakeManagerCredentials;
  shortcut: FakeShortcut;
  comments: FakeCommentReader;
  reviewer: FakeReviewer;
  key?: string | null;
}) {
  return makeEmReviewGate({
    store: opts.store,
    managerCredentials: opts.managerCredentials,
    vendorKeyFor: async () => (opts.key === undefined ? 'sk-org-key' : opts.key),
    reviewerFor: () => opts.reviewer,
    shortcut: opts.shortcut,
    comments: opts.comments,
  });
}

describe('makeEmReviewGate (EM v1 slice 2)', () => {
  let store: FakeGateStore;
  let creds: FakeManagerCredentials;
  let shortcut: FakeShortcut;
  let comments: FakeCommentReader;
  beforeEach(() => {
    store = new FakeGateStore();
    creds = new FakeManagerCredentials();
    shortcut = new FakeShortcut();
    comments = new FakeCommentReader();
    // Default happy wiring: the project has an EM with a Shortcut token + an org key.
    store.managers.set('proj:acme/api', 'mgr-elvis');
    creds.tokens.set('org_a mgr-elvis', 'sc-em-token-SECRET');
  });

  it('CLEAR → proceed, no comment posted', async () => {
    const reviewer = new FakeReviewer({ clear: true, questions: [] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(reviewer.calls).toBe(1);
    expect(shortcut.posts).toHaveLength(0);
  });

  it('UNCLEAR → posts the clarifying questions AS the EM (its token) and returns clear:false', async () => {
    const reviewer = new FakeReviewer({ clear: false, questions: ['Which service?', 'What is the acceptance criterion?'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: false });
    expect(shortcut.posts).toHaveLength(1);
    expect(shortcut.posts[0]!.token).toBe('sc-em-token-SECRET'); // posted under the EM's own token
    expect(shortcut.posts[0]!.storyId).toBe('sc-story-42');
    expect(shortcut.posts[0]!.text).toContain('Which service?');
    expect(shortcut.posts[0]!.text).toContain('What is the acceptance criterion?');
  });

  it('the clarity call is metered as source="manager" (the EM\'s spend)', async () => {
    const reviewer = new FakeReviewer({ clear: true, questions: [] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(reviewer.observedSource).toBe('manager');
  });

  it('UNCLEAR but the comment POST fails → still clear:false (the task parks regardless)', async () => {
    shortcut.throwOnPost = true;
    const reviewer = new FakeReviewer({ clear: false, questions: ['Clarify the scope?'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: false }); // verdict unchanged by a failed post
  });

  it('NO manager on the project → clear (fail-open), no LLM call', async () => {
    store.managers.clear();
    const reviewer = new FakeReviewer({ clear: false, questions: ['x'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(reviewer.calls).toBe(0);
    expect(shortcut.posts).toHaveLength(0);
  });

  it('NO manager token (no Shortcut identity) → clear (fail-open), no LLM call', async () => {
    creds.tokens.clear();
    const reviewer = new FakeReviewer({ clear: false, questions: ['x'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(reviewer.calls).toBe(0);
  });

  it('NO org vault key → clear (fail-open), no LLM call', async () => {
    const reviewer = new FakeReviewer({ clear: false, questions: ['x'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer, key: null });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(reviewer.calls).toBe(0);
  });

  it('the reviewer THROWS (LLM error) → clear (fail-open), never throws out of the gate', async () => {
    const reviewer = new FakeReviewer({ throw: true });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(shortcut.posts).toHaveLength(0);
  });

  it('a NON-Shortcut event → clear (v1 is Shortcut-first), no manager lookup or LLM call', async () => {
    const reviewer = new FakeReviewer({ clear: false, questions: ['x'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const githubEvent: TaskAssignedEvent = { ...SHORTCUT_EVENT, platform: 'github' };
    const out = await gate('org_a', task(), CONTENT, githubEvent);
    expect(out).toEqual({ clear: true });
    expect(reviewer.calls).toBe(0);
  });

  // ── Conversation-aware re-review (EM v1 slice 3) ───────────────────────────────
  it('the FIRST review (no comments yet) → judges on an EMPTY thread (story alone)', async () => {
    const reviewer = new FakeReviewer({ clear: false, questions: ['Which service?'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(comments.calledWithToken).toBe('sc-em-token-SECRET'); // fetched under the EM's OWN token
    expect(reviewer.observedThread).toEqual([]);
  });

  it('the RE-REVIEW sees the Q&A thread → a satisfactory reply CLEARS the story (proceed)', async () => {
    comments.thread = [
      { author: 'em-member-id', text: 'Which service owns this?' },
      { author: 'human-member-id', text: 'The billing service.' },
    ];
    const reviewer = new FakeReviewer({ clear: true, questions: [] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(reviewer.observedThread).toEqual(comments.thread); // the thread reached the judge
    expect(shortcut.posts).toHaveLength(0); // cleared → no new questions posted
  });

  it('the RE-REVIEW with a STILL-unclear thread → posts new questions + parks again (clear:false)', async () => {
    comments.thread = [
      { author: 'em-member-id', text: 'Which service?' },
      { author: 'human-member-id', text: 'Not sure yet.' },
    ];
    const reviewer = new FakeReviewer({ clear: false, questions: ['Please name the service.'] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: false });
    expect(reviewer.observedThread).toEqual(comments.thread);
    expect(shortcut.posts).toHaveLength(1);
  });

  it('a comment-FETCH error → judges on the story alone (fail-soft), never blocks', async () => {
    comments.throwOnFetch = true;
    const reviewer = new FakeReviewer({ clear: true, questions: [] });
    const gate = makeGate({ store, managerCredentials: creds, shortcut, comments, reviewer });
    const out = await gate('org_a', task(), CONTENT, SHORTCUT_EVENT);
    expect(out).toEqual({ clear: true });
    expect(reviewer.calls).toBe(1); // the review still ran
    expect(reviewer.observedThread).toEqual([]); // degraded to an empty thread
  });
});

describe('formatEmQuestions', () => {
  it('renders the questions as a bulleted comment under a lead line', () => {
    const text = formatEmQuestions(['A?', 'B?']);
    expect(text).toContain('- A?');
    expect(text).toContain('- B?');
    expect(text.split('\n')[0]).toMatch(/clarified/i);
  });
});
