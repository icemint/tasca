// Org-scoping enforcement (run as part of the repo `lint` step, alongside check-boundaries).
//
// Multi-tenant isolation is app-level WHERE org_id (not Postgres RLS — see the slice-3
// decision). The "can't forget a WHERE org_id" guarantee rests on two enforcers:
//   1. the TYPE SYSTEM — every tenant-scoped store method takes a required `orgId`, so a
//      caller that omits it is a COMPILE error;
//   2. THIS guard — raw SQL touching a tenant table is confined to the SCOPED LAYER (the
//      store / queue / claim-repo / schema files). Any OTHER source file that writes raw
//      `FROM task` (etc.) is a violation, forcing it through the org-scoped store methods
//      instead of bypassing the isolation with hand-rolled SQL.
//
// A guard that never fires is worse than none (false confidence), so its detection is unit-
// tested (check-org-scoping.test.ts) with a deliberately-violating snippet that MUST be
// flagged and compliant/scoped-layer snippets that must not be.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The tenant tables — raw SQL touching these is confined to the scoped layer. */
export const TENANT_TABLES = [
  'task',
  'dispatch_job',
  'routing_decision',
  'pull_request',
  'platform_connection',
  'webhook_event',
  'proposal',
  'usage_event',
] as const;

/**
 * The ONLY files allowed to contain raw tenant-table SQL (repo-relative, POSIX slashes):
 * the org-scoped store + the queue/claim repos (their methods are required-orgId or are the
 * trusted cross-org worker paths) + the DDL. Everything else must go through the store.
 */
export const SCOPED_LAYER = new Set([
  'packages/coordination/src/store.ts',
  'packages/coordination/src/schema.ts',
  'packages/db/src/dispatch-queue.ts',
  'packages/db/src/claim-repo.ts',
  'packages/db/src/schema.ts',
]);

export interface OrgScopingViolation {
  file: string;
  line: number;
  table: string;
  snippet: string;
}

// SQL that references a tenant table after a DML/DDL keyword. Case-insensitive; matches
// FROM/JOIN/INTO/UPDATE/DELETE FROM/TRUNCATE [TABLE] <table>, where <table> may be quoted
// ("task") and/or schema-qualified (public.task). The `\s+` spans newlines (so a query
// split as `FROM\n  task` is still caught — the scan is over the whole comment-stripped
// file, not line-by-line). Heuristic (source-text, not a parser) — deliberately
// conservative: the scoped layer is exempt, so a false positive only ever means "move this
// SQL into the store", never a silent miss. The `g` flag is added per-scan.
const TENANT_SQL_RE = new RegExp(
  `\\b(?:from|join|into|update|delete\\s+from|truncate(?:\\s+table)?)\\s+"?(?:\\w+\\.)?"?(${TENANT_TABLES.join('|')})"?\\b`,
  'i'
);

/** Replace comments with same-length whitespace (newlines preserved, so byte offsets and
 *  line numbers are unchanged) — so prose like "derived from task labels" or dead SQL in a
 *  comment never matches, without a fragile per-line comment heuristic. */
function blankComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Scan one file's source for tenant-table SQL. Returns [] for the scoped layer + test
 *  files (tests legitimately seed data with raw SQL); violations otherwise. */
export function scanSourceForTenantSql(content: string, relPath: string): OrgScopingViolation[] {
  const norm = relPath.split(path.sep).join('/');
  if (SCOPED_LAYER.has(norm) || norm.endsWith('.test.ts')) return [];
  const violations: OrgScopingViolation[] = [];
  const scanned = blankComments(content);
  const sourceLines = content.split('\n');
  const re = new RegExp(TENANT_SQL_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(scanned)) !== null) {
    const line = scanned.slice(0, m.index).split('\n').length; // 1-based
    violations.push({ file: norm, line, table: m[1]!.toLowerCase(), snippet: (sourceLines[line - 1] ?? m[0]).trim() });
  }
  return violations;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Scan every package's src/ for tenant-table SQL outside the scoped layer. */
export function findOrgScopingViolations(root: string): OrgScopingViolation[] {
  const pkgsDir = path.join(root, 'packages');
  const violations: OrgScopingViolation[] = [];
  let pkgs: string[];
  try {
    pkgs = readdirSync(pkgsDir);
  } catch {
    return [];
  }
  for (const pkg of pkgs) {
    const srcDir = path.join(pkgsDir, pkg, 'src');
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listTsFiles(srcDir)) {
      const rel = path.relative(root, file);
      violations.push(...scanSourceForTenantSql(readFileSync(file, 'utf8'), rel));
    }
  }
  return violations;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const violations = findOrgScopingViolations(REPO_ROOT);
  if (violations.length === 0) {
    console.log('org-scoping check: OK (tenant SQL confined to the scoped layer)');
    return;
  }
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}: raw SQL on tenant table '${v.table}' outside the scoped layer — route it through the org-scoped store methods (or add the file to SCOPED_LAYER if it is part of it).\n    ${v.snippet}`
    );
  }
  console.error(`org-scoping check: ${violations.length} ungoverned tenant-SQL site(s)`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
