import { PlusIcon } from '@phosphor-icons/react';
import { useFlag } from '@/shared/flags';
import { PrCardList } from './PrCardList';
import { PrLinkModal } from './PrLinkModal';

/**
 * Issue-drawer "Pull requests" section — SCAFFOLD (flag.github_pr, off by
 * default). When the flag is off it renders nothing (removed from the DOM).
 *
 * The linked-PR list is sourced from the live `pull_requests` Electric shape,
 * which stays empty until the M4 webhook linker populates it — so this shows the
 * empty state today and never seeds sample rows. The "Link" affordance opens the
 * stub modal; no GitHub API call or mutation happens ahead of M4.
 */
export function IssuePrLinkSection(_props: { issueId: string }) {
  const enabled = useFlag('github_pr');
  if (!enabled) {
    return null;
  }

  return (
    <section className="space-y-2" aria-label="Pull requests">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">
          Pull requests
        </h3>
        <button
          type="button"
          onClick={() => void PrLinkModal.show()}
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium text-fg-3 transition-colors hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          <PlusIcon size={12} aria-hidden />
          Link
        </button>
      </div>
      <PrCardList pullRequests={[]} />
    </section>
  );
}
