#!/usr/bin/env node
/**
 * Bridge the Tasca design-system tokens into the app's token system (Option A).
 *
 * Reads design-system/assets/tokens.css (hex, dark-default, data-theme="light")
 * and emits packages/web-core/src/app/styles/new/tokens-bridge.css keyed to the
 * app's convention: `:root` = LIGHT (app default) and `.dark` = dark, with solid
 * colors converted to HSL triplets ("H S% L%") so `hsl(var(--x))` Tailwind
 * utilities resolve from them. Alpha/effect/theme-agnostic tokens are copied raw.
 *
 * GUARANTEE: every solid color is round-tripped HSL→hex and asserted byte-exact
 * against the source hex. Exactness ⇒ the rendered color is identical ⇒ WCAG
 * contrast is provably unchanged. The script also computes AA contrast for the
 * key text/surface pairs in both themes and fails if any primary pair drops
 * below AA. Run with --check to verify the committed file is up to date.
 *
 *   node scripts/build-app-tokens.mjs           # generate + verify
 *   node scripts/build-app-tokens.mjs --check    # verify only (CI)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'design-system/assets/tokens.css');
const OUT = path.join(ROOT, 'packages/web-core/src/app/styles/new/tokens-bridge.css');
const CHECK = process.argv.includes('--check');

// Inks for "on colored surface" (not in source). Theme-aware: in light theme the
// signal brand goes darker (#0052B5) so its ink must flip to white for AA; amber
// stays light in both themes so its dark ink holds.
const EXTRA = {
  '--on-amber': { light: '#1A1303', dark: '#1A1303' },
  '--on-signal': { light: '#FFFFFF', dark: '#04101F' },
  '--selection-fg': { light: '#FFFFFF', dark: '#04080F' },
};

// ---- color math ----
const parseHex = (hex) => {
  const m = String(hex).trim().match(/^#([0-9a-fA-F]{6})$/) || String(hex).trim().match(/^#([0-9a-fA-F]{3})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const toHex = ([r, g, b]) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)].map((x) => Math.round(x * 255));
}
const rnd = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };
// minimal-precision HSL that round-trips byte-exact; throws if none up to 4 decimals.
function hexToExactHsl(hex) {
  const [r, g, b] = parseHex(hex);
  const [H, S, L] = rgbToHsl(r, g, b);
  for (let d = 0; d <= 4; d++) {
    const h = rnd(H, d), s = rnd(S, d), l = rnd(L, d);
    if (toHex(hslToRgb(h, s, l)) === toHex([r, g, b])) return `${h} ${s}% ${l}%`;
  }
  throw new Error(`no exact HSL for ${hex} within 4 decimals`);
}
const luminance = ([r, g, b]) => { const a = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
const contrast = (h1, h2) => { const L1 = luminance(parseHex(h1)), L2 = luminance(parseHex(h2)); const a = Math.max(L1, L2), b = Math.min(L1, L2); return (a + 0.05) / (b + 0.05); };

// ---- parse tokens.css ----
const css = fs.readFileSync(SRC, 'utf8');
const block = (sel) => {
  const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}', 'm');
  const m = css.match(re); return m ? m[1] : '';
};
const decls = (body) => { const map = {}; const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi; let m; while ((m = re.exec(body))) map['--' + m[1]] = m[2].trim(); return map; };
const rootMap = decls(block(':root'));
const lightMap = decls(block(':root[data-theme="light"]'));
function resolve(value, scope) {
  let v = String(value).trim(); let g = 0;
  while (v.startsWith('var(') && g++ < 12) {
    const name = v.slice(4, v.indexOf(')')).trim();
    const nv = scope === 'light' && lightMap[name] != null ? lightMap[name] : rootMap[name];
    if (nv == null) return null;
    v = String(nv).trim();
  }
  return v;
}

// Targets: every :root token that isn't a raw primitive (--p-*), the marker, or
// a token the app's own stylesheet already owns (--syntax-* are defined publicly
// in web-core/.../new/index.css — re-emitting would create a second source).
const SKIP = (k) => k.startsWith('--p-') || k.startsWith('--syntax-') || k === '--fonts-display-loaded';
const targets = Object.keys(rootMap).filter((k) => !SKIP(k));

const lightVals = {}, darkVals = {};
const exact = []; const raw = [];
for (const k of targets) {
  const d = resolve(rootMap[k], 'dark');
  const l = lightMap[k] != null ? resolve(lightMap[k], 'light') : resolve(rootMap[k], 'light');
  // Fail loud: a token that no longer resolves (e.g. a renamed primitive) must
  // not silently vanish from the bridge while --check still passes.
  if (d == null || l == null) { console.error(`build-app-tokens: unresolved token ${k} (check var() chain in tokens.css)`); process.exit(1); }
  const solid = parseHex(d) && parseHex(l);
  if (solid) {
    lightVals[k] = hexToExactHsl(l); darkVals[k] = hexToExactHsl(d);
    exact.push([k, l, d]);
  } else {
    lightVals[k] = l; darkVals[k] = d;
    raw.push(k);
  }
}
for (const [k, v] of Object.entries(EXTRA)) { lightVals[k] = hexToExactHsl(v.light); darkVals[k] = hexToExactHsl(v.dark); exact.push([k, v.light, v.dark]); }

// ---- emit ----
// Solid colors are emitted as full hsl() values so they are consumable both as
// Tailwind colors (`var(--x)`) AND directly in vendored/ported design-system CSS
// (`background: var(--surface-2)`) without an hsl() wrapper at every call site.
const isExact = new Set(exact.map(([k]) => k));
const fmt = (k, v) => (isExact.has(k) ? `hsl(${v})` : v);
const order = [...exact.map(([k]) => k), ...raw].filter((v, i, a) => a.indexOf(v) === i);
const lightLines = order.map((k) => `    ${k}: ${fmt(k, lightVals[k])};`).join('\n');
const darkLines = order.filter((k) => darkVals[k] !== lightVals[k]).map((k) => `    ${k}: ${fmt(k, darkVals[k])};`).join('\n');
const out = `/* GENERATED by scripts/build-app-tokens.mjs from design-system/assets/tokens.css — DO NOT EDIT.
   Option A bridge: design-system semantic tokens → app token system.
   Solid colors are full hsl() values (use via var(--x)); alpha/effect/agnostic raw.
   :root = light (app default); .dark = dark overrides. ${exact.length} colors verified byte-exact. */
@layer base {
  :root {
${lightLines}
  }
  .dark {
${darkLines}
  }
}
`;

// ---- WCAG AA report (provable: exactness ⇒ unchanged, but assert anyway) ----
const pairs = [
  ['fg on bg', '--fg', '--bg', 4.5],
  ['fg-2 on bg', '--fg-2', '--bg', 4.5],
  ['fg-3 on surface', '--fg-3', '--surface', 4.5],
  ['fg-4 on surface-2', '--fg-4', '--surface-2', 4.5],
  ['signal on bg', '--signal', '--bg', 3.0],
  ['on-amber on amber', '--on-amber', '--amber', 4.5],
  ['on-signal on signal', '--on-signal', '--signal', 4.5],
  ['red on bg', '--red', '--bg', 3.0],
  ['green on bg', '--green', '--bg', 3.0],
];
const hexOf = (k, scope) => (EXTRA[k] ? EXTRA[k][scope] : (scope === 'light' ? (lightMap[k] != null ? resolve(lightMap[k], 'light') : resolve(rootMap[k], 'light')) : resolve(rootMap[k], 'dark')));
let aaFail = 0;
const report = [];
for (const scope of ['light', 'dark']) {
  for (const [name, fg, bg, min] of pairs) {
    const a = hexOf(fg, scope), b = hexOf(bg, scope);
    if (!parseHex(a) || !parseHex(b)) continue;
    const c = contrast(a, b);
    const ok = c >= min;
    if (!ok) aaFail++;
    report.push(`  ${scope.padEnd(5)} ${name.padEnd(22)} ${c.toFixed(2)}:1  (min ${min})  ${ok ? 'PASS' : 'FAIL'}`);
  }
}

console.log(`build-app-tokens: ${exact.length} solid colors converted to HSL, all byte-exact round-trip ✓`);
console.log(`build-app-tokens: ${raw.length} alpha/effect/agnostic tokens copied raw`);
console.log('WCAG AA contrast (post-conversion == source, since colors are byte-identical):');
console.log(report.join('\n'));
if (aaFail) { console.error(`build-app-tokens: ${aaFail} primary pair(s) below AA`); process.exit(1); }

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== out) { console.error('build-app-tokens: tokens-bridge.css is stale — run `node scripts/build-app-tokens.mjs`'); process.exit(1); }
  console.log('build-app-tokens: ✓ committed tokens-bridge.css is up to date');
} else {
  fs.writeFileSync(OUT, out);
  console.log(`build-app-tokens: wrote ${path.relative(ROOT, OUT)}`);
}
