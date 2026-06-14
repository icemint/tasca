import { describe, it, expect } from 'vitest';
import type { AdapterEvent } from '@tasca/contracts';
import { makeShortcutContentSource, type ShortcutStoryReader } from './shortcut-content-source';
import type { TaskContentSource } from './orchestrate';

const CONNECTION_ID = 'conn-1';
const ORG_ID = 'org-1';

const shortcutEvent: AdapterEvent = {
  type: 'task.assigned',
  platform: 'shortcut',
  externalStoryId: '778899',
  agentExternalId: '11111111-1111-1111-1111-111111111111',
  shortcutConnectionId: CONNECTION_ID,
};

/** A fallback that records whether it was hit and with which event. */
function recordingFallback(): { source: TaskContentSource; calls: AdapterEvent[] } {
  const calls: AdapterEvent[] = [];
  return {
    calls,
    source: {
      async fetch(event) {
        calls.push(event);
        return { title: event.externalStoryId, body: '' };
      },
    },
  };
}

/** Hand-rolled store fake — returns a connection for the configured id, null otherwise. */
function fakeStore(connection: { orgId: string; repoRef: string | null } | null) {
  return {
    async getShortcutConnectionById(id: string) {
      return id === CONNECTION_ID ? connection : null;
    },
  };
}

/** Hand-rolled resolver fake — returns the configured read token for (org, conn, 'read_token'). */
function fakeResolver(token: string | null) {
  return {
    async resolve(orgId: string, connectionId: string, kind: string): Promise<string | null> {
      expect(orgId).toBe(ORG_ID);
      expect(connectionId).toBe(CONNECTION_ID);
      expect(kind).toBe('read_token');
      return token;
    },
  };
}

/** An adapter fake that fails the test if fetchStory is called when it should not be. */
function neverFetchAdapter(): ShortcutStoryReader {
  return {
    async fetchStory() {
      throw new Error('fetchStory must not be called');
    },
  };
}

describe('makeShortcutContentSource', () => {
  it('fetches the real story and maps name/description to a TaskInput', async () => {
    const requests: Array<{ token: string; storyId: string }> = [];
    const adapter: ShortcutStoryReader = {
      async fetchStory(input) {
        requests.push(input);
        return { name: 'Fix the parser', description: 'It crashes on empty input.' };
      },
    };
    const fb = recordingFallback();
    const source = makeShortcutContentSource({
      store: fakeStore({ orgId: ORG_ID, repoRef: 'acme/widgets' }),
      resolver: fakeResolver('tok_read_workspace'),
      adapter,
      fallback: fb.source,
    });

    const task = await source.fetch(shortcutEvent);

    expect(task).toEqual({ title: 'Fix the parser', body: 'It crashes on empty input.' });
    expect(requests).toEqual([{ token: 'tok_read_workspace', storyId: '778899' }]);
    expect(fb.calls).toHaveLength(0); // shortcut path did not delegate
  });

  it('maps a null description to an empty body and an empty name to the story id', async () => {
    const adapter: ShortcutStoryReader = {
      async fetchStory() {
        return { name: '', description: null };
      },
    };
    const source = makeShortcutContentSource({
      store: fakeStore({ orgId: ORG_ID, repoRef: null }),
      resolver: fakeResolver('tok'),
      adapter,
      fallback: recordingFallback().source,
    });

    const task = await source.fetch(shortcutEvent);

    expect(task).toEqual({ title: shortcutEvent.externalStoryId, body: '' });
  });

  it('delegates a non-shortcut event to the fallback', async () => {
    const fb = recordingFallback();
    const source = makeShortcutContentSource({
      store: fakeStore({ orgId: ORG_ID, repoRef: null }),
      resolver: fakeResolver('tok'),
      adapter: neverFetchAdapter(),
      fallback: fb.source,
    });
    const githubEvent: AdapterEvent = {
      type: 'task.assigned',
      platform: 'github',
      externalStoryId: 'acme/widgets#1',
      agentExternalId: 'a',
    };
    await source.fetch(githubEvent);
    expect(fb.calls).toEqual([githubEvent]);
  });

  it('delegates a shortcut event with no stamped connection id to the fallback (redrive-safe)', async () => {
    const fb = recordingFallback();
    const source = makeShortcutContentSource({
      store: fakeStore({ orgId: ORG_ID, repoRef: null }),
      resolver: fakeResolver('tok'),
      adapter: neverFetchAdapter(),
      fallback: fb.source,
    });
    const unstamped: AdapterEvent = { ...shortcutEvent, shortcutConnectionId: undefined };
    await source.fetch(unstamped);
    expect(fb.calls).toEqual([unstamped]);
  });

  it('falls back when no live connection resolves for the id', async () => {
    const fb = recordingFallback();
    const source = makeShortcutContentSource({
      store: fakeStore(null), // revoked / unknown
      resolver: fakeResolver('tok'),
      adapter: neverFetchAdapter(),
      fallback: fb.source,
    });
    await source.fetch(shortcutEvent);
    expect(fb.calls).toEqual([shortcutEvent]);
  });

  it('falls back + logs when the read token is not configured (and never logs the token)', async () => {
    const logs: Array<{ msg: string; ctx: Record<string, unknown> | undefined }> = [];
    const fb = recordingFallback();
    const source = makeShortcutContentSource({
      store: fakeStore({ orgId: ORG_ID, repoRef: null }),
      resolver: fakeResolver(null), // no read token sealed for this connection
      adapter: neverFetchAdapter(),
      fallback: fb.source,
      logger: {
        error: (msg, ctx) => logs.push({ msg, ctx }),
        info: (msg, ctx) => logs.push({ msg, ctx }),
      },
    });

    const task = await source.fetch(shortcutEvent);

    expect(task).toEqual({ title: shortcutEvent.externalStoryId, body: '' }); // stub fallback
    expect(fb.calls).toEqual([shortcutEvent]);
    expect(logs.some((l) => /read token not configured/.test(l.msg))).toBe(true);
    // The token is null here, but assert no log line carries a token-shaped value regardless.
    for (const l of logs) {
      expect(JSON.stringify(l.ctx ?? {})).not.toMatch(/tok_/);
    }
  });

  it('falls back + logs when the story fetch fails (a READ must not crash orchestration)', async () => {
    const logs: string[] = [];
    const fb = recordingFallback();
    const adapter: ShortcutStoryReader = {
      async fetchStory() {
        throw new Error('shortcut fetchStory failed: 500 Internal Server Error');
      },
    };
    const source = makeShortcutContentSource({
      store: fakeStore({ orgId: ORG_ID, repoRef: null }),
      resolver: fakeResolver('tok_read_workspace'),
      adapter,
      fallback: fb.source,
      logger: {
        error: (msg) => logs.push(msg),
        info: (msg) => logs.push(msg),
      },
    });

    const task = await source.fetch(shortcutEvent);

    expect(task).toEqual({ title: shortcutEvent.externalStoryId, body: '' }); // stub fallback
    expect(fb.calls).toEqual([shortcutEvent]);
    expect(logs.some((m) => /story fetch failed/.test(m))).toBe(true);
  });
});
