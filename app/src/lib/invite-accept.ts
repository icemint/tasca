// Accept-page flow logic (slice 3.5-B.3.2), factored out of invite.astro so it is unit-testable
// without a real DOM/network. The page's inline script is a thin adapter that calls runAcceptFlow
// with concrete dependencies; this module owns the decision tree:
//
//   no token         → 'invalid'  (a clean "this link is invalid" card)
//   authed + ok      → 'accepted' (brief success, then redirect to APP_HOME)
//   authed + 409     → 'invalid'  (generic "invalid or already used")
//   authed + other   → 'failed'   (a generic failure + retry)
//   not authenticated→ 'signin'   (store the token, render the sign-in card)
//
// Accept is POSSESSION-based: any logged-in identity may accept — the invite email need NOT match.
// The raw token only ever lives in the URL + sessionStorage (transiently); it is never rendered.

import type { ApiResult, WriteResult } from './api';
import type { SessionResponse } from './contract';

/** The pending-invite sessionStorage key — read by the post-login consume hook (invite-consume). */
export const PENDING_INVITE_KEY = 'tasca_pending_invite';

/** The flow's terminal states — an explicit enum the page maps to a rendered card. */
export type AcceptOutcome = 'invalid' | 'accepted' | 'failed' | 'signin';

export interface AcceptDeps {
  /** The raw token from the URL (`?token=…`), or null when absent. */
  token: string | null;
  /** Resolve the current session. */
  getSession: () => Promise<ApiResult<SessionResponse>>;
  /** Accept the invite by its single-use token. */
  acceptInvite: (token: string) => Promise<WriteResult<{ ok: true; orgId: string; role: string } | { error: string }>>;
  /** Persist the token for the post-login consume hook (sessionStorage in production). */
  storePendingToken: (token: string) => void;
  /** Redirect into the app after a successful accept. */
  redirectHome: () => void;
}

/**
 * Run the accept flow and return the terminal outcome. A logged-out visitor has their token stored
 * for the post-login consume hook (NOT auto-redirected — they click sign in). An authenticated
 * visitor's invite is accepted in place; a used/invalid token (409) is reported generically.
 */
export async function runAcceptFlow(deps: AcceptDeps): Promise<AcceptOutcome> {
  const { token } = deps;
  if (!token) return 'invalid';

  const session = await deps.getSession();
  // Treat any non-authenticated session resolution (unauth, error, or {authenticated:false}) as
  // "sign in to accept" — store the token so the consume hook finishes the job after OAuth.
  const authed = session.kind === 'ok' && session.data.authenticated === true;
  if (!authed) {
    deps.storePendingToken(token);
    return 'signin';
  }

  const res = await deps.acceptInvite(token);
  if (res.kind === 'ok') {
    deps.redirectHome();
    return 'accepted';
  }
  // A used/invalid token is a 409 conflict (generic by design — the server never reveals which).
  if (res.kind === 'conflict') return 'invalid';
  // 401 is unlikely here (we just confirmed a session) but maps to the same generic-invalid card;
  // any other failure is a retryable generic failure.
  if (res.kind === 'unauth') return 'invalid';
  return 'failed';
}
