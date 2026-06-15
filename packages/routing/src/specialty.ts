import {
  EXTENSION_TO_SPECIALTY,
  SPECIALTY_SYNONYMS,
  isLanguageSpecialty,
  isFrameworkSpecialty,
} from '@tasca/domain';

// File-mention machinery, mirrored from tier.ts so the specialty deriver and the tier scope-hint agree on
// what counts as a "file" — a token like `src/foo.py` (a path, or a bare `name.ext` with a known code/config
// extension), NOT prose abbreviations (`e.g.`) or version strings (`v1.2`). The regex is anchored and tested
// PER whitespace token, so backtracking is bounded to one short token (ReDoS-safe on untrusted webhook text).
const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go', 'rs', 'java', 'rb', 'php',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'swift', 'kt', 'kts', 'scala', 'ex',
  'exs', 'erl', 'clj', 'lua', 'dart', 'mm', 'pl', 'groovy', 'vue', 'svelte', 'astro',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'json', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'cfg', 'properties',
  'gradle', 'tf', 'proto', 'graphql', 'gql', 'lock', 'dockerfile',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'md', 'mdx', 'rst', 'txt',
];
const FILE_MENTION_RE = new RegExp(`^[\\w-]+(?:[./][\\w-]+)*\\.(?:${FILE_EXTENSIONS.join('|')})$`);

// Synonym keys that contain a dot (`.net`, `node.js`) cannot survive a non-word-char tokenize — scan them
// against the raw lowercased title separately so the alias still resolves.
const DOTTED_SYNONYMS = Object.keys(SPECIALTY_SYNONYMS).filter((k) => k.includes('.'));

/**
 * Derive the specialties a task REQUIRES, for the EM router's specialty filter (EM v1 slice 2). Two passes,
 * deliberately narrow — body PROSE judgment is deferred to an LLM fast-follow (#370), so this stays to
 * structured, taxonomy-bound signals only:
 *
 *  - Extension pass (title + body): a file mention's extension is a precise requirement wherever it appears,
 *    so both fields are scanned. `src/foo.py` ⇒ python.
 *  - Keyword pass (TITLE ONLY): a bare taxonomy term or known alias in the TITLE is a deliberate requirement.
 *    The body is NOT keyword-scanned — "this is the Python module" in a body is prose, not a requirement; a
 *    title-only rule avoids hand-rolling fragile body string-rules (that nuance is #370's job). There is no
 *    negation guard either: "Migrate off Python to Go" derives BOTH — acceptable, because the no-fit reason
 *    NAMES the derived specialty (operator-correctable) and #370 will read prose intent.
 *
 * No signal ⇒ `[]`, which passes ALL agents downstream (the inviolable backstop). Pure, no I/O.
 */
export function deriveRequiredSpecialties(content: { title: string; body?: string }): string[] {
  const found = new Set<string>();

  // Extension pass — title + body, per whitespace token (strip surrounding punctuation so `(src/foo.ts),`
  // still matches), mirroring tier.ts's linear per-token test.
  const fileText = `${content.title} ${content.body ?? ''}`.toLowerCase();
  for (const raw of fileText.split(/\s+/)) {
    const tok = raw.replace(/^[^\w]+|[^\w]+$/g, '');
    if (!tok || !FILE_MENTION_RE.test(tok)) continue;
    const ext = tok.slice(tok.lastIndexOf('.') + 1);
    const spec = EXTENSION_TO_SPECIALTY[ext];
    if (spec) found.add(spec);
  }

  // Keyword pass — TITLE ONLY. Tokenize on non-word chars; a token that is a taxonomy term or a (word-form)
  // synonym key is a requirement.
  const title = content.title.toLowerCase();
  for (const tok of title.split(/[^\w]+/)) {
    if (!tok) continue;
    if (isLanguageSpecialty(tok) || isFrameworkSpecialty(tok)) found.add(tok);
    const syn = SPECIALTY_SYNONYMS[tok];
    if (syn) found.add(syn);
  }
  // Dotted aliases (`.net`, `node.js`) don't survive tokenizing — match them on the raw title.
  for (const key of DOTTED_SYNONYMS) {
    if (title.includes(key)) found.add(SPECIALTY_SYNONYMS[key]!);
  }

  return [...found];
}
