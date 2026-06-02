/**
 * Tasca app (remote-web) Tailwind config.
 * Color utilities resolve from the design-token bridge
 * (web-core/src/app/styles/new/tokens-bridge.css). Every bridge token is a full
 * CSS color (solid = `hsl(...)`, lines = `rgba(...)`), so all consume as var(--x)
 * — the same way the vendored/ported design-system CSS uses them.
 * Theme is the app's existing `.dark` class (light = :root default).
 */
const hsl = (v) => `var(--${v})`;

module.exports = {
  darkMode: ["class", ".dark"],
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
    "../web-core/src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // surfaces + lines + foreground ramp
        bg: hsl("bg"),
        "bg-sub": hsl("bg-sub"),
        surface: hsl("surface"),
        "surface-2": hsl("surface-2"),
        "surface-3": hsl("surface-3"),
        line: "var(--line)",
        "line-2": "var(--line-2)",
        "line-3": "var(--line-3)",
        fg: hsl("fg"),
        "fg-2": hsl("fg-2"),
        "fg-3": hsl("fg-3"),
        "fg-4": hsl("fg-4"),
        "fg-faint": hsl("fg-faint"),
        // brand
        signal: hsl("signal"),
        "signal-2": hsl("signal-2"),
        "signal-3": hsl("signal-3"),
        "signal-dim": hsl("signal-dim"),
        amber: hsl("amber"),
        "amber-2": hsl("amber-2"),
        "amber-deep": hsl("amber-deep"),
        "on-amber": hsl("on-amber"),
        "on-signal": hsl("on-signal"),
        // status
        green: hsl("green"),
        red: hsl("red"),
        purple: hsl("purple"),
        violet: hsl("violet"),
        // tier scale
        tier: {
          basic: hsl("t-basic"),
          low: hsl("t-low"),
          medium: hsl("t-medium"),
          hard: hsl("t-hard"),
          ultra: hsl("t-ultra"),
        },
        // agent execution states
        exec: {
          idle: hsl("exec-idle"),
          running: hsl("exec-running"),
          pending: hsl("exec-pending"),
          failed: hsl("exec-failed"),
          denied: hsl("exec-denied"),
        },
        // PR/review states
        review: {
          draft: hsl("review-draft"),
          open: hsl("review-open"),
          approved: hsl("review-approved"),
          changes: hsl("review-changes"),
          merged: hsl("review-merged"),
        },
      },
    },
  },
};
