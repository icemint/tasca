// Icon set + brand mark — ported verbatim from the design system (marketing/site.js).
// Raw SVG strings, rendered via Astro `set:html`. currentColor inherits from context.

export const MARK = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect x="3.5" y="11.8" width="8.8" height="8.8" rx="2.5" fill="var(--signal)"/>
  <path d="M12.3 16.2H16.4M16.4 8.5V23.9M16.4 8.5H20M16.4 16.2H20M16.4 23.9H20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  <circle cx="22.6" cy="8.5" r="2.6" fill="currentColor"/><circle cx="22.6" cy="16.2" r="2.6" fill="currentColor"/><circle cx="22.6" cy="23.9" r="2.6" fill="currentColor"/></svg>`;

// Vendor glyphs — neutral by construction (no brand color dominates).
export const VG: Record<string, string> = {
  claude: '<svg viewBox="0 0 11 11"><path d="M5.5 1 10 5.5 5.5 10 1 5.5Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  openai: '<svg viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/></svg>',
  local:  '<svg viewBox="0 0 11 11"><rect x="1.4" y="1.7" width="8.2" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.3 4.1 4.7 5.5 3.3 6.9M5.8 6.9H7.7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
};

export const I: Record<string, string> = {
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M8 4l4 4-4 4"/></svg>',
  plug: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 01-10 0V7ZM10 14v3"/></svg>',
  route: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4.5" cy="10" r="2.4"/><circle cx="15.5" cy="4.5" r="2.4"/><circle cx="15.5" cy="15.5" r="2.4"/><path d="M6.6 8.9l6.8-3.4M6.6 11.1l6.8 3.4" stroke-linecap="round"/></svg>',
  roster: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
  shield: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.5l6 2.2v4.6c0 4-2.7 6.6-6 8-3.3-1.4-6-4-6-8V4.7l6-2.2Z"/><path d="M7.4 10l1.8 1.8 3.6-3.6" stroke-linecap="round"/></svg>',
  id: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><circle cx="7" cy="9.5" r="1.8"/><path d="M4.6 13.4c.5-1.3 1.4-2 2.4-2s1.9.7 2.4 2M12 8.5h4M12 11.5h3" stroke-linecap="round"/></svg>',
  audit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 3h7l3 3v11H5zM12 3v3h3"/><path d="M7.5 10h5M7.5 13h3"/></svg>',
  lock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4.5" y="9" width="11" height="7" rx="1.8"/><path d="M7 9V6.8a3 3 0 016 0V9" stroke-linecap="round"/></svg>',
  git: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="5" r="2"/><circle cx="5" cy="15" r="2"/><circle cx="15" cy="15" r="2"/><path d="M5 7v6M15 13V11a3 3 0 00-3-3H8" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 5"/></svg>',
  spark: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6Z"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v3.5M8 5.2v.2" stroke-linecap="round"/></svg>',
  layers: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.5l7 3.5-7 3.5-7-3.5 7-3.5ZM3 10l7 3.5L17 10M3 13.5L10 17l7-3.5"/></svg>',
};

// App handoff target (CTAs). The marketing site never hosts auth itself.
export const APP_URL = 'https://app.tasca.dev';
