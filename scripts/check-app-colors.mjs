#!/usr/bin/env node
/**
 * App color guard: ported app code must drive color through the token system
 * (Tailwind utilities → hsl(var(--…)) / var(--…)), not hardcoded hex.
 *
 * ERRORS (fail CI) on hardcoded hex in inline `style={{…}}` objects / style
 * color props — the highest-signal violation (0 in the codebase today, so this
 * is enforceable now without touching legacy).
 *
 * WARNS (non-failing) on Tailwind arbitrary hex (`bg-[#…]`, `text-[#…]`, …) —
 * there is pre-existing legacy usage; ported code is held to zero via review,
 * and the legacy is tracked for cleanup. Brand/icon SVG `fill="#…"` is exempt.
 *
 *   node scripts/check-app-colors.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['packages/remote-web/src', 'packages/web-core/src', 'packages/ui/src'];

// Whole-file (multi-line) match of an inline style object up to its first `}}`.
const STYLE_OBJ = /style=\{\{([\s\S]*?)\}\}/g;
const STYLE_PROP_HEX = /(color|background|backgroundColor|backgroundImage|borderColor|outline|outlineColor|caretColor|textDecorationColor|fill|stroke|boxShadow)\s*:\s*['"`][^'"`]*#[0-9a-fA-F]{3,8}/;
const ARBITRARY_HEX = /\b(bg|text|border|ring|from|to|via|fill|stroke|decoration|shadow|outline)-\[#[0-9a-fA-F]{3,8}\]/g;
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
// Ratchet: legacy Tailwind arbitrary-hex baseline. Ported code must not add more.
const ARBITRARY_BASELINE = 27;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) { if (name !== 'node_modules') walk(abs, out); }
    else if (/\.(ts|tsx)$/.test(name)) out.push(abs);
  }
  return out;
}

const errors = [];
let warnCount = 0;
for (const d of DIRS) {
  for (const file of walk(path.join(ROOT, d))) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    STYLE_OBJ.lastIndex = 0;
    while ((m = STYLE_OBJ.exec(text)) !== null) {
      if (STYLE_PROP_HEX.test(m[0])) errors.push(`${path.relative(ROOT, file)}:${lineOf(text, m.index)}  ${m[0].replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    }
    ARBITRARY_HEX.lastIndex = 0;
    while (ARBITRARY_HEX.exec(text) !== null) warnCount++;
  }
}

if (warnCount) console.warn(`check-app-colors: ⚠ ${warnCount} Tailwind arbitrary-hex usage(s) in legacy app code (tracked for cleanup; ported code must use tokens)`);
if (warnCount > ARBITRARY_BASELINE) {
  console.error(`check-app-colors: arbitrary-hex regression — ${warnCount} > baseline ${ARBITRARY_BASELINE}. Use design tokens, not bg-[#…]. (Lower the baseline when legacy is cleaned up.)`);
  process.exit(1);
}
if (errors.length) {
  console.error('check-app-colors: hardcoded hex in inline styles (use token utilities / var(--…)):');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('check-app-colors: ✓ no hardcoded hex in app inline styles');
