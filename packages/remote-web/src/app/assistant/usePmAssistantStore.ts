import { create } from "zustand";

/**
 * Open/close state for the PM-assistant side panel. Kept tiny and ephemeral
 * (not persisted) — the panel itself is a flag-gated scaffold (flag.pm_assistant,
 * off by default) until the M3 server-side SSE proxy lands.
 */
type PmAssistantState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
};

export const usePmAssistantStore = create<PmAssistantState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
