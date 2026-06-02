/**
 * Tasca app (remote-web) Tailwind config.
 *
 * Intentionally minimal: the shared entry stylesheet
 * (web-core/src/app/styles/new/index.css) pins
 * `@config '../local-web/tailwind.new.config.js'`, which Tailwind v3 uses as the
 * authoritative config for the compiled CSS of BOTH apps. The design-token bridge
 * families (signal/amber/tier/exec/review/surface/fg/line) therefore live in that
 * config; defining them here too would be inert (and risk drift).
 */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
    "../web-core/src/**/*.{js,jsx,ts,tsx}",
  ],
};
