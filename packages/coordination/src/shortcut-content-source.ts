// A TaskContentSource that fetches the real story title/body for a Shortcut event
// (so the agent prompt is the actual story, not just the id). Reads via the
// connection's workspace READ token, resolved from the connection vault by the
// event's stamped `shortcutConnectionId` (slice SC-1/SC-2). Non-shortcut events,
// an unstamped event, a missing connection, an absent read token, or ANY fetch
// failure all delegate to `fallback` — content fetch is a READ, so it degrades to
// the stub rather than crashing orchestration. The token is NEVER logged.

import type { TaskInput } from '@tasca/routing';
import type { AdapterEvent } from '@tasca/contracts';
import type { TaskContentSource } from './orchestrate';
import type { CoordinationStore } from './store';
import type { ConnectionCredentialResolver } from './vendor-credential';
import type { Logger } from './ports';

/** The slice of the Shortcut adapter this source needs (story read). */
export interface ShortcutStoryReader {
  fetchStory(input: { token: string; storyId: string }): Promise<{ name: string; description: string | null }>;
}

/**
 * Build a TaskContentSource that fetches the real story content for shortcut
 * events and delegates everything else (and every degraded path) to `fallback`.
 */
export function makeShortcutContentSource(deps: {
  store: Pick<CoordinationStore, 'getShortcutConnectionById'>;
  resolver: Pick<ConnectionCredentialResolver, 'resolve'>;
  adapter: ShortcutStoryReader;
  fallback: TaskContentSource;
  logger?: Logger;
}): TaskContentSource {
  return {
    async fetch(event: AdapterEvent): Promise<TaskInput> {
      // Non-shortcut, or a shortcut event with no stamped connection id (e.g. the legacy env-secret route,
      // or a re-driven task reconstructed without it) → fall back to the stub (safe/degraded).
      if (event.platform !== 'shortcut' || !event.shortcutConnectionId) {
        return deps.fallback.fetch(event);
      }
      const connectionId = event.shortcutConnectionId;

      const conn = await deps.store.getShortcutConnectionById(connectionId);
      if (!conn) {
        // Unknown / revoked connection — can't resolve a token. Degrade to the stub.
        deps.logger?.info?.('shortcut content: no live connection for id — using fallback', {
          externalStoryId: event.externalStoryId,
        });
        return deps.fallback.fetch(event);
      }

      const token = await deps.resolver.resolve(conn.orgId, connectionId, 'read_token');
      if (!token) {
        // The connection has no read token configured (or no master key) — degrade to the stub. A clear
        // signal so the gap is actionable; the TOKEN is never logged.
        deps.logger?.info?.('shortcut content: read token not configured for connection — using fallback', {
          externalStoryId: event.externalStoryId,
        });
        return deps.fallback.fetch(event);
      }

      try {
        const story = await deps.adapter.fetchStory({ token, storyId: event.externalStoryId });
        return {
          title: story.name || event.externalStoryId,
          body: story.description ?? '',
        };
      } catch (err) {
        // A READ failure must not crash orchestration — degrade to the stub. NEVER log the token.
        deps.logger?.info?.('shortcut content: story fetch failed — using fallback', {
          externalStoryId: event.externalStoryId,
          err: err instanceof Error ? err.message : String(err),
        });
        return deps.fallback.fetch(event);
      }
    },
  };
}
