// Hardcoded-color (token-only) gate (run as part of the repo `lint` step). Per the
// design brief (CLAUDE.md §19.3): the design system is token-driven; a raw color
// literal outside the token definitions is drift that breaks theming + the AA gate.
//
// Scans app/src/styles/**.css, app/src/lib/**.ts, app/src/pages/**.astro for raw color
// literals (#hex, rgb()/rgba(), hsl()/hsla(), and bare CSS named colors used as values).
// tokens.css is exempt (it IS the palette). A `var(--x, #fallback)` fallback is token-
// driven (the token is the source of truth; the fallback only fires if undefined) and is
// allowed. A line tagged `/* allow-hardcoded-color: <reason> */` is allowed. A small
// FILE_ALLOWLIST covers genuinely-literal surfaces (brand SVG, HTML meta theme-color).
//
// Zero runtime deps by design (§14 — prefer stdlib over a new dependency). Run:
// `tsx scripts/check-hardcoded-colors.ts`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repo-relative globs (dir + extension) this gate governs. */
const SCAN: ReadonlyArray<{ dir: string; ext: RegExp }> = [
  { dir: 'app/src/styles', ext: /\.css$/ },
  { dir: 'app/src/lib', ext: /\.ts$/ },
  { dir: 'app/src/pages', ext: /\.astro$/ },
];

/** Files exempt entirely, each with the reason it may hold literal colors. */
export const FILE_ALLOWLIST: Record<string, string> = {
  'app/src/styles/tokens.css': 'the palette definition — literals ARE the source of truth',
  'app/src/lib/icons.ts': 'Google brand SVG — sign-in branding mandates the exact logo fills',
  // The HTML <meta name="theme-color"> attribute cannot reference a CSS var; it needs a
  // literal hex. Both pages set the dark-ink brand color.
  'app/src/pages/index.astro': 'HTML <meta name="theme-color"> requires a literal hex',
  'app/src/pages/invite.astro': 'HTML <meta name="theme-color"> requires a literal hex',
};

/** Inline escape hatch: a line containing this tag is exempt (reason follows the colon). */
export const INLINE_ALLOW = 'allow-hardcoded-color:';

// CSS named colors that, used as a value, are real hardcoded colors. (Keyword values like
// `transparent` / `currentColor` / `inherit` are NOT colors-by-literal and stay allowed.)
const NAMED = ['white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'gray', 'grey', 'silver', 'navy', 'teal', 'aqua', 'fuchsia', 'maroon', 'lime', 'olive'];

export interface ColorHit {
  file: string;
  line: number;
  match: string;
}

/**
 * Find raw color literals in a source string. `var(--x, #fallback)` fallbacks are
 * stripped before scanning (token-driven), and any line tagged with INLINE_ALLOW is
 * skipped. Returns one hit per literal with its 1-based line number.
 */
export function scanForHardcodedColors(src: string, file: string): ColorHit[] {
  const hits: ColorHit[] = [];
  const lines = src.split('\n');

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Track /* … */ spans so a #hex inside a comment is never flagged.
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    if (line.includes(INLINE_ALLOW)) continue; // explicit per-line escape hatch
    // Strip inline /* … */ comments; flag an unterminated opener for the next lines.
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    // Strip `// …` line comments (TS/astro script) so a hex in a note isn't flagged.
    line = line.replace(/(^|[^:])\/\/.*$/, '$1');
    // Drop var() fallbacks: `var(--x, #fallback)` is token-driven, fallback is inert.
    const scan = line.replace(/var\(\s*--[a-z0-9-]+\s*,[^)]*\)/gi, 'var(--x)');

    for (const m of findLiterals(scan)) {
      hits.push({ file, line: i + 1, match: m });
    }
  }
  return hits;
}

/** All raw color-literal tokens on one already-comment/fallback-stripped line. */
function findLiterals(line: string): string[] {
  const out: string[] = [];
  // #rgb / #rrggbb / #rrggbbaa
  for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) out.push(m[0]);
  // rgb()/rgba()/hsl()/hsla(
  for (const m of line.matchAll(/\b(?:rgba?|hsla?)\s*\(/gi)) out.push(m[0].replace(/\s+/g, ''));
  // bare named colors used as a value: `: white`, `solid black`, `, red` …
  const nameRe = new RegExp(`(?:^|[:,\\s(])(${NAMED.join('|')})(?=[;,\\s)]|$)`, 'gi');
  for (const m of line.matchAll(nameRe)) out.push(m[1]!);
  return out;
}

function listFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, ext));
    else if (ext.test(entry)) out.push(full);
  }
  return out;
}

/** Scan every governed file under <root>, honoring the file + inline allowlists. */
export function findHardcodedColors(root: string): ColorHit[] {
  const hits: ColorHit[] = [];
  for (const { dir, ext } of SCAN) {
    for (const file of listFiles(path.join(root, dir), ext)) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel in FILE_ALLOWLIST) continue;
      hits.push(...scanForHardcodedColors(readFileSync(file, 'utf8'), rel));
    }
  }
  return hits;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const hits = findHardcodedColors(REPO_ROOT);
  if (hits.length === 0) {
    console.log('hardcoded-color check: OK (token-driven; no raw literals outside tokens.css)');
    return;
  }
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}: raw color literal "${h.match}" — use a semantic token (var(--…))`);
  }
  console.error(`hardcoded-color check: ${hits.length} raw color literal(s) outside the token layer`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
