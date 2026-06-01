#!/usr/bin/env node
/**
 * Bumps the Tasca version across every release surface at once.
 *
 * Tasca uses a single, converged version train (see docs/SEMVER.md): the app,
 * the remote server, the relay-tunnel binary, and every web package all move
 * together to one `0.MINOR.PATCH`. This script is the source of truth for that
 * lockstep bump — it rewrites the `version` field in:
 *
 *   - package.json (root)
 *   - npx-cli/package.json
 *   - packages/<star>/package.json
 *   - crates/<star>/Cargo.toml          ([package] version only)
 *   - crates/tauri-app/tauri.conf.json
 *
 * The remote and relay-tunnel crates live in excluded sub-workspaces with their
 * own Cargo.lock; they are bumped here too so the whole repo stays on one number.
 *
 * Usage:
 *   node scripts/bump-version.mjs <version>     # e.g. 0.2.0  (explicit target)
 *   node scripts/bump-version.mjs patch         # 0.1.44 -> 0.1.45
 *   node scripts/bump-version.mjs minor         # 0.1.44 -> 0.2.0
 *   node scripts/bump-version.mjs major         # 0.1.44 -> 1.0.0
 *   node scripts/bump-version.mjs <...> --dry-run   # print changes, write nothing
 *
 * After bumping, update CHANGELOG.md, then tag/push with `v<MAJOR>.<MINOR>.<PATCH>`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

function readVersion(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
  return m ? m[1] : null;
}

function computeTarget(arg, current) {
  if (SEMVER_RE.test(arg)) return arg;
  const [maj, min, pat] = current.split('.').map(Number);
  switch (arg) {
    case 'major': return `${maj + 1}.0.0`;
    case 'minor': return `${maj}.${min + 1}.0`;
    case 'patch': return `${maj}.${min}.${pat + 1}`;
    default:
      fail(`expected a version (x.y.z) or one of: major | minor | patch — got "${arg}"`);
  }
}

/** Collect every version surface that exists on disk. */
function collectSurfaces() {
  const json = [];
  const cargo = [];

  const addJson = (rel) => {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) json.push(abs);
  };

  addJson('package.json');
  addJson('npx-cli/package.json');
  addJson('crates/tauri-app/tauri.conf.json');

  const pkgDir = path.join(ROOT, 'packages');
  if (fs.existsSync(pkgDir)) {
    for (const name of fs.readdirSync(pkgDir)) {
      addJson(path.join('packages', name, 'package.json'));
    }
  }

  const cratesDir = path.join(ROOT, 'crates');
  if (fs.existsSync(cratesDir)) {
    for (const name of fs.readdirSync(cratesDir)) {
      const abs = path.join(cratesDir, name, 'Cargo.toml');
      if (fs.existsSync(abs)) cargo.push(abs);
    }
  }
  return { json, cargo };
}

/** Replace the first top-level `"version": "x.y.z"` in a JSON file, preserving formatting. */
function bumpJson(file, target) {
  const text = fs.readFileSync(file, 'utf8');
  let replaced = false;
  const out = text.replace(/("version"\s*:\s*")(\d+\.\d+\.\d+)(")/, (m, a, old, c) => {
    replaced = true;
    return old === target ? m : `${a}${target}${c}`;
  });
  const old = readVersion(file);
  if (!replaced) return { old: null, changed: false };
  if (out !== text) fs.writeFileSync(file, out);
  return { old, changed: out !== text };
}

/** Replace the `version = "x.y.z"` inside the [package] section of a Cargo.toml. */
function bumpCargo(file, target) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let section = '';
  let old = null;
  let changed = false;
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { section = header[1].trim(); continue; }
    if (section === 'package') {
      const vm = lines[i].match(/^(version\s*=\s*")(\d+\.\d+\.\d+)(".*)$/);
      if (vm) {
        old = vm[2];
        touched = true;
        if (vm[2] !== target) {
          lines[i] = `${vm[1]}${target}${vm[3]}`;
          changed = true;
        }
        break;
      }
    }
  }
  if (!touched) return { old: null, changed: false };
  if (changed) fs.writeFileSync(file, lines.join('\n'));
  return { old, changed };
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  if (args.length !== 1) {
    fail('usage: bump-version <version|major|minor|patch> [--dry-run]');
  }

  const rootPkg = path.join(ROOT, 'package.json');
  const current = readVersion(rootPkg);
  if (!current) fail('could not read current version from package.json');

  const target = computeTarget(args[0], current);
  console.log(`bump-version: ${current} -> ${target}${dryRun ? '  (dry-run)' : ''}\n`);

  const { json, cargo } = collectSurfaces();
  const results = [];

  for (const file of json) {
    const r = dryRun ? { old: readVersion(file), changed: readVersion(file) !== target } : bumpJson(file, target);
    results.push({ file, ...r });
  }
  for (const file of cargo) {
    let r;
    if (dryRun) {
      // read [package] version without writing
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let section = '', old = null;
      for (const line of lines) {
        const h = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (h) { section = h[1].trim(); continue; }
        if (section === 'package') {
          const vm = line.match(/^version\s*=\s*"(\d+\.\d+\.\d+)"/);
          if (vm) { old = vm[1]; break; }
        }
      }
      r = { old, changed: old !== null && old !== target };
    } else {
      r = bumpCargo(file, target);
    }
    results.push({ file, ...r });
  }

  let changedCount = 0;
  for (const r of results) {
    const rel = path.relative(ROOT, r.file);
    if (r.old === null) {
      console.log(`  · ${rel}  (no [package] version — skipped)`);
    } else if (r.changed) {
      console.log(`  ✓ ${rel}  ${r.old} -> ${target}`);
      changedCount++;
    } else {
      console.log(`  = ${rel}  already ${target}`);
    }
  }

  console.log(`\nbump-version: ${changedCount} file(s) ${dryRun ? 'would change' : 'updated'}.`);
  if (!dryRun && changedCount > 0) {
    console.log('Next: update CHANGELOG.md, then commit and tag `v' + target + '`.');
  }
}

main();
