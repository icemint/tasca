import { useCallback, useEffect, useRef } from "react";
import { SparkleIcon, XIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { cn } from "@/shared/lib/utils";
import { usePmAssistantStore } from "@remote/app/assistant/usePmAssistantStore";

/**
 * PM-assistant side panel — SCAFFOLD (design-system `app.html .assistant`).
 *
 * Gated behind `flag.pm_assistant` (off by default) and intentionally inert: the
 * conversation streams over a server-side SSE proxy that lands in M3, so this
 * renders only its chrome + an EMPTY state and a disabled composer. It never
 * renders the mockup's sample conversation — no seeded/sample rows, per the
 * no-seeded-data guardrail. When the M3 endpoint lands, the empty state and the
 * disabled composer are replaced with the live transcript + send wiring.
 */

/** Topbar/FAB toggle that opens the panel. Caller gates it behind the flag. */
export function PmAssistantToggle() {
  const toggle = usePmAssistantStore((s) => s.toggle);
  const isOpen = usePmAssistantStore((s) => s.isOpen);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      className="fixed bottom-4 right-4 z-[190] inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-semibold text-fg shadow-lg transition-colors hover:border-signal hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      <SparkleIcon size={16} aria-hidden />
      PM Assistant
    </button>
  );
}

export function PmAssistantPanel() {
  const isOpen = usePmAssistantStore((s) => s.isOpen);
  const close = usePmAssistantStore((s) => s.close);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // While closed, the panel stays mounted (so it can animate) but must be fully
  // removed from the tab order AND the accessibility tree — `inert` does both,
  // which `aria-hidden` + an off-screen transform alone do not (the buttons
  // would otherwise stay keyboard-focusable inside an aria-hidden subtree).
  // Clear inert BEFORE moving focus into the panel on open.
  useEffect(() => {
    const el = panelRef.current;
    if (el) {
      el.inert = !isOpen;
    }
    if (isOpen) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      closeBtnRef.current?.focus();
    } else {
      returnFocusRef.current?.focus?.();
    }
  }, [isOpen]);

  // Escape to close + a simple focus trap while open.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [close],
  );

  return (
    <>
      <div
        aria-hidden="true"
        onClick={close}
        className={cn(
          "fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm transition-opacity duration-200",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="PM Assistant"
        aria-hidden={!isOpen}
        onKeyDown={onKeyDown}
        className={cn(
          "fixed right-0 top-0 z-[210] flex h-screen w-96 max-w-[94vw] flex-col border-l border-line bg-surface transition-transform duration-200",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex flex-none items-center gap-2.5 border-b border-line px-[18px] py-[15px]">
          <span className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface-2 text-signal">
            <SparkleIcon size={15} aria-hidden />
          </span>
          <span className="text-sm font-semibold text-fg">PM Assistant</span>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label="Close PM Assistant"
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            <XIcon size={16} aria-hidden />
          </button>
        </header>

        {/* Empty state — no transcript until the M3 SSE proxy lands. */}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-[18px] text-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl border border-line bg-surface-2 text-fg-4">
            <SparkleIcon size={22} aria-hidden />
          </span>
          <p className="text-sm font-medium text-fg-2">
            The PM assistant isn’t connected yet
          </p>
          <p className="max-w-[15rem] text-xs text-fg-3">
            Decompose tickets, suggest a tier, and see what’s ready — coming soon.
          </p>
        </div>

        {/* Composer — present but inert (no endpoint to send to yet). */}
        <div className="flex-none border-t border-line px-4 py-3.5">
          <div className="flex items-center gap-2 rounded-[10px] border border-line-2 bg-surface-2 py-2 pl-[13px] pr-2 opacity-60">
            <input
              type="text"
              disabled
              aria-label="Message the PM assistant"
              placeholder="Ask about planning, tiers, what’s ready…"
              className="flex-1 border-none bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
            />
            <button
              type="button"
              disabled
              aria-label="Send message"
              className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-signal text-on-signal"
            >
              <PaperPlaneTiltIcon size={16} aria-hidden />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
