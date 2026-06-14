// A TaskContentSource that fetches the real issue title/body/labels for a GitHub
// event (so the agent prompt is the actual story, not just the id). Non-github
// events delegate to a fallback source. Reads via the GitHub App installation
// token resolved from the event's owner.

import type { TaskInput } from '@tasca/routing';
import type { TaskAssignedEvent } from '@tasca/contracts';
import type { TaskContentSource } from './orchestrate';

/** GitHub `owner/repo#number` external story id. */
const STORY_ID_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/** The slice of the GitHub App client this source needs (issues read). */
interface AppClient {
  getInstallationToken(id: string): Promise<{ token: string }>;
  request(token: string, method: string, path: string): Promise<unknown>;
}

/** The issue shape we read off the REST response (only the fields we map). */
interface GitHubIssue {
  title?: string;
  body?: string | null;
  labels?: Array<{ name?: string } | string>;
}

/**
 * Build a TaskContentSource that fetches the real issue content for github
 * events and delegates everything else to `fallback`.
 */
export function makeGitHubContentSource(deps: {
  appClient: AppClient;
  getInstallationIdForOwner(owner: string): Promise<string | null>;
  fallback: TaskContentSource;
}): TaskContentSource {
  return {
    async fetch(event: TaskAssignedEvent): Promise<TaskInput> {
      if (event.platform !== 'github') {
        return deps.fallback.fetch(event);
      }

      const match = STORY_ID_RE.exec(event.externalStoryId);
      if (!match) {
        throw new Error('github content: unparseable externalStoryId ' + event.externalStoryId);
      }
      const [, owner, repo, number] = match;

      const installationId = await deps.getInstallationIdForOwner(owner!);
      if (!installationId) {
        throw new Error('github content: no installation for owner ' + owner);
      }

      const { token } = await deps.appClient.getInstallationToken(installationId);
      const issue = (await deps.appClient.request(
        token,
        'GET',
        `/repos/${owner}/${repo}/issues/${number}`
      )) as GitHubIssue;

      return {
        title: issue.title ?? event.externalStoryId,
        body: issue.body ?? '',
        labels: (issue.labels ?? [])
          .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
          .filter(Boolean),
      };
    },
  };
}
