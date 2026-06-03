import { useMemo, type ReactNode } from 'react';
import { useUserOrganizations } from '@/shared/hooks/useUserOrganizations';
import { useOrganizationStore } from '@/shared/stores/useOrganizationStore';
import { FlagsProvider } from './FlagsProvider';
import { FLAG_NAMES, type FlagName } from './flags';

/**
 * Reads the currently-selected org's `feature_flags` and threads them into
 * {@link FlagsProvider}. Resolution stays org → env → default-off.
 *
 * `feature_flags` is typed `JsonValue` on the wire, so we narrow defensively:
 * only boolean values under known flag names survive into `orgFlags`. A missing
 * or non-boolean key stays `undefined`, which lets the env override (and the
 * all-off default) still apply — so a dev `VITE_FLAG_*=1` is never clobbered by
 * an empty org. Only an org's EXPLICIT `false` overrides a dev env `true`.
 *
 * When signed-out the orgs query is disabled (`data` undefined), so `orgFlags`
 * is undefined and env/default-off apply.
 */
export function OrgFlagsProvider({ children }: { children: ReactNode }) {
  const { data } = useUserOrganizations();
  const selectedOrgId = useOrganizationStore((s) => s.selectedOrgId);

  const orgFlags = useMemo<
    Partial<Record<FlagName, boolean>> | undefined
  >(() => {
    const org = data?.organizations.find((o) => o.id === selectedOrgId);
    const ff = org?.feature_flags;
    if (!ff || typeof ff !== 'object' || Array.isArray(ff)) return undefined;
    const record = ff as Record<string, unknown>;
    const out: Partial<Record<FlagName, boolean>> = {};
    for (const name of FLAG_NAMES) {
      if (typeof record[name] === 'boolean') out[name] = record[name] as boolean;
    }
    return Object.keys(out).length ? out : undefined;
  }, [data, selectedOrgId]);

  return <FlagsProvider orgFlags={orgFlags}>{children}</FlagsProvider>;
}
