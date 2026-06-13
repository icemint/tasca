import { describe, it, expect } from 'vitest';
import type { StatusReporter, StatusUpdate, Logger } from './ports';
import {
  GitHubStatusReporter,
  routingStatusReporter,
  parseGitHubStoryId,
  type GitHubWriteBack,
  type GitHubIdentityReader,
} from './github-status-reporter';

// Unit tests for the GitHub write-back reporter. Covers the happy path (owner/
// repo/issue parsed from "owner/repo#number", attribution trailer + PR link in
// the body, done→close), the swallow-and-log paths (missing installation, REST
// failure — neither throws), and the platform routing (shortcut → gated no-op).

/** Captures logger.error calls without printing. */
function fakeLogger(): Logger & { errors: Array<{ message: string; context?: Record<string, unknown> }> } {
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    errors,
    error: (message, context) =>
      errors.push(context !== undefined ? { message, context } : { message }),
  };
}

/** A GitHubWriteBack stub that records its postIssueStatus calls. */
function fakeGitHub(opts: { fail?: boolean } = {}): GitHubWriteBack & {
  calls: Array<Parameters<GitHubWriteBack['postIssueStatus']>[0]>;
} {
  const calls: Array<Parameters<GitHubWriteBack['postIssueStatus']>[0]> = [];
  return {
    calls,
    async postIssueStatus(input) {
      calls.push(input);
      if (opts.fail) throw new Error('github POST failed: 500');
    },
  };
}

const identity: GitHubIdentityReader = {
  async getBinding() {
    return { externalHandle: 'elvis-tasca' };
  },
  async getDelegation() {
    return { attributionLabel: 'On behalf of the platform team' };
  },
};

function update(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    platform: 'github',
    externalStoryId: 'icemint/demo#42',
    agentId: 'agent-elvis',
    state: 'in_review',
    comment: 'PR opened',
    prUrl: 'https://github.com/icemint/demo/pull/5',
    ...overrides,
  };
}

describe('parseGitHubStoryId', () => {
  it('splits owner/repo#number', () => {
    expect(parseGitHubStoryId('icemint/demo#42')).toEqual({
      owner: 'icemint',
      repo: 'demo',
      issueNumber: 42,
    });
  });
  it('returns null for a non-github story id', () => {
    expect(parseGitHubStoryId('sc-story-1')).toBeNull();
    expect(parseGitHubStoryId('icemint/demo')).toBeNull();
  });
});

describe('GitHubStatusReporter.postStatus', () => {
  it('posts a comment when the installation is found, with attribution + PR link', async () => {
    const github = fakeGitHub();
    const reporter = new GitHubStatusReporter({
      store: { async getInstallationIdForOwner() { return '77'; } },
      identity,
      github,
    });

    await reporter.postStatus(update());

    expect(github.calls).toHaveLength(1);
    const call = github.calls[0]!;
    expect(call.owner).toBe('icemint');
    expect(call.repo).toBe('demo');
    expect(call.issueNumber).toBe(42);
    expect(call.installationId).toBe('77');
    expect(call.closeIssue).toBe(false); // in_review leaves it open
    expect(call.commentBody).toBe(
      'On behalf of the platform team\nPR opened\nhttps://github.com/icemint/demo/pull/5'
    );
  });

  it('closes the issue when state is done', async () => {
    const github = fakeGitHub();
    const reporter = new GitHubStatusReporter({
      store: { async getInstallationIdForOwner() { return '77'; } },
      identity,
      github,
    });
    await reporter.postStatus(update({ state: 'done', comment: 'merged' }));
    expect(github.calls[0]!.closeIssue).toBe(true);
  });

  it('swallows + logs when no installation is found (does not throw, no post)', async () => {
    const github = fakeGitHub();
    const logger = fakeLogger();
    const reporter = new GitHubStatusReporter({
      store: { async getInstallationIdForOwner() { return null; } },
      identity,
      github,
      logger,
    });

    await expect(reporter.postStatus(update())).resolves.toBeUndefined();
    expect(github.calls).toHaveLength(0);
    expect(logger.errors.some((e) => /no installation/.test(e.message))).toBe(true);
  });

  it('swallows + logs + audits when the REST call fails (does not throw)', async () => {
    const github = fakeGitHub({ fail: true });
    const logger = fakeLogger();
    const audited: Array<{ action: string }> = [];
    const reporter = new GitHubStatusReporter({
      store: { async getInstallationIdForOwner() { return '77'; } },
      identity,
      github,
      logger,
      audit: { async record(input) { audited.push({ action: input.action }); } },
    });

    await expect(reporter.postStatus(update())).resolves.toBeUndefined();
    expect(logger.errors.some((e) => /status-back failed/.test(e.message))).toBe(true);
    expect(audited).toEqual([{ action: 'status.post.failed' }]);
  });

  it('swallows + logs an unparseable story id (no post)', async () => {
    const github = fakeGitHub();
    const logger = fakeLogger();
    const reporter = new GitHubStatusReporter({
      store: { async getInstallationIdForOwner() { return '77'; } },
      identity,
      github,
      logger,
    });
    await reporter.postStatus(update({ externalStoryId: 'sc-story-1' }));
    expect(github.calls).toHaveLength(0);
    expect(logger.errors.some((e) => /unparseable story id/.test(e.message))).toBe(true);
  });
});

describe('routingStatusReporter', () => {
  it('routes github to the github reporter and shortcut to the fallback (gated no-op)', async () => {
    const githubCalls: StatusUpdate[] = [];
    const fallbackCalls: StatusUpdate[] = [];
    const github: StatusReporter = { async postStatus(u) { githubCalls.push(u); } };
    const fallback: StatusReporter = { async postStatus(u) { fallbackCalls.push(u); } };
    const router = routingStatusReporter({ github, fallback });

    await router.postStatus(update({ platform: 'github' }));
    await router.postStatus(update({ platform: 'shortcut', externalStoryId: 'sc-1' }));

    expect(githubCalls).toHaveLength(1);
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]!.platform).toBe('shortcut');
  });

  it('when a shortcut reporter is wired, shortcut events route to IT, not the fallback', async () => {
    const shortcutCalls: StatusUpdate[] = [];
    const fallbackCalls: StatusUpdate[] = [];
    const github: StatusReporter = { async postStatus() {} };
    const shortcut: StatusReporter = { async postStatus(u) { shortcutCalls.push(u); } };
    const fallback: StatusReporter = { async postStatus(u) { fallbackCalls.push(u); } };
    const router = routingStatusReporter({ github, shortcut, fallback });

    await router.postStatus(update({ platform: 'shortcut', externalStoryId: 'sc-1' }));

    expect(shortcutCalls).toHaveLength(1);
    expect(shortcutCalls[0]!.platform).toBe('shortcut');
    expect(fallbackCalls).toHaveLength(0); // the gated no-op is NOT taken when a real reporter is wired
  });
});
