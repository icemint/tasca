import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ALLOWLIST, extractTascaImports, findUngovernedPackages, findViolations, scanRepo } from './check-boundaries';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('extractTascaImports', () => {
  it('finds static + dynamic @tasca imports, ignores prose in comments', () => {
    const src = `
      import { X } from '@tasca/domain';
      import type { Y } from "@tasca/contracts";
      export { Z } from '@tasca/routing';
      const m = await import('@tasca/db');
      // this file does NOT import @tasca/coordination
      /* nor @tasca/adapters per the boundary */
      const url = 'https://example/@tasca/execution'; // a string, not an import
    `;
    const found = extractTascaImports(src).sort();
    expect(found).toEqual(['contracts', 'db', 'domain', 'routing']);
    expect(found).not.toContain('coordination'); // comment mention not counted
    expect(found).not.toContain('adapters');
  });

  it('also catches require() (cjs interop)', () => {
    expect(extractTascaImports(`const x = require('@tasca/identity');`)).toEqual(['identity']);
  });
});

describe('findViolations', () => {
  it('flags an import outside the package allowlist', () => {
    const v = findViolations([
      { pkg: 'adapters', file: 'packages/adapters/src/x.ts', imported: 'routing' },
      { pkg: 'routing', file: 'packages/routing/src/y.ts', imported: 'db' },
    ]);
    expect(v.map((x) => `${x.pkg}->${x.imported}`)).toEqual(['adapters->routing', 'routing->db']);
  });

  it('allows in-allowlist + self imports, and lets coordination import anything', () => {
    expect(
      findViolations([
        { pkg: 'adapters', file: 'a', imported: 'contracts' },
        { pkg: 'adapters', file: 'a', imported: 'adapters' },
        { pkg: 'coordination', file: 'c', imported: 'execution' },
        { pkg: 'coordination', file: 'c', imported: 'adapters' },
      ])
    ).toEqual([]);
  });

  it('forbids anyone importing coordination (it is the root, not a dependency)', () => {
    // No package lists `coordination` in its allowlist, so any such import flags.
    for (const pkg of Object.keys(ALLOWLIST)) {
      if (pkg === 'coordination') continue;
      expect(findViolations([{ pkg, file: 'f', imported: 'coordination' }])).toHaveLength(1);
    }
  });
});

describe('the real repository', () => {
  it('has zero boundary violations on main', () => {
    const violations = findViolations(scanRepo(REPO_ROOT));
    // Print them if any, so a regression is actionable from the test output.
    expect(violations.map((v) => `${v.file}: @tasca/${v.imported}`)).toEqual([]);
  });

  it('governs every package (each packages/*/src is in ALLOWLIST)', () => {
    // Fails when a new package is added without declaring its boundary — closing
    // the silently-ungoverned false-negative.
    expect(findUngovernedPackages(REPO_ROOT)).toEqual([]);
  });
});
