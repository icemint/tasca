import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import type { PullRequest } from 'shared/remote-types';
import { PrStatusBadge } from './PrStatusBadge';

/**
 * One linked pull request. Renders live PR fields (from the `pull_requests`
 * Electric shape) — there is no fabricated/sample content here; the list that
 * renders these is empty until the M4 webhook linker populates the shape.
 */
export function PrCard({ pr }: { pr: PullRequest }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Pull request #${pr.number} (${pr.status}) — opens on the host`}
      className="group flex items-center gap-2 rounded-sm border border-line bg-surface px-3 py-2 transition-colors hover:border-signal hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      <span className="font-mono text-sm font-medium text-fg">
        #{pr.number}
      </span>
      <PrStatusBadge status={pr.status} />
      <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
        {pr.target_branch_name}
      </span>
      <ArrowSquareOutIcon
        size={14}
        aria-hidden
        className="shrink-0 text-fg-3 group-hover:text-signal"
      />
    </a>
  );
}
