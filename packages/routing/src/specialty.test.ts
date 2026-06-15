import { describe, it, expect } from 'vitest';
import { deriveRequiredSpecialties } from './specialty';

describe('deriveRequiredSpecialties', () => {
  it('derives a language from a file PATH in the body (extension pass scans title + body)', () => {
    // A file path is a precise, structured signal even in the body — distinct from prose.
    expect(deriveRequiredSpecialties({ title: 'fix', body: 'edit src/foo.py' })).toEqual(['python']);
  });

  it('derives a framework from a TITLE keyword', () => {
    expect(deriveRequiredSpecialties({ title: 'Add a React component' })).toEqual(['react']);
  });

  it('resolves a TITLE synonym to the canonical term', () => {
    expect(deriveRequiredSpecialties({ title: 'fix the py script' })).toEqual(['python']);
  });

  it('resolves a dotted synonym in the title (.net ⇒ dotnet)', () => {
    expect(deriveRequiredSpecialties({ title: 'port the .net service' })).toEqual(['dotnet']);
  });

  it('returns the deduped union across passes', () => {
    // Title names typescript + react; body path names typescript again — union deduped.
    const out = deriveRequiredSpecialties({
      title: 'Add a React typescript widget',
      body: 'touch src/widget.ts',
    });
    expect(out.sort()).toEqual(['react', 'typescript']);
  });

  it('no signal ⇒ [] (the inviolable backstop — passes ALL agents downstream)', () => {
    expect(deriveRequiredSpecialties({ title: 'Fix the bug', body: 'general cleanup' })).toEqual([]);
  });

  it('TITLE-ONLY: a body keyword does NOT trigger (body prose is not scanned)', () => {
    // "this is the Python module" is prose in the body — the keyword pass scans the TITLE only, so no
    // requirement is derived. Body prose judgment is deferred to the LLM fast-follow (#370).
    expect(deriveRequiredSpecialties({ title: 'Fix the bug', body: 'this is the Python module' })).toEqual([]);
  });

  it('no negation guard: a title with both languages derives BOTH (documented, accepted)', () => {
    // "Migrate off Python to Go" reads (to a human) as "Go only", but title-only + no negation guard
    // derives both. This is intentional for slice 2: the no-fit reason NAMES the derived specialty
    // (operator-correctable) and the LLM fast-follow (#370) handles the prose nuance.
    const out = deriveRequiredSpecialties({ title: 'Migrate off Python to Go' });
    expect(out.sort()).toEqual(['go', 'python']);
  });
});
