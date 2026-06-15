// Specialty taxonomy — a PROJECTION of @tasca/domain's LANGUAGE_SPECIALTIES / FRAMEWORK_SPECIALTIES,
// copied (not imported) so the static Astro app builds without pulling the workspace in (the app runs
// --ignore-workspace; contract.ts copies the wire shapes the same way). The SERVER is the authority:
// write-api.ts rejects any specialty not in @tasca/domain (a 400), so this list must stay in sync with
// packages/domain/src/index.ts — extend BOTH when adding a specialty. The stored/wire values are the
// lowercase tokens below; the editor offers ONLY these (a taxonomy-bound picker, never free text) so the
// EM router (issue 339) and the editor agree on the same terms.

/** Language specialty tokens (wire values) — mirrors @tasca/domain LANGUAGE_SPECIALTIES. */
export const LANGUAGE_SPECIALTIES = [
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'ruby', 'csharp', 'cpp', 'php', 'sql',
] as const;

/** Framework specialty tokens (wire values) — mirrors @tasca/domain FRAMEWORK_SPECIALTIES. */
export const FRAMEWORK_SPECIALTIES = [
  'react', 'vue', 'svelte', 'astro', 'node', 'express', 'fastify', 'nest', 'next', 'django', 'flask', 'rails', 'spring', 'dotnet',
] as const;

/** Human display labels for the lowercase taxonomy tokens (the chip + datalist text). The wire value
 *  stays the token; only the rendering is title-cased. A token without an entry falls back to itself. */
const SPECIALTY_LABEL: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java',
  kotlin: 'Kotlin', swift: 'Swift', ruby: 'Ruby', csharp: 'C#', cpp: 'C++', php: 'PHP', sql: 'SQL',
  react: 'React', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', node: 'Node', express: 'Express',
  fastify: 'Fastify', nest: 'NestJS', next: 'Next.js', django: 'Django', flask: 'Flask', rails: 'Rails',
  spring: 'Spring', dotnet: '.NET',
};

/** The human label for a specialty token (falls back to the token itself if unknown). */
export function specialtyLabel(token: string): string {
  return SPECIALTY_LABEL[token] ?? token;
}

/** True when a token is in the language taxonomy (the editor only accepts taxonomy values). */
export const isLanguageSpecialty = (s: string): boolean =>
  (LANGUAGE_SPECIALTIES as readonly string[]).includes(s);

/** True when a token is in the framework taxonomy. */
export const isFrameworkSpecialty = (s: string): boolean =>
  (FRAMEWORK_SPECIALTIES as readonly string[]).includes(s);
