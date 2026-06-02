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
 * dimmed), so no half-built destination is ever reachable. "My issues" is
 * intentionally omitted until its view exists — we don't link a nav item to a
 * nonexistent route.
 */

type RailIcon = ComponentType<IconProps>;

interface RailItemProps {
  icon: RailIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}

function RailItem({ icon: Icon, label, active = false, onClick }: RailItemProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "grid h-10 w-10 place-items-center rounded-md transition-colors cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
        active
          ? "bg-surface-2 text-signal"
          : "text-fg-3 hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon size={20} weight={active ? "fill" : "regular"} aria-hidden />
    </button>
  );
}

function RailBrandMark() {
  // Three kanban columns — page ink, brand signal, amber accent. Fills resolve
  // from the design-token bridge (full hsl() values), so no hardcoded color.
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
      {flags.agents && (
        <RailItem
          icon={RobotIcon}
          label="Agents"
          onClick={() => void SettingsDialog.show()}
        />
      )}
      {flags.sprints && (
        <RailItem
          icon={LightningIcon}
          label="Sprints"
          onClick={() => void SettingsDialog.show()}
        />
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
