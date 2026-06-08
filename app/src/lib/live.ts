// Live optimistic controls. The contract for the first UI writes: a control gives
// immediate feedback, then ALWAYS reconciles to server truth — it never leaves the
// UI lying. On any non-ok outcome it re-renders from the server (snap back to truth)
// and surfaces a human reason; a lost optimistic race (409) reconciles VISIBLY (the
// agent's true state re-renders + a banner), never a silent overwrite.

import { redirectToLogin, type WriteResult } from './api';
import { esc } from './ui';

/** Show (replacing any prior) a banner at the top of a view. */
export function showBanner(view: HTMLElement, message: string, tone: 'error' | 'info' = 'error'): void {
  clearBanner(view);
  const b = document.createElement('div');
  b.className = `write-banner ${tone}`;
  b.setAttribute('role', 'status');
  b.innerHTML = `<span>${esc(message)}</span><button type="button" class="wb-x" aria-label="Dismiss">✕</button>`;
  b.querySelector('.wb-x')!.addEventListener('click', () => b.remove());
  view.prepend(b);
}

export function clearBanner(view: HTMLElement): void {
  // Direct children only (the top-level banner) — avoid `:scope` for happy-dom parity.
  for (const child of Array.from(view.children)) {
    if (child.classList.contains('write-banner')) child.remove();
  }
}

/** A human, honest reason for a failed write — what happened + that truth is shown. */
export function describeFailure(r: WriteResult<unknown>): string {
  switch (r.kind) {
    case 'conflict':
      return 'Someone else changed this agent — showing the latest. Review and try again.';
    case 'forbidden':
      return 'Your session’s security token expired. Showing the latest — please retry.';
    case 'unconfigured':
      return 'Agent actions aren’t enabled on this workspace yet.';
    case 'notfound':
      return 'This agent no longer exists.';
    case 'error':
      return `Couldn’t apply the change (${r.message}). Showing the latest.`;
    default:
      return 'Couldn’t apply the change. Showing the latest.';
  }
}

export interface LiveActionOpts<T> {
  /** The clicked control — disabled + shown pending while in flight. */
  button: HTMLButtonElement;
  /** Label shown on the button while the write is in flight. */
  pendingLabel: string;
  /** The view root: where the banner is shown and what `rerun` re-renders. */
  view: HTMLElement;
  /** Re-fetch + re-render the view from server truth (mount's run). */
  rerun: () => Promise<void>;
  /** Perform the write. */
  write: () => Promise<WriteResult<T>>;
  /** Map a failure to a human reason (defaults to describeFailure). */
  describe?: (r: WriteResult<T>) => string;
}

/**
 * Run a live write with truthful reconciliation:
 *  - immediate pending feedback on the button (optimistic affordance);
 *  - 401 → redirect to login;
 *  - on EVERY other outcome, re-render from server truth (`rerun`) so the UI cannot
 *    lie — the optimistic/pending DOM is replaced by reality;
 *  - on failure, surface a banner explaining what happened (a 409 reconciles the
 *    true state visibly rather than overwriting it).
 */
export async function liveAction<T>(opts: LiveActionOpts<T>): Promise<void> {
  const { button } = opts;
  if (button.dataset.busy === '1') return; // ignore re-clicks while in flight
  button.dataset.busy = '1';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = opts.pendingLabel;

  let result: WriteResult<T>;
  try {
    result = await opts.write();
  } catch {
    result = { kind: 'error', message: 'Unexpected error' };
  }

  if (result.kind === 'unauth') {
    redirectToLogin();
    return;
  }

  // Reconcile to truth on every outcome (the button + optimistic DOM are discarded
  // by the re-render, so there is nothing stale to roll back by hand).
  await opts.rerun();
  if (result.kind !== 'ok') {
    showBanner(opts.view, (opts.describe ?? describeFailure)(result));
  }
}
