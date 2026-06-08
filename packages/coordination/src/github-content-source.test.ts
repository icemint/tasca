import { describe, it, expect } from 'vitest';
import type { AdapterEvent } from '@tasca/contracts';
import { makeGitHubContentSource } from './github-content-source';
import type { TaskContentSource } from './orchestrate';

const githubEvent: AdapterEvent = {
  type: 'task.assigned',
  platform: 'github',
  externalStoryId: 'acme/widgets#42',
  agentExternalId: '5550001',
  repoHint: 'acme/widgets',
};

/** A fallback that records whether it was hit. */
function recordingFallback(): { source: TaskContentSource; calls: AdapterEvent[] } {
  const calls: AdapterEvent[] = [];
  return {
    calls,
    source: {
      async fetch(event) {
        calls.push(event);
        return { title: 'fallback', body: '' };
      },
    },
  };
}

describe('makeGitHubContentSource', () => {
  it('fetches the real issue content and maps it to a TaskInput', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    const appClient = {
      async getInstallationToken(id: string) {
        expect(id).toBe('inst-1');
        return { token: 'tok-xyz' };
      },
      async request(token: string, method: string, path: string) {
        expect(token).toBe('tok-xyz');
        requests.push({ method, path });
        return {
          title: 'Fix the parser',
          body: 'It crashes on empty input.',
          labels: [{ name: 'bug' }, 'urgent', { name: '' }],
        };
      },
    };
    const fb = recordingFallback();
    const source = makeGitHubContentSource({
      appClient,
      getInstallationIdForOwner: async (owner) => (owner === 'acme' ? 'inst-1' : null),
      fallback: fb.source,
    });

    const task = await source.fetch(githubEvent);

    expect(task).toEqual({
      title: 'Fix the parser',
      body: 'It crashes on empty input.',
      labels: ['bug', 'urgent'], // empty label name dropped
    });
    expect(requests).toEqual([{ method: 'GET', path: '/repos/acme/widgets/issues/42' }]);
    expect(fb.calls).toHaveLength(0); // github path did not delegate
  });

  it('tolerates a null body / missing title / missing labels (empty issue)', async () => {
    const appClient = {
      async getInstallationToken() {
        return { token: 'tok-xyz' };
      },
      async request() {
        return { body: null }; // no title, null body (GitHub allows), no labels
      },
    };
    const source = makeGitHubContentSource({
      appClient,
      getInstallationIdForOwner: async () => 'inst-1',
      fallback: recordingFallback().source,
    });

    const task = await source.fetch(githubEvent);

    expect(task).toEqual({
      title: githubEvent.externalStoryId, // title falls back to the story id
      body: '', // null body → ''
      labels: [],
    });
  });

  it('delegates a non-github event to the fallback', async () => {
    const fb = recordingFallback();
    const appClient = {
      async getInstallationToken() {
        throw new Error('must not be called');
      },
      async request() {
        throw new Error('must not be called');
      },
    };
    const source = makeGitHubContentSource({
      appClient,
      getInstallationIdForOwner: async () => 'inst-1',
      fallback: fb.source,
    });

    const shortcutEvent: AdapterEvent = {
      type: 'task.assigned',
      platform: 'shortcut',
      externalStoryId: 'sc-1',
      agentExternalId: 'a',
    };
    const task = await source.fetch(shortcutEvent);
    expect(task.title).toBe('fallback');
    expect(fb.calls).toEqual([shortcutEvent]);
  });

  it('throws on an unparseable externalStoryId', async () => {
    const fb = recordingFallback();
    const source = makeGitHubContentSource({
      appClient: {
        async getInstallationToken() {
          throw new Error('unreached');
        },
        async request() {
          throw new Error('unreached');
        },
      },
      getInstallationIdForOwner: async () => 'inst-1',
      fallback: fb.source,
    });
    await expect(
      source.fetch({ ...githubEvent, externalStoryId: 'not-a-valid-id' })
    ).rejects.toThrow(/unparseable externalStoryId/);
  });

  it('throws when no installation exists for the owner', async () => {
    const fb = recordingFallback();
    const source = makeGitHubContentSource({
      appClient: {
        async getInstallationToken() {
          throw new Error('unreached');
        },
        async request() {
          throw new Error('unreached');
        },
      },
      getInstallationIdForOwner: async () => null,
      fallback: fb.source,
    });
    await expect(source.fetch(githubEvent)).rejects.toThrow(/no installation for owner acme/);
  });
});
