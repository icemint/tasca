import { useState } from "react";
import { Navigate, useParams } from "@tanstack/react-router";
import {
  RobotIcon,
  PulseIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { cn } from "@/shared/lib/utils";
import { useFlag } from "@/shared/flags";

/**
 * Run View page — SCAFFOLD (design-system `run.html`).
 *
 * Gated behind `flag.run_view` (off by default); when off the route redirects
 * back to the board. It is a pure empty shell: the three zones (header /
 * transcript / logs) render only their chrome + empty states. It deliberately
 * does NOT mount the live execution-process providers or the transcript-entry
 * components (those need a workspace session + host context); the approval-gate
 * card and conversation entries appear inline in the transcript only when there
 * is real execution data, which lands with the M1 run engine. No seeded rows.
 */

const LOG_TABS = ["stdout", "stderr"] as const;
type LogTab = (typeof LOG_TABS)[number];

export function RunViewPage() {
  const enabled = useFlag("run_view");
  const { projectId } = useParams({ strict: false });
  const [activeTab, setActiveTab] = useState<LogTab>("stdout");

  if (!enabled) {
    // Reachable only by direct URL while the flag is off — send back to board.
    return projectId ? (
      <Navigate to="/projects/$projectId" params={{ projectId }} replace />
    ) : (
      <Navigate to="/" replace />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* Header */}
      <header className="flex flex-none items-center gap-3 border-b border-line px-6 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface-2 text-fg-3">
          <RobotIcon size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-fg">Run</h1>
          <p className="truncate text-xs text-fg-3">Agent run transcript</p>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2 py-1 text-xs font-medium text-fg-3">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-exec-idle"
          />
          No active run
        </span>
      </header>

      {/* Transcript */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-xl border border-line bg-surface-2 text-fg-4">
          <PulseIcon size={22} aria-hidden />
        </span>
        <p className="text-sm font-medium text-fg-2">No run activity yet</p>
        <p className="max-w-sm text-xs text-fg-3">
          The transcript, tool calls, and approval prompts will appear here once
          a run starts.
        </p>
      </div>

      {/* Logs */}
      <section
        aria-label="Run logs"
        className="flex-none border-t border-line bg-bg-sub"
      >
        <div className="flex items-center gap-1 px-6 pt-2.5" role="tablist">
          {LOG_TABS.map((tab) => {
            const on = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "rounded-t-sm px-2.5 py-1 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
                  on
                    ? "bg-surface-2 text-fg"
                    : "text-fg-3 hover:text-fg-2",
                )}
              >
                {tab}
              </button>
            );
          })}
        </div>
        <div className="max-h-[180px] overflow-y-auto px-6 py-4">
          <p className="flex items-center gap-2 font-mono text-xs text-fg-3">
            <TerminalWindowIcon size={14} aria-hidden />
            No {activeTab} output yet.
          </p>
        </div>
      </section>
    </div>
  );
}
