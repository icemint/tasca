// Island lifecycle helper. Each page's client island calls `mount(el, load)`:
//   1. show a loading skeleton
//   2. verify the session (GET /api/auth/me) — on unauth, redirect to `/`
//   3. run `load()` → the page's data fetch + render to an HTML string
//   4. render error / empty states honestly; wire a retry button if present
//
// This centralizes the session gate and the loading/error chrome so every page
// island is a thin `load()` that returns HTML.

import { getSession, redirectToLogin, type ApiResult } from './api';
import { loading, error, unauth } from './states';

export type LoadResult =
  | { kind: 'ok'; html: string }
  | { kind: 'empty'; html: string }
  | { kind: 'unauth' }
  | { kind: 'error'; message: string };

/** Lift an ApiResult into a LoadResult, mapping ok via `render`. */
export function fromResult<T>(
  res: ApiResult<T>,
  render: (data: T) => { kind: 'ok' | 'empty'; html: string }
): LoadResult {
  if (res.kind === 'unauth') return { kind: 'unauth' };
  if (res.kind === 'error') return { kind: 'error', message: res.message };
  return render(res.data);
}

export async function mount(el: HTMLElement, load: () => Promise<LoadResult>): Promise<void> {
  const run = async () => {
    el.innerHTML = loading();

    const session = await getSession();
    if (session.kind === 'unauth') {
      el.innerHTML = unauth();
      redirectToLogin();
      return;
    }
    if (session.kind === 'error') {
      el.innerHTML = error(session.message);
      wireRetry(el, run);
      return;
    }
    if (session.data.authenticated === false) {
      el.innerHTML = unauth();
      redirectToLogin();
      return;
    }

    let result: LoadResult;
    try {
      result = await load();
    } catch (err) {
      result = { kind: 'error', message: err instanceof Error ? err.message : 'Unexpected error' };
    }

    if (result.kind === 'unauth') {
      el.innerHTML = unauth();
      redirectToLogin();
      return;
    }
    if (result.kind === 'error') {
      el.innerHTML = error(result.message);
      wireRetry(el, run);
      return;
    }
    el.innerHTML = result.html;
    // Empty and ok both render their html; callers wire any in-content actions.
  };

  await run();
}

function wireRetry(el: HTMLElement, run: () => Promise<void>): void {
  const btn = el.querySelector<HTMLButtonElement>('[data-act="retry"]');
  if (btn) btn.addEventListener('click', () => void run());
}

/** Read the `?id=` query param (used by the detail pages). */
export function queryId(): string | null {
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('id');
}
