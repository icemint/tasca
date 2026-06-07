// Mechanical package-boundary enforcement (run as the repo `lint` step).
//
// The scaffold's inward dependency rule (§1.1/§1.3) is documented in every
// package header, but nothing FAILS when it's broken — pnpm's strict symlinked
// node_modules only blocks an import until someone adds the dep to package.json.
// This walks every workspace package's source and fails CI if a file imports a
// `@tasca/*` package outside that package's allowlist, independent of package.json
// (so adding the dep doesn't silently permit the import).
//
// Zero runtime deps by design (CLAUDE.md §14): a focused ~80-line node script over
// a heavyweight dependency-graph tool. Run: `tsx scripts/check-boundaries.ts`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Per-package allowlist of the OTHER `@tasca/*` packages it may import. The
 * inward graph: leaves (domain, auth) import nothing; the mid layer imports only
 * domain (+contracts where a package consumes the shared seams); coordination is
 * the composition root and may import everything. A package may always import
 * itself. Nothing may import coordination.
 */
export const ALLOWLIST: Record<string, readonly string[]> = {
  domain: [],
  auth: [],
  contracts: ['domain'],
  db: ['domain'],
  identity: ['domain'],
  routing: ['domain', 'contracts'],
  execution: ['domain', 'contracts'],
  adapters: ['domain', 'contracts'],
  coordination: ['domain', 'contracts', 'db', 'identity', 'auth', 'routing', 'execution', 'adapters'],
};

export interface ImportRef {
  /** The importing package (e.g. 'adapters'). */
  pkg: string;
  /** Repo-relative file path, for the error message. */
  file: string;
  /** The imported `@tasca/<imported>` package. */
  imported: string;
}

export interface Violation extends ImportRef {
  allowed: readonly string[];
}

/** Strip block + line comments so a `@tasca/x` mentioned in prose isn't counted. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // keep `://` (URLs in strings) intact
}

/** Extract the `@tasca/<name>` packages imported by a source file's statements. */
export function extractTascaImports(src: string): string[] {
  const out = new Set<string>();
  const code = stripComments(src);
  // `from '@tasca/x'` (static import/export) and `import('@tasca/x')` (dynamic).
  const re = /(?:from|import)\s*\(?\s*['"]@tasca\/([a-z][a-z-]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.add(m[1]!);
  return [...out];
}

/** Pure rule check: which imports fall outside their package's allowlist. */
export function findViolations(refs: readonly ImportRef[]): Violation[] {
  const violations: Violation[] = [];
  for (const ref of refs) {
    const allowed = ALLOWLIST[ref.pkg];
    if (!allowed) continue; // unknown package dir — not governed
    if (ref.imported === ref.pkg) continue; // self-import is fine
    if (!allowed.includes(ref.imported)) violations.push({ ...ref, allowed });
  }
  return violations;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'vendor' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Scan every governed package under <root>/packages and collect import refs. */
export function scanRepo(root: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const pkgsDir = path.join(root, 'packages');
  for (const pkg of Object.keys(ALLOWLIST)) {
    const srcDir = path.join(pkgsDir, pkg, 'src');
    let files: string[];
    try {
      files = listTsFiles(srcDir);
    } catch {
      continue; // package has no src/ — skip
    }
    for (const file of files) {
      for (const imported of extractTascaImports(readFileSync(file, 'utf8'))) {
        refs.push({ pkg, file: path.relative(root, file), imported });
      }
    }
  }
  return refs;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const violations = findViolations(scanRepo(REPO_ROOT));
  if (violations.length === 0) {
    console.log('boundary check: OK (no illegal @tasca/* imports)');
    return;
  }
  console.error(`boundary check: ${violations.length} illegal import(s):`);
  for (const v of violations) {
    console.error(
      `  ${v.file}: @tasca/${v.pkg} may not import @tasca/${v.imported} (allowed: ${v.allowed.map((a) => `@tasca/${a}`).join(', ') || 'none'})`
    );
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
