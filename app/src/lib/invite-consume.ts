// Post-login invite consume hook (slice 3.5-B.3.2). After OAuth a not-logged-in invitee lands at
// APP_HOME (/roster, an AppShell page) with their token stashed in sessionStorage by the accept
// page. This bootstrap finishes the job: if a pending token is present, it is removed FIRST (so the
// hook runs at most once and the raw token never lingers) and the invite is accepted in the
// background. A success shows a brief non-blocking notice; a failure shows a quiet one — never
// blocking the page, never throwing out of the bootstrap (the user is already logged in on /roster).

import { acceptInvite } from './api';
import { PENDING_INVITE_KEY } from './invite-accept';
import { esc } from './ui';

/** A minimal, dismissible top-of-page notice (the app has no global toast yet). Token-only styles. */
function showNotice(message: string, tone: 'ok' | 'quiet'): void {
  const host = document.getElementById('main') ?? document.body;
  const n = document.createElement('div');
  n.className = `invite-notice ${tone}`;
  n.setAttribute('role', 'status');
  n.innerHTML = `<span>${esc(message)}</span><button type="button" class="in-x" aria-label="Dismiss">✕</button>`;
  n.querySelector('.in-x')!.addEventListener('click', () => n.remove());
  host.prepend(n);
}

/**
 * Consume a pending invite token, if one is present. Idempotent + at-most-once: the token is read
 * and removed before any await, so a second invocation (or a re-render) is a no-op. Never throws.
 */
export async function consumePendingInvite(): Promise<void> {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (token) sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    // sessionStorage unavailable (private mode / disabled) — nothing pending to consume.
    return;
  }
  if (!token) return; // no-op when nothing is pending

  try {
    const res = await acceptInvite(token);
    if (res.kind === 'ok') {
      const org = (res.data as { orgId?: string }).orgId;
      showNotice(org ? `You’ve joined ${org}.` : 'You’ve joined the workspace.', 'ok');
    } else {
      // A used/invalid token, or any other failure — a quiet notice. Don't trap the user; they're
      // already logged in and on /roster.
      showNotice('That invite link was invalid or already used.', 'quiet');
    }
  } catch {
    // Never throw out of the bootstrap — a network blip here must not break the page.
    showNotice('That invite link was invalid or already used.', 'quiet');
  }
}
