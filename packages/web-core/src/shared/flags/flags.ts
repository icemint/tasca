/**
 * Tasca app feature flags.
 *
 * Every flag defaults **off**. Resolution order (first wins):
 *   1. env override  — VITE_FLAG_<NAME> ("1"/"true" → on, "0"/"false" → off).
 *      Build-time only (Vite inlines import.meta.env at build); developer/CI use.
 *   2. org settings  — flags returned by the organization (real backend)
 *   3. default off
 *
 * GUARDRAIL: a flag may only be turned on in an environment where its named
 * endpoint/table returns *real* data. No flagged component may render seeded or
 * sample rows — only empty / loading / error states (states.css) are allowed as
 * placeholder content. See the build-now vs flag-scaffold split in the app
 * implementation plan (design-system/IMPLEMENTATION-PLAN.md).
 */
export const FLAG_NAMES = [
  'tiers', // M1 — issues.complexity_tier, tier policy, required-fields gate
  'agents', // M1 — synthetic member_kind='agent', agents registry
  'sprints', // M1 — sprints table
  'run_view', // M1 — execution_processes + approval gate + SSE
  'audit_timeline', // M1/M3 — issue_events / audit_log
  'github_pr', // M4 — issue_pull_requests, project_github_repos, webhook linker
  'sandbox', // M5 — trust-tier + sandbox_profile badges
  'pm_assistant', // M3 — organization_ai_keys + server-side SSE proxy
  'roles', // M2 — member_role enum (owner/admin/member/guest)
  'guest', // M5 — trust_state + can_trigger_execution(role)
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type Flags = Record<FlagName, boolean>;

export const DEFAULT_FLAGS: Flags = FLAG_NAMES.reduce((acc, name) => {
  acc[name] = false;
  return acc;
}, {} as Flags);

function envOverride(name: FlagName): boolean | undefined {
  // Vite inlines import.meta.env at build; vite/client types give it an index
  // signature. Only explicit on/off values count — anything else (typo like
  // "TRUE"/"yes") falls through to the org layer rather than silently disabling.
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = env[`VITE_FLAG_${name.toUpperCase()}`];
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  if (raw !== undefined) console.warn(`[flags] ignoring unrecognized VITE_FLAG_${name.toUpperCase()}="${raw}" (use 1/0/true/false)`);
  return undefined;
}

/** Merge env overrides over org-provided flags over the all-off default. */
export function resolveFlags(orgFlags?: Partial<Record<FlagName, boolean>>): Flags {
  const out = { ...DEFAULT_FLAGS };
  for (const name of FLAG_NAMES) {
    const env = envOverride(name);
    if (env !== undefined) out[name] = env;
    else if (orgFlags?.[name] !== undefined) out[name] = Boolean(orgFlags[name]);
  }
  return out;
}
