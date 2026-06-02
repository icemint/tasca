/** @type {import('tailwindcss').Config} */

const sizes = {
  '2xs': 0.5,
  xs: 0.75,
  sm: 0.875,
  base: 1,
  lg: 1.125,
  xl: 1.25,
}

const lineHeightMultiplier = 1.5;
const radiusMultiplier = 0.25;
const iconMultiplier = 1.25;
const chatMaxWidth = '48rem';

function getSize(sizeLabel, multiplier = 1) {

  return sizes[sizeLabel] * multiplier + "rem";
}

// Tasca design-token bridge families. This config is the one `@config` in
// web-core/src/app/styles/new/index.css loads for BOTH apps, so the bridge must
// live here (inlined — a cross-package require fails under this package's
// type:module + Tailwind's config loader). Tokens are full CSS colors
// (web-core/.../tokens-bridge.css), consumed as var(--x). Colors colliding with
// Tailwind's numeric scales are merged as { DEFAULT } so amber-100..900 survive.
const tv = (name) => `var(--${name})`;
const bridgeColors = {
  bg: tv('bg'), 'bg-sub': tv('bg-sub'),
  surface: tv('surface'), 'surface-2': tv('surface-2'), 'surface-3': tv('surface-3'),
  line: tv('line'), 'line-2': tv('line-2'), 'line-3': tv('line-3'),
  fg: tv('fg'), 'fg-2': tv('fg-2'), 'fg-3': tv('fg-3'), 'fg-4': tv('fg-4'), 'fg-faint': tv('fg-faint'),
  signal: tv('signal'), 'signal-2': tv('signal-2'), 'signal-3': tv('signal-3'), 'signal-dim': tv('signal-dim'),
  'on-amber': tv('on-amber'), 'on-signal': tv('on-signal'),
  amber: { DEFAULT: tv('amber'), 2: tv('amber-2'), deep: tv('amber-deep') },
  green: { DEFAULT: tv('green') }, red: { DEFAULT: tv('red') },
  purple: { DEFAULT: tv('purple') }, violet: { DEFAULT: tv('violet') },
  tier: { basic: tv('t-basic'), low: tv('t-low'), medium: tv('t-medium'), hard: tv('t-hard'), ultra: tv('t-ultra') },
  exec: { idle: tv('exec-idle'), running: tv('exec-running'), pending: tv('exec-pending'), failed: tv('exec-failed'), denied: tv('exec-denied') },
  review: { draft: tv('review-draft'), open: tv('review-open'), approved: tv('review-approved'), changes: tv('review-changes'), merged: tv('review-merged') },
};
// Always-emit a representative utility per family so the build proves the bridge
// is wired (scripts/check-app-tokens-emitted.mjs verifies these in compiled CSS).
const bridgeSafelist = [
  'bg-signal', 'text-fg-2', 'bg-surface-2', 'border-line',
  'bg-tier-low', 'bg-exec-running', 'bg-review-merged', 'text-on-amber', 'text-on-signal',
];

module.exports = {
  darkMode: ["class"],
  important: false,
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../web-core/src/**/*.{ts,tsx}',
    '../remote-web/src/**/*.{ts,tsx}',
    '../ui/src/**/*.{ts,tsx}',
    "node_modules/@rjsf/shadcn/src/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  safelist: [
    ...bridgeSafelist,
    'xl:hidden',
    'xl:relative',
    'xl:inset-auto',
    'xl:z-auto',
    'xl:h-full',
    'xl:w-[800px]',
    'xl:flex',
    'xl:flex-1',
    'xl:min-w-0',
    'xl:overflow-y-auto',
    'xl:opacity-100',
    'xl:pointer-events-auto',
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      height: {
        'cta': '29px',
      },
      minHeight: {
        'cta': '29px',
      },
      width: {
        chat: chatMaxWidth,
      },
      containers: {
        chat: chatMaxWidth,
      },
      size: {
        'icon-2xs': getSize('2xs', iconMultiplier),
        'icon-xs': getSize('xs', iconMultiplier),
        'icon-sm': getSize('sm', iconMultiplier),
        'icon-base': getSize('base', iconMultiplier),
        'icon-lg': getSize('lg', iconMultiplier),
        'icon-xl': getSize('xl', iconMultiplier),
        'dot': '0.3rem', // 6px - for animated indicator dots
      },
      backgroundImage: {
        'diagonal-lines': `
          repeating-linear-gradient(-45deg, hsl(var(--text-low) / 0.4) 0 2px, transparent 1px 12px),
          linear-gradient(hsl(var(--bg-primary)), hsl(var(--bg-primary)))
        `,
      },
      ringColor: {
        DEFAULT: 'hsl(var(--brand))',
      },
      fontSize: {
        xs: [getSize('xs'), { lineHeight: getSize('xs', lineHeightMultiplier) }],      // 8px
        sm: [getSize('sm'), { lineHeight: getSize('sm', lineHeightMultiplier) }],   // 10px
        base: [getSize('base'), { lineHeight: getSize('base', lineHeightMultiplier) }],  // 12px (base)
        lg: [getSize('lg'), { lineHeight: getSize('lg', lineHeightMultiplier) }],    // 14px
        xl: [getSize('xl'), { lineHeight: getSize('xl', lineHeightMultiplier) }],         // 16px
        cta: [getSize('base'), { lineHeight: getSize('base') }],         // 16px
      },
      spacing: {
        'half': getSize('base', 0.25),
        'base': getSize('base', 0.5),
        'plusfifty': getSize('base', 0.75),
        'double': getSize('base', 1),
      },
      colors: {
        // Text colors: text-high, text-normal, text-low
        high: "hsl(var(--text-high))",
        normal: "hsl(var(--text-normal))",
        low: "hsl(var(--text-low))",
        // Background colors: bg-primary, bg-secondary, bg-panel
        primary: "hsl(var(--bg-primary))",
        secondary: "hsl(var(--bg-secondary))",
        panel: "hsl(var(--bg-panel))",
        // Accent colors
        brand: "hsl(var(--brand))",
        'brand-hover': "hsl(var(--brand-hover))",
        'brand-secondary': "hsl(var(--brand-secondary))",
        error: "hsl(var(--error))",
        success: "hsl(var(--success))",
        merged: "hsl(var(--merged))",
        // Text on accent
        'on-brand': "hsl(var(--text-on-brand))",
        // shadcn-style colors (used by @apply in CSS base layer)
        background: "hsl(var(--bg-primary))",
        foreground: "hsl(var(--text-normal))",
        border: "hsl(var(--border))",
        // Tasca design-token bridge (signal/amber/tier/exec/review/surface/fg/line)
        ...bridgeColors,
      },
      borderColor: {
        DEFAULT: "hsl(var(--border))",
        border: "hsl(var(--border))",
      },
      borderRadius: {
        lg: getSize('lg', radiusMultiplier),
        md: getSize('sm', radiusMultiplier),
        sm: getSize('xs', radiusMultiplier),
      },
      borderWidth: {
        base: getSize('base'),
        half: getSize('base', 0.5),
      },
      fontFamily: {
        'ibm-plex-sans': ['"IBM Plex Sans"', '"Noto Emoji"', 'sans-serif'],
        'ibm-plex-mono': ['"IBM Plex Mono"', 'monospace'],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        pill: {
          '0%': { opacity: '0' },
          '10%': { opacity: '1' },
          '80%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'running-dot': {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
        'border-flash': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-2px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(2px)' },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        pill: 'pill 2s ease-in-out forwards',
        'running-dot-1': 'running-dot 1.4s ease-in-out infinite',
        'running-dot-2': 'running-dot 1.4s ease-in-out 0.2s infinite',
        'running-dot-3': 'running-dot 1.4s ease-in-out 0.4s infinite',
        'border-flash': 'border-flash 2s linear infinite',
        shake: 'shake 0.3s ease-in-out',
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/container-queries"), require("tailwind-scrollbar")({ nocompatible: true })],
}
