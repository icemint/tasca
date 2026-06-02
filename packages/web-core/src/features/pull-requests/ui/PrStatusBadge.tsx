import type { PullRequestStatus } from 'shared/remote-types';
import { cn } from '@/shared/lib/utils';

/**
 * Token-driven status pill for a pull request. Colors come from the design-token
 * bridge `review` family (open/merged) with a muted token for closed.
 */
const STATUS_META: Record<
  PullRequestStatus,
  { label: string; dot: string }
> = {
  open: { label: 'Open', dot: 'bg-review-open' },
  merged: { label: 'Merged', dot: 'bg-review-merged' },
  closed: { label: 'Closed', dot: 'bg-fg-3' },
};

export function PrStatusBadge({ status }: { status: PullRequestStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg-2">
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)}
      />
      {meta.label}
    </span>
  );
}
