import type { PullRequest } from 'shared/remote-types';
import { PrCard } from './PrCard';

/**
 * Multi-PR list. Renders only live rows; with none linked it shows an empty
 * state (never a seeded/sample row).
 */
export function PrCardList({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (pullRequests.length === 0) {
    return (
      <p className="rounded-sm border border-dashed border-line bg-surface px-3 py-2 text-xs text-fg-3">
        No pull requests linked yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {pullRequests.map((pr) => (
        <li key={pr.id}>
          <PrCard pr={pr} />
        </li>
      ))}
    </ul>
  );
}
