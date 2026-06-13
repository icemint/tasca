import { describe, it, expect } from 'vitest';
import type { StatusUpdate, Logger } from './ports';
import { ShortcutStatusReporter, type ShortcutWriteBack } from './shortcut-status-reporter';
import type { AgentCredentialResolver } from './vendor-credential';

// Unit tests for the Shortcut write-back reporter (slice SC-3). Covers the happy path (resolves the
// agent's own token, posts the comment with the PR link), the skip-when-no-token path (no Shortcut
// identity configured → warn + return, no post), the missing-org path, and the swallow-on-failure
// contract (a REST failure never throws — the PR is already open).

/** Captures logger.error calls without printing. */
function fakeLogger(): Logger & { errors: Array<{ message: string; context?: Record<string, unknown> }> } {
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    errors,
    error: (message, context) => errors.push(context !== undefined ? { message, context } : { message }),
  };
}

/** A ShortcutWriteBack stub that records its postStoryComment calls. */
function fakeAdapter(opts: { fail?: boolean } = {}): ShortcutWriteBack & {
  calls: Array<{ token: string; storyId: string; text: string }>;
} {
  const calls: Array<{ token: string; storyId: string; text: string }> = [];
  return {
    calls,
    async postStoryComment(input) {
      calls.push(input);
      if (opts.fail) throw new Error('shortcut POST failed: 500');
    },
  };
}

/** A resolver stub returning a fixed token (or null). Typed as the Pick the reporter consumes. */
function fakeResolver(token: string | null): Pick<AgentCredentialResolver, 'resolve'> {
  return { async resolve() { return token; } };
}

function update(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    platform: 'shortcut',
    externalStoryId: '12345',
    agentId: 'agent-elvis',
    orgId: 'org1',
    state: 'in_review',
    comment: 'PR opened',
    prUrl: 'https://github.com/icemint/demo/pull/5',
    ...overrides,
  };
}

describe('ShortcutStatusReporter', () => {
  it('posts a comment as the agent (its own token) with the PR link', async () => {
    const adapter = fakeAdapter();
    const reporter = new ShortcutStatusReporter({
      credentials: fakeResolver('agent-token-abc'),
      adapter,
      logger: fakeLogger(),
    });
    await reporter.postStatus(update());
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toEqual({
      token: 'agent-token-abc',
      storyId: '12345',
      text: 'PR opened\nPR: https://github.com/icemint/demo/pull/5',
    });
  });

  it('omits the PR line when there is no prUrl', async () => {
    const adapter = fakeAdapter();
    const reporter = new ShortcutStatusReporter({ credentials: fakeResolver('t'), adapter });
    // No prUrl at all (exactOptionalPropertyTypes: omit the key, don't set it to undefined).
    await reporter.postStatus({ platform: 'shortcut', externalStoryId: '12345', agentId: 'a', orgId: 'org1', comment: 'PR opened' });
    expect(adapter.calls[0]?.text).toBe('PR opened');
  });

  it('skips (warns, no post) when the agent has no Shortcut identity configured', async () => {
    const adapter = fakeAdapter();
    const logger = fakeLogger();
    const reporter = new ShortcutStatusReporter({ credentials: fakeResolver(null), adapter, logger });
    await reporter.postStatus(update());
    expect(adapter.calls).toHaveLength(0); // never posted
    expect(logger.errors.some((e) => e.message.includes('no Shortcut identity'))).toBe(true);
  });

  it('skips (warns, no post) when the update carries no orgId', async () => {
    const adapter = fakeAdapter();
    const logger = fakeLogger();
    const reporter = new ShortcutStatusReporter({ credentials: fakeResolver('t'), adapter, logger });
    // No orgId at all (omit the key under exactOptionalPropertyTypes).
    await reporter.postStatus({ platform: 'shortcut', externalStoryId: '12345', agentId: 'a', comment: 'PR opened' });
    expect(adapter.calls).toHaveLength(0);
    expect(logger.errors.some((e) => e.message.includes('no orgId'))).toBe(true);
  });

  it('SWALLOWS a REST failure (the PR is already open — never throw)', async () => {
    const adapter = fakeAdapter({ fail: true });
    const logger = fakeLogger();
    const reporter = new ShortcutStatusReporter({ credentials: fakeResolver('t'), adapter, logger });
    await expect(reporter.postStatus(update())).resolves.toBeUndefined();
    expect(logger.errors.some((e) => e.message.includes('shortcut status-back failed'))).toBe(true);
  });

  it('SWALLOWS a token-resolve failure (never throws into the loop)', async () => {
    const adapter = fakeAdapter();
    const logger = fakeLogger();
    const reporter = new ShortcutStatusReporter({
      credentials: { async resolve() { throw new Error('db down'); } },
      adapter,
      logger,
    });
    await expect(reporter.postStatus(update())).resolves.toBeUndefined();
    expect(adapter.calls).toHaveLength(0);
    expect(logger.errors.some((e) => e.message.includes('token resolve failed'))).toBe(true);
  });

  it('never logs the resolved token', async () => {
    const adapter = fakeAdapter({ fail: true });
    const logger = fakeLogger();
    const reporter = new ShortcutStatusReporter({ credentials: fakeResolver('SECRET-TOKEN'), adapter, logger });
    await reporter.postStatus(update());
    expect(JSON.stringify(logger.errors)).not.toContain('SECRET-TOKEN');
  });
});
