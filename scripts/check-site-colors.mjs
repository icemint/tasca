#!/usr/bin/env node
/**
 * Guard: the marketing site (website/) must drive every color through the token
 * system (tokens.css via var(--…)) — no hardcoded hex/rgb in inline styles.
 *
 * Scans website/src for `style="…"` attributes containing a hex (#abc / #aabbcc)
 * or rgb()/rgba() literal. Token usage (var(--x)) and color-mix(... var(--x) …)
 * are fine. Brand-logo SVGs use `fill="#…"` (an attribute, not `style`), so the
 * Google "G" mark is naturally exempt.
 *
 * Usage:  node scripts/check-site-colors.mjs
 * Exit 1 with a list of offenders, 0 if clean.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'website', 'src');

const STYLE_ATTR = /style\s*=\s*"([^"]*)"/gi;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGB = /\brgba?\(/i;

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) out.push(...walk(abs));
    else if (name.endsWith('.astro')) out.push(abs);
  }
  return out;
}

if (!fs.existsSync(SRC)) {
  console.error(`check-site-colors: ${SRC} not found`);
  process.exit(1);
}

const offenders = [];
for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let m;
    STYLE_ATTR.lastIndex = 0;
    while ((m = STYLE_ATTR.exec(line)) !== null) {
      const val = m[1];
      if (HEX.test(val) || RGB.test(val)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[0].trim()}`);
      }
    }
  });
}

if (offenders.length) {
  console.error('check-site-colors: hardcoded colors in inline styles (use tokens via var(--…)):');
  for (const o of offenders) console.error(`  ✗ ${o}`);
  process.exit(1);
}
console.log('check-site-colors: ✓ no hardcoded colors in website/src inline styles');
