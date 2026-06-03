import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_FLAGS, resolveFlags, type FlagName, type Flags } from './flags';

const FlagsContext = createContext<Flags>(DEFAULT_FLAGS);

interface FlagsProviderProps {
  /** Flags from the current organization (real backend); org overrides env. */
  orgFlags?: Partial<Record<FlagName, boolean>>;
  children: ReactNode;
}

/** Provides resolved feature flags (org → env → default off) to the tree. */
export function FlagsProvider({ orgFlags, children }: FlagsProviderProps) {
  const value = useMemo(() => resolveFlags(orgFlags), [orgFlags]);
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}

/** Read a single feature flag. Defaults to false outside a provider. */
export function useFlag(name: FlagName): boolean {
  return useContext(FlagsContext)[name];
}

/** Read all resolved flags. */
export function useFlags(): Flags {
  return useContext(FlagsContext);
}
