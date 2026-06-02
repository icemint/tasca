#!/usr/bin/env node
/**
 * Post-build guard: prove the design-token bridge utilities actually emit in the
 * compiled app CSS. Catches the class of bug where an @config redirect or a
 * mis-wired config silently drops the bridge families (build stays green, but
 * `bg-signal` etc. produce nothing).
 *
 * Run AFTER `pnpm --filter @vibe/remote-web run build`.
 *   node scripts/check-app-tokens-emitted.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'packages/remote-web/dist/assets');
// Representative safelisted utilities (one per family) that must be present.
const REQUIRED = [
  '.bg-signal', '.text-fg-2', '.bg-surface-2', '.bg-tier-low', '.bg-exec-running', '.bg-review-merged',
  // highest-risk AA inks + alpha line — a @config regression dropping these is worst
  '.text-on-amber', '.text-on-signal', '.border-line',
];

if (!fs.existsSync(DIST)) {
  console.error(`check-app-tokens-emitted: ${path.relative(ROOT, DIST)} not found — run the remote-web build first`);
  process.exit(1);
}
const css = fs
  .readdirSync(DIST)
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(path.join(DIST, f), 'utf8'))
  .join('\n');

const missing = REQUIRED.filter((sel) => !css.includes(`${sel}{`) && !css.includes(`${sel} {`));
if (missing.length) {
  console.error('check-app-tokens-emitted: bridge utilities NOT emitted in compiled CSS (config wiring broken?):');
  for (const s of missing) console.error(`  ✗ ${s}`);
  console.error('  → the active @config (packages/local-web/tailwind.new.config.js) must include the bridge families');
  process.exit(1);
}
console.log(`check-app-tokens-emitted: ✓ ${REQUIRED.length} bridge utilities present in compiled CSS`);
