// Best-effort invite email via Resend (slice 3.5-B.3.1).
//
// The invite link is ALSO returned in the create response, so email is purely a convenience: when
// RESEND_API_KEY is set we POST the same accept link to Resend; when it is unset (or the send fails) we
// log the link for the operator to share manually. A send failure NEVER throws — the invite is already
// created, so a flaky email provider must not fail the request. No npm dependency: global fetch only.

import type { Logger } from './ports';

export interface InviteEmail {
  to: string;
  acceptUrl: string;
  orgName: string;
  inviterEmail: string;
}

/** Minimal, no-frills HTML body. Plain prose + the accept link; no tracking, no external assets. */
function inviteHtml(e: InviteEmail): string {
  return (
    `<p>${escapeHtml(e.inviterEmail)} invited you to join <strong>${escapeHtml(e.orgName)}</strong> on Tasca.</p>` +
    `<p><a href="${escapeHtml(e.acceptUrl)}">Accept the invite</a></p>` +
    `<p>This link is single-use and expires in 7 days.</p>`
  );
}

/** Escape the few characters that could break out of the HTML/attribute context (the org name + inviter
 *  email are operator/admin-supplied, but treat them as untrusted in the email body all the same). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Replace the raw token in an accept URL with `***` so the URL can be logged without exposing the
 *  single-use credential. The full link lives only in the create response + the outbound email. */
function redactToken(url: string): string {
  return url.replace(/token=[^&]+/, 'token=***');
}

/**
 * Send the invite link. RESEND_API_KEY present → POST to Resend (best-effort: a non-2xx or a throw is
 * logged at error and swallowed, never re-thrown). Unset → log that the send was skipped and return.
 * The RAW token (acceptUrl) is NEVER logged — not on the skip path, not on an error path — because logs
 * ship to a broader/weaker-ACL surface than the hashed-at-rest DB; the admin gets the link from the
 * create response. Only a token-REDACTED URL is ever logged.
 */
export async function sendInviteEmail(e: InviteEmail, logger?: Logger): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger?.info?.('invite email skipped — RESEND_API_KEY unset; the accept link is in the create response', {
      to: e.to,
      acceptUrl: redactToken(e.acceptUrl),
    });
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: process.env.TASCA_INVITE_FROM ?? 'Tasca <onboarding@resend.dev>',
        to: e.to,
        subject: `You're invited to ${e.orgName} on Tasca`,
        html: inviteHtml(e),
      }),
      // Bound the call so a hung provider can't stall the awaited invite-create request. The abort
      // throws into the catch below (best-effort → logged + swallowed, never re-thrown).
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Best-effort: the invite is already created (the link is also in the create response), so a bad
      // provider response is logged, not thrown. Never log the acceptUrl/token here — this is the error path.
      logger?.error('invite email send failed (Resend non-2xx)', { to: e.to, status: res.status });
    }
  } catch (err) {
    logger?.error('invite email send threw', { to: e.to, err: err instanceof Error ? err.message : String(err) });
  }
}
