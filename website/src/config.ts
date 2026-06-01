// Single source of truth for outbound destinations from the marketing site.
// The marketing site (tasca.dev) never performs auth itself — it hands off to
// the app SPA (app.tasca.dev), which owns the OAuth + SPAKE2 handoff.

/** The Tasca application (SPA + API). Login/CTA buttons hand off here. */
export const APP_URL = 'https://app.tasca.dev';

/** Public source repository (Apache-2.0 core). */
export const GITHUB_URL = 'https://github.com/icemint/tasca';

/**
 * Deep-link into the app's sign-in, optionally hinting a provider so the SPA can
 * auto-start that flow. The app falls back to its own provider chooser if it
 * doesn't recognize the hint.
 */
export const appSignInUrl = (provider?: 'github' | 'google') =>
  provider ? `${APP_URL}/login?provider=${provider}` : `${APP_URL}/login`;
