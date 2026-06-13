// WCAG-AA contrast gate (run as part of the repo `lint` step). Per the design brief
// (CLAUDE.md §19.3): rounding can cross the AA boundary, so assert it — don't eyeball.
//
// Parses app/src/styles/tokens.css into two themed scopes (`:root` = dark default,
// `[data-theme="light"]` = light overrides), resolves every semantic text/status token
// through its `var(--…)` chain to a terminal color, and asserts each maintained
// fg/bg PAIRING clears the AA ratio for normal text (4.5:1) in BOTH themes.
//
// Zero runtime deps by design (§14 — prefer stdlib over a new dependency): a focused
// node script over a CSS-parsing/color library. Run: `tsx scripts/check-contrast.ts`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Theme = 'dark' | 'light';

/**
 * A `color-mix(in srgb, <color> P%, transparent)` tinted background composited over an
 * opaque base surface. CSS renders `transparent` as the base showing through, so the
 * effective opaque color is `(P/100)*color + (1 - P/100)*base`. Status chips and signal
 * controls paint text over exactly this — a flat-token check misses the real ratio.
 */
export interface MixBg {
  /** The tint hue token, e.g. '--green' (mixed at `pct`% with transparent). */
  mix: string;
  /** Mix percentage, e.g. 9 for `color-mix(… 9%, transparent)`. */
  pct: number;
  /** The opaque surface the tint composites over, e.g. '--surface'. */
  over: string;
}

/** A single asserted text-on-surface pairing. `min` is the WCAG ratio it must clear. */
export interface Pairing {
  /** Foreground (text/status) token name, e.g. '--fg-faint'. */
  fg: string;
  /** Background: a flat surface token name, or a `color-mix` tint over a base. */
  bg: string | MixBg;
  /**
   * Minimum contrast ratio. 4.5 for normal body/status text (AA). A lower value is
   * permitted ONLY with a documented `note` justifying the exemption (e.g. placeholder
   * text, which WCAG 1.4.3 treats as an inactive UI affordance at the 3:1 minimum).
   */
  min: number;
  /** Human label for the report row. */
  label: string;
  /** Rationale, REQUIRED when `min < 4.5`, so no exemption is silent. */
  note?: string;
}

/**
 * The maintained assertion list: every TEXT tier on the surfaces it actually renders
 * on, plus the status text colors. Asserted in BOTH themes. AA normal-text = 4.5:1.
 *
 * --fg / --fg-2 / --fg-3 / --fg-4 / --fg-faint  → on --bg and --surface (body/secondary
 *   text sits on both); --fg-4 / --fg-faint additionally on --surface-2 (raised cards),
 *   --fg-faint also on --surface-3 / --bg-sub (input + placeholder fields).
 * --green / --red / --amber / --signal          → on --surface and --surface-2 (status text
 *   on flat cards and hover rows).
 * --signal-2                                     → primary text on signal controls; on
 *   --bg / --surface / --surface-2 AND on the signal-9% tint those controls paint.
 * --green / --amber / --red / --signal-2         → on their own color-mix tints (the chips
 *   and pills paint colored text over a tint of the SAME hue — the case a flat check misses).
 * --ink-on-amber                                 → label text ON the amber fill (.btn-primary).
 */
export const PAIRINGS: readonly Pairing[] = [
  { fg: '--fg', bg: '--bg', min: 4.5, label: 'fg / bg' },
  { fg: '--fg', bg: '--surface', min: 4.5, label: 'fg / surface' },
  { fg: '--fg-2', bg: '--bg', min: 4.5, label: 'fg-2 / bg' },
  { fg: '--fg-2', bg: '--surface', min: 4.5, label: 'fg-2 / surface' },
  { fg: '--fg-3', bg: '--bg', min: 4.5, label: 'fg-3 / bg' },
  { fg: '--fg-3', bg: '--surface', min: 4.5, label: 'fg-3 / surface' },
  { fg: '--fg-4', bg: '--bg', min: 4.5, label: 'fg-4 / bg' },
  { fg: '--fg-4', bg: '--surface', min: 4.5, label: 'fg-4 / surface' },
  { fg: '--fg-4', bg: '--surface-2', min: 4.5, label: 'fg-4 / surface-2' },
  { fg: '--fg-faint', bg: '--bg', min: 4.5, label: 'fg-faint / bg' },
  { fg: '--fg-faint', bg: '--surface', min: 4.5, label: 'fg-faint / surface' },
  { fg: '--fg-faint', bg: '--surface-2', min: 4.5, label: 'fg-faint / surface-2' },
  // Input placeholders: --fg-faint is the muted-most tier. On --bg-sub it clears 4.5 in
  // both themes (asserted at full AA below). On --surface-3 (the densest input fill) it
  // lands at ~4.36 dark / ~4.37 light. --fg-faint CANNOT be darkened to fix this without
  // inverting the muted-tier order (it must stay lighter/darker than --fg-4 per theme), so
  // this one pairing is an EXPLICIT exemption: --fg-faint on --surface-3 renders ONLY as
  // ::placeholder text (grep-verified — never body copy), which WCAG 1.4.3 classifies as an
  // inactive UI affordance held to the 3:1 minimum, not the 4.5:1 normal-text minimum.
  {
    fg: '--fg-faint',
    bg: '--surface-3',
    min: 3.0,
    label: 'fg-faint / surface-3 (placeholder)',
    note: 'placeholder-only (::placeholder); WCAG 1.4.3 inactive-affordance 3:1 minimum',
  },
  { fg: '--fg-faint', bg: '--bg-sub', min: 4.5, label: 'fg-faint / bg-sub (placeholder)' },
  { fg: '--fg-4', bg: '--bg-sub', min: 4.5, label: 'fg-4 / bg-sub' },
  // Status text on flat surfaces.
  { fg: '--green', bg: '--surface', min: 4.5, label: 'green (status) / surface' },
  { fg: '--red', bg: '--surface', min: 4.5, label: 'red (status) / surface' },
  { fg: '--amber', bg: '--surface', min: 4.5, label: 'amber (status) / surface' },
  { fg: '--signal', bg: '--surface', min: 4.5, label: 'signal (status) / surface' },
  // Status text on hover rows (--surface-2).
  { fg: '--green', bg: '--surface-2', min: 4.5, label: 'green (status) / surface-2' },
  { fg: '--red', bg: '--surface-2', min: 4.5, label: 'red (status) / surface-2' },
  { fg: '--amber', bg: '--surface-2', min: 4.5, label: 'amber (status) / surface-2' },
  // --signal-2 primary text (Set key / Rename / Connect / Repair / Accept / Assign …).
  { fg: '--signal-2', bg: '--bg', min: 4.5, label: 'signal-2 / bg' },
  { fg: '--signal-2', bg: '--surface', min: 4.5, label: 'signal-2 / surface' },
  { fg: '--signal-2', bg: '--surface-2', min: 4.5, label: 'signal-2 / surface-2' },
  // Colored text on its own color-mix tint — the case a flat-surface check cannot model.
  // Worst (lowest-contrast) tint % per hue across the real CSS is asserted here.
  { fg: '--signal-2', bg: { mix: '--signal', pct: 9, over: '--surface' }, min: 4.5, label: 'signal-2 / signal-9% tint' },
  { fg: '--amber', bg: { mix: '--amber', pct: 13, over: '--surface' }, min: 4.5, label: 'amber / amber-13% tint' },
  { fg: '--amber', bg: { mix: '--amber', pct: 9, over: '--surface-2' }, min: 4.5, label: 'amber / amber-9% tint (hover row)' },
  { fg: '--green', bg: { mix: '--green', pct: 13, over: '--surface' }, min: 4.5, label: 'green / green-13% tint' },
  { fg: '--red', bg: { mix: '--red', pct: 13, over: '--surface' }, min: 4.5, label: 'red / red-13% tint' },
  // Label text ON the amber fill (.btn-primary).
  { fg: '--ink-on-amber', bg: '--amber', min: 4.5, label: 'ink-on-amber / amber (fill)' },
];

/** Parsed token declarations, split into the dark (`:root`) and light scopes. */
export interface ThemeScopes {
  root: Map<string, string>;
  light: Map<string, string>;
}

/**
 * Parse tokens.css into the two scopes. Handles MULTIPLE `--x: v;` declarations on one
 * line (the primitive palette packs e.g. `--p-green-400: #34D399;  --p-green-700: …;`),
 * so we split each block on `;` rather than scanning per-line.
 *
 * Block detection is brace-aware: `:root[data-theme="light"], [data-theme="light"] { … }`
 * is the light scope; the leading bare `:root { … }` is dark.
 */
export function parseTokens(css: string): ThemeScopes {
  const root = new Map<string, string>();
  const light = new Map<string, string>();

  // Strip comments first so a `/* … #hex … */` note never reads as a declaration.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Walk top-level `selector { body }` blocks.
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(clean)) !== null) {
    const selector = m[1]!.trim();
    const body = m[2]!;
    const isLight = selector.includes('[data-theme="light"]');
    const target = isLight ? light : root;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i === -1) continue;
      const name = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (name.startsWith('--') && value) target.set(name, value);
    }
  }
  return { root, light };
}

/**
 * Resolve a token to its terminal color string for a theme. Light reads the light scope
 * first then falls back to root (light only overrides a subset); dark reads root only.
 * Follows `var(--x)` / `var(--x, fallback)` chains until a `#hex` or `rgb()/rgba()` lands.
 */
export function resolve(name: string, theme: Theme, scopes: ThemeScopes, seen = new Set<string>()): string | null {
  if (seen.has(name)) return null; // cycle guard
  seen.add(name);

  const lookup = (n: string): string | undefined =>
    theme === 'light' ? scopes.light.get(n) ?? scopes.root.get(n) : scopes.root.get(n);

  let value = lookup(name);
  if (value === undefined) return null;

  const varMatch = value.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i);
  if (varMatch) {
    const ref = varMatch[1]!;
    const resolved = resolve(ref, theme, scopes, seen);
    if (resolved) return resolved;
    // Token undefined → use the var() fallback if one was given.
    return varMatch[2] ? varMatch[2].trim() : null;
  }
  return value;
}

/** sRGB channel [0,255] → linearized component for relative luminance. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` into 0–255 channels. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join(''); // #rgba → drop alpha
    if (h.length === 8) h = h.slice(0, 6); // #rrggbbaa → drop alpha
    if (h.length !== 6) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  const rgb = v.match(/^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return null;
}

/**
 * Composite a `color-mix(in srgb, color P%, transparent)` tint over an opaque base.
 * `transparent` contributes the base showing through, so the rendered opaque color is
 * `(P/100)*color + (1 - P/100)*base` per channel. Channels stay fractional (the contrast
 * math linearizes from [0,255], not integers) — no rounding here, to match the GPU result.
 */
export function compositeMix(color: Rgb, pct: number, base: Rgb): Rgb {
  const p = pct / 100;
  return {
    r: p * color.r + (1 - p) * base.r,
    g: p * color.g + (1 - p) * base.g,
    b: p * color.b + (1 - p) * base.b,
  };
}

/** WCAG relative luminance of an sRGB color. */
export function luminance(c: Rgb): number {
  return 0.2126 * linearize(c.r) + 0.7152 * linearize(c.g) + 0.0722 * linearize(c.b);
}

/** WCAG contrast ratio between two colors (1 .. 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface Result extends Pairing {
  theme: Theme;
  ratio: number | null;
  pass: boolean;
}

/**
 * Resolve a pairing's background to a concrete sRGB color in a theme. A flat token
 * resolves through its var() chain; a `MixBg` resolves the tint hue + the base surface,
 * then composites the `color-mix(… P%, transparent)` over the base.
 */
function resolveBg(bg: string | MixBg, theme: Theme, scopes: ThemeScopes): Rgb | null {
  if (typeof bg === 'string') {
    const v = resolve(bg, theme, scopes);
    return v ? parseColor(v) : null;
  }
  const tintVal = resolve(bg.mix, theme, scopes);
  const baseVal = resolve(bg.over, theme, scopes);
  const tint = tintVal ? parseColor(tintVal) : null;
  const base = baseVal ? parseColor(baseVal) : null;
  if (!tint || !base) return null;
  return compositeMix(tint, bg.pct, base);
}

/** Evaluate every pairing in both themes against the parsed tokens. */
export function evaluate(scopes: ThemeScopes): Result[] {
  const out: Result[] = [];
  for (const theme of ['dark', 'light'] as const) {
    for (const p of PAIRINGS) {
      const fgVal = resolve(p.fg, theme, scopes);
      const fg = fgVal ? parseColor(fgVal) : null;
      const bg = resolveBg(p.bg, theme, scopes);
      if (!fg || !bg) {
        out.push({ ...p, theme, ratio: null, pass: false });
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      out.push({ ...p, theme, ratio, pass: ratio >= p.min });
    }
  }
  return out;
}

/** Render a background descriptor for the failure report. */
function describeBg(bg: string | MixBg): string {
  return typeof bg === 'string' ? bg : `color-mix(${bg.mix} ${bg.pct}% over ${bg.over})`;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS_PATH = path.join(REPO_ROOT, 'app', 'src', 'styles', 'tokens.css');

function main(): void {
  // Fail closed against silent exemptions: any below-AA pairing MUST justify itself.
  const undocumented = PAIRINGS.filter((p) => p.min < 4.5 && !p.note);
  if (undocumented.length > 0) {
    for (const p of undocumented) {
      console.error(`  ${p.label}: min ${p.min} < 4.5 without a note — undocumented exemption`);
    }
    console.error(`contrast check: ${undocumented.length} below-AA pairing(s) lack a rationale note`);
    process.exit(1);
  }

  const scopes = parseTokens(readFileSync(TOKENS_PATH, 'utf8'));
  const results = evaluate(scopes);

  const rows = results.map((r) => ({
    theme: r.theme,
    pairing: r.label,
    ratio: r.ratio === null ? 'n/a' : r.ratio.toFixed(2),
    min: r.min.toFixed(2),
    status: r.pass ? 'PASS' : 'FAIL',
  }));
  console.table(rows);

  const failures = results.filter((r) => !r.pass);
  if (failures.length === 0) {
    console.log(`contrast check: OK (${results.length} pairings pass AA in both themes)`);
    return;
  }
  for (const f of failures) {
    const got = f.ratio === null ? 'unresolved color' : `${f.ratio.toFixed(2)}:1`;
    console.error(`  ${f.theme}: ${f.label} (${f.fg} on ${describeBg(f.bg)}) = ${got}, need ${f.min}:1`);
  }
  console.error(`contrast check: ${failures.length} sub-AA pairing(s)`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
