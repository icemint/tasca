#!/usr/bin/env node
/**
 * Build the vendored, de-Electron execution core.
 *
 * Implements the proven native-rebuild recipe (Tasca-Spike-Emdash-Result §
 * "Reproducible native-rebuild recipe"):
 *
 *   1. install with electron-rebuild + electron binary download skipped
 *   2. rebuild node-pty + keytar via per-module node-gyp against Node 22 ABI,
 *      using Python 3.11 (3.12+ removed distutils -> node-gyp fails)
 *   3. fetch the N-API prebuilt for sqlite3 (prebuild-install -r napi;
 *      no Xcode/xcodebuild needed)
 *   4. build:main -> dist/main
 *
 * `pnpm rebuild <mods>` is unreliable (exits 0, builds nothing) — this drives
 * each module's node-gyp / prebuild-install directly.
 *
 * Env:
 *   PYTHON / TASCA_PYTHON_311 — path to a Python 3.11 interpreter. If unset,
 *     tries `uv python find 3.11`, then a bare `python3.11` on PATH.
 *   TASCA_SKIP_VENDOR_INSTALL=1 — skip step 1 (deps already installed).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, '..', 'vendor', 'emdash');

if (!fs.existsSync(path.join(VENDOR, 'package.json'))) {
  console.error(
    `[build-vendor] vendor submodule missing at ${VENDOR}.\n` +
      `Run: git submodule update --init --recursive`
  );
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: VENDOR, ...opts });
}

// The vendor pins its own pnpm (engines.pnpm + packageManager). The repo root
// uses a different pnpm; the globally-installed pnpm may not satisfy the
// vendor's engines constraint. Drive the vendor's pnpm through corepack so its
// pinned version is honored regardless of the ambient pnpm.
function vendorPnpm() {
  const pm = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8')).packageManager;
  // pm looks like "pnpm@10.28.2"; corepack runs the exact pinned version.
  return pm ? ['corepack', [pm.split('@')[0] + '@' + pm.split('@')[1]]] : ['pnpm', []];
}
const [PNPM_BIN, PNPM_PREFIX] = vendorPnpm();
function runVendorPnpm(args, opts = {}) {
  run(PNPM_BIN, [...PNPM_PREFIX, ...args], opts);
}

function findPython311() {
  if (process.env.TASCA_PYTHON_311) return process.env.TASCA_PYTHON_311;
  if (process.env.PYTHON) return process.env.PYTHON;
  // try uv
  const uv = spawnSync('uv', ['python', 'find', '3.11'], { encoding: 'utf8' });
  if (uv.status === 0 && uv.stdout.trim()) return uv.stdout.trim();
  // try a bare python3.11 on PATH
  const which = spawnSync('python3.11', ['--version'], { encoding: 'utf8' });
  if (which.status === 0) return 'python3.11';
  console.error(
    '[build-vendor] No Python 3.11 found. Set TASCA_PYTHON_311 or install via `uv python install 3.11`.'
  );
  process.exit(1);
}

// 1. install. Skip the electron binary download + electron-rebuild, AND skip
//    package lifecycle scripts (--ignore-scripts) so pnpm does NOT run the
//    native modules' own `node-gyp rebuild` during install with the wrong
//    Python. Those builds happen in steps 2/3 below with Python 3.11. Without
//    --ignore-scripts, node-pty/keytar install-scripts run under the default
//    Python (3.12+ removed distutils) and the install fails (spike §4.1).
if (process.env.TASCA_SKIP_VENDOR_INSTALL !== '1') {
  runVendorPnpm(['install', '--ignore-scripts'], {
    env: {
      ...process.env,
      EMDASH_SKIP_ELECTRON_REBUILD: '1',
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
      CI: '1',
    },
  });
}

// 2. node-pty + keytar: classic node-gyp, Python 3.11, Node 22 ABI
const PY = findPython311();
console.log(`[build-vendor] using Python: ${PY}`);
const gypEnv = { ...process.env, PYTHON: PY, npm_config_python: PY };
for (const mod of ['node-pty', 'keytar']) {
  const modDir = path.join(VENDOR, 'node_modules', mod);
  if (!fs.existsSync(modDir)) {
    console.error(`[build-vendor] ${mod} not installed at ${modDir}`);
    process.exit(1);
  }
  run(path.join(VENDOR, 'node_modules', '.bin', 'node-gyp'), ['rebuild'], {
    cwd: modDir,
    env: gypEnv,
  });
}

// 3. sqlite3: N-API prebuilt (ABI-stable; sidesteps xcodebuild)
{
  const modDir = path.join(VENDOR, 'node_modules', 'sqlite3');
  run(path.join(VENDOR, 'node_modules', '.bin', 'prebuild-install'), ['-r', 'napi'], {
    cwd: modDir,
  });
}

// 4. build the main process to CommonJS -> dist/main
runVendorPnpm(['run', 'build:main']);

// sanity: the three native modules load + dist/main exists
const distMain = path.join(VENDOR, 'dist', 'main');
if (!fs.existsSync(distMain)) {
  console.error(`[build-vendor] expected build artifact missing: ${distMain}`);
  process.exit(1);
}
console.log(`\n[build-vendor] OK — dist/main at ${distMain}`);
