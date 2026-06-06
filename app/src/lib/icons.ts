// Brand mark + auth glyphs — ported verbatim from the design system (app/ui.js + onboarding.js).
export const MARK = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="3.5" y="11.8" width="8.8" height="8.8" rx="2.5" fill="var(--signal)"/>
  <path d="M12.3 16.2H16.4M16.4 8.5V23.9M16.4 8.5H20M16.4 16.2H20M16.4 23.9H20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <circle cx="22.6" cy="8.5" r="2.6" fill="currentColor"/><circle cx="22.6" cy="16.2" r="2.6" fill="currentColor"/><circle cx="22.6" cy="23.9" r="2.6" fill="currentColor"/></svg>`;

export const GITHUB = '<svg viewBox="0 0 18 18" fill="currentColor"><path d="M9 1.5a7.5 7.5 0 00-2.37 14.62c.37.07.5-.16.5-.36v-1.3c-2.08.45-2.52-.88-2.52-.88-.34-.87-.83-1.1-.83-1.1-.68-.46.05-.45.05-.45.75.05 1.14.77 1.14.77.67 1.14 1.75.81 2.18.62.07-.48.26-.81.47-1-1.66-.19-3.4-.83-3.4-3.7 0-.82.29-1.48.77-2-.08-.19-.34-.95.07-1.98 0 0 .63-.2 2.06.76a7.2 7.2 0 013.75 0c1.43-.96 2.06-.76 2.06-.76.41 1.03.15 1.79.07 1.98.48.52.77 1.18.77 2 0 2.87-1.75 3.5-3.42 3.69.27.23.5.69.5 1.39v2.06c0 .2.14.43.51.36A7.5 7.5 0 009 1.5Z"/></svg>';

export const GOOGLE = '<svg viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.92v2.34A9 9 0 009 18Z"/><path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 010-3.44V4.94H.92a9 9 0 000 8.12l3.06-2.34Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 00.92 4.94l3.06 2.34C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>';

// ── UI glyphs — ported verbatim from the design system (app/ui.js `I`). ───────
export const I = {
  search:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>',
  bell:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 6a3 3 0 016 0c0 3 1.2 4 1.2 4H3.8S5 9 5 6Z" stroke-linejoin="round"/><path d="M6.6 13a1.6 1.6 0 002.8 0" stroke-linecap="round"/></svg>',
  plus:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>',
  kebab:'<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="12.5" r="1.4"/></svg>',
  roster:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
  monitor:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11h3l2-6 3 12 2-7 1.5 4H18"/></svg>',
  plug:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 01-10 0V7ZM10 14v3"/></svg>',
  gear:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg>',
  spark:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6Z"/></svg>',
  grid:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
  rows:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
  back:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L4 8l5 5"/></svg>',
  arrow:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M8 4l4 4-4 4"/></svg>',
  pause:'<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>',
  pr:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M4 6v4M12 10V8a2 2 0 00-2-2H7" stroke-linecap="round"/></svg>',
  empty:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="5" width="7" height="7" rx="1.5"/><rect x="13" y="5" width="7" height="7" rx="1.5"/><rect x="4" y="14" width="7" height="6" rx="1.5" stroke-dasharray="2 2"/><rect x="13" y="14" width="7" height="6" rx="1.5" stroke-dasharray="2 2"/></svg>',
  chevron:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
} as const;

// ── Agent-state glyphs — ported verbatim from app/ui.js `SG` (shape, not hue). ─
export const SG = {
  idle:'<svg class="g" viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="3.7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  working:'<svg class="g" viewBox="0 0 11 11"><circle class="pulse" cx="5.5" cy="5.5" r="3.4" fill="currentColor"/></svg>',
  awaiting:'<svg class="g" viewBox="0 0 11 11"><path d="M5.5 1.2 10 9.6H1Z" fill="currentColor"/></svg>',
  blocked:'<svg class="g" viewBox="0 0 11 11"><rect x="1.4" y="1.4" width="8.2" height="8.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.4 3.4l4.2 4.2" stroke="currentColor" stroke-width="1.5"/></svg>',
  shipped:'<svg class="g" viewBox="0 0 11 11"><path d="M1.6 5.7 4.3 8.5 9.4 2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  queued:'<svg class="g" viewBox="0 0 11 11"><rect x="1.6" y="1.6" width="7.8" height="7.8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 1.8"/></svg>',
} as const;

// ── Vendor glyphs — ported verbatim from app/ui.js `VG` (shape-coded, mono). ──
export const VG = {
  claude:'<svg viewBox="0 0 11 11"><path d="M5.5 1 10 5.5 5.5 10 1 5.5Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  openai:'<svg viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/></svg>',
  local:'<svg viewBox="0 0 11 11"><rect x="1.4" y="1.7" width="8.2" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.3 4.1 4.7 5.5 3.3 6.9M5.8 6.9H7.7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
} as const;
