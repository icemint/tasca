// Shared honest-state renderers (no fake data): loading skeletons, empty, error,
// and an unauthenticated state. Islands call these to fill their mount point
// before / instead of real data. Classes come from the vendored roster.css +
// states.css (.state-wrap, .sk-*, .empty).

import { I } from './icons';

/** A loading skeleton sized for a card grid. */
export function loading(): string {
  const card = `<div class="sk-card"><div class="sk-row"><div class="sk skel-av"></div><div style="flex:1"><div class="sk skel-line" style="width:46%"></div><div class="sk skel-line sm" style="width:30%;margin-top:8px"></div></div></div><div class="sk skel-line" style="width:80%"></div><div class="sk-row"><div class="sk skel-chip"></div><div class="sk skel-chip"></div></div></div>`;
  return `<div class="agent-grid" aria-busy="true" aria-label="Loading">${card.repeat(6)}</div>`;
}

/** A generic empty state with an icon, title and supporting text. */
export function empty(title: string, text: string, icon: string = I.empty): string {
  return `<div class="state-wrap empty-pane"><div class="state-ico">${icon}</div><h2>${escapeText(title)}</h2><p>${escapeText(text)}</p></div>`;
}

/** An error state with an optional retry button (wired by the island). */
export function error(message: string): string {
  return `<div class="state-wrap empty-pane"><div class="state-ico err">${I.bell}</div><h2>Something went wrong</h2><p>${escapeText(message)}</p><div class="state-actions"><button class="btn-add" data-act="retry">Try again</button></div></div>`;
}

/** Unauthenticated — shown briefly before the redirect to the login page. */
export function unauth(): string {
  return `<div class="state-wrap empty-pane"><div class="state-ico">${I.roster}</div><h2>Sign in to continue</h2><p>Your session has ended. Redirecting you to sign in…</p></div>`;
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
