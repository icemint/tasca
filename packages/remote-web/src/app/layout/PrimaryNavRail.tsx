import { useMemo, type ComponentType } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  KanbanIcon,
  RobotIcon,
  LightningIcon,
  GearIcon,
  type IconProps,
} from "@phosphor-icons/react";
import { cn } from "@/shared/lib/utils";
import { useFlags } from "@/shared/flags";
import { SettingsDialog } from "@/shared/dialogs/settings/SettingsDialog";

/**
 * Far-left primary navigation rail (design-system `app.html .rail`).
 *
 * Distinct from the workspace `AppBar` (projects/hosts), which stays separate
 * per the app-shell decision. This rail is the top-level destination switcher:
 *   - Board    — always present
 *   - Agents   — gated behind `flags.agents`  (unbuilt → hidden by default)
 *   - Sprints  — gated behind `flags.sprints` (unbuilt → hidden by default)
 *   - Settings — always present, opens the existing SettingsDialog
 *
 * Flag-gated items are removed from the tree entirely when off (not just
 * dimmed), so no half-built destination is ever reachable. When a flag IS
 * enabled but the destination view/route does not exist yet, the item renders
 * as a non-interactive "coming soon" placeholder — it never points at a
 * fabricated or mismatched destination. The later ticket that builds the view
 * replaces `comingSoon` with a real `onClick` navigate target. "My issues" is
 * omitted entirely until its view exists.
 */

type RailIcon = ComponentType<IconProps>;

interface RailItemProps {
  icon: RailIcon;
  label: string;
  active?: boolean;
  /** When set, the item is shown but inert (no real destination yet). */
  comingSoon?: boolean;
  onClick?: () => void;
}

function RailItem({
  icon: Icon,
  label,
  active = false,
  comingSoon = false,
  onClick,
}: RailItemProps) {
  return (
    <button
      type="button"
      disabled={comingSoon}
      title={comingSoon ? `${label} — coming soon` : label}
      aria-label={comingSoon ? `${label} (coming soon)` : label}
      aria-current={active ? "page" : undefined}
      onClick={comingSoon ? undefined : onClick}
      className={cn(
        "grid h-10 w-10 place-items-center rounded-md transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
        comingSoon
          ? "cursor-default text-fg-faint"
          : active
            ? "cursor-pointer bg-surface-2 text-signal"
            : "cursor-pointer text-fg-3 hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon size={20} weight={active ? "fill" : "regular"} aria-hidden />
    </button>
  );
}

function RailBrandMark() {
  // Three kanban columns — page ink, brand signal, amber accent. Fills resolve
  // from the design-token bridge (full hsl() values); --fg-4/--signal/--amber
  // are theme-defined, so no hardcoded color.
  return (
    <div
      className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface"
      aria-hidden
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="2" width="3.4" height="14" rx="1.2" fill="var(--fg-4)" />
        <rect x="7.3" y="2" width="3.4" height="10.5" rx="1.2" fill="var(--signal)" />
        <rect x="13.6" y="2" width="3.4" height="7" rx="1.2" fill="var(--amber)" />
      </svg>
    </div>
  );
}

export function PrimaryNavRail() {
  const navigate = useNavigate();
  const location = useLocation();
  const flags = useFlags();

  const isBoardActive = useMemo(
    () => location.pathname === "/" || location.pathname.startsWith("/projects/"),
    [location.pathname],
  );

  return (
    <nav
      aria-label="Primary"
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-bg py-3"
    >
      <div className="mb-2">
        <RailBrandMark />
      </div>

      <RailItem
        icon={KanbanIcon}
        label="Board"
        active={isBoardActive}
        onClick={() => navigate({ to: "/" })}
      />
      {/* Agents/Sprints views don't exist yet — shown (when flagged) as inert
          placeholders, never wired to a stand-in destination. */}
      {flags.agents && <RailItem icon={RobotIcon} label="Agents" comingSoon />}
      {flags.sprints && (
        <RailItem icon={LightningIcon} label="Sprints" comingSoon />
      )}

      <div className="mt-auto">
        <RailItem
          icon={GearIcon}
          label="Settings"
          onClick={() => void SettingsDialog.show()}
        />
      </div>
    </nav>
  );
}
