import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import type { ReactNode } from 'react';
import {
  LayoutIcon,
  DownloadSimpleIcon,
  LinkIcon,
  PlusIcon,
  KanbanIcon,
  SpinnerIcon,
  StarIcon,
  type Icon,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { AppBarSocialLink } from './AppBarSocialLink';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
} from './Popover';
import { Tooltip } from './Tooltip';
import { useTranslation } from 'react-i18next';

function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return k >= 10 ? `${Math.floor(k)}k` : `${k.toFixed(1)}k`;
}

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';

  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

interface AppBarProps {
  projects: AppBarProject[];
  hosts?: AppBarHost[];
  onPairHostClick?: () => void;
  activeHostId?: string | null;
  onCreateProject: () => void;
  onExportClick?: () => void;
  onWorkspacesClick: () => void;
  onHostClick?: (hostId: string, status: AppBarHostStatus) => void;
  showWorkspacesButton?: boolean;
  onProjectClick: (projectId: string) => void;
  onProjectsDragEnd: (result: DropResult) => void;
  isSavingProjectOrder?: boolean;
  isWorkspacesActive: boolean;
  isExportActive?: boolean;
  activeProjectId: string | null;
  isSignedIn?: boolean;
  isLoadingProjects?: boolean;
  onSignIn?: () => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  notificationBell?: ReactNode;
  userPopover?: ReactNode;
  starCount?: number | null;
  appVersion?: string | null;
  updateVersion?: string | null;
  onUpdateClick?: () => void;
  githubIconPath: string;
}

export interface AppBarProject {
  id: string;
  name: string;
  color: string;
}

export type AppBarHostStatus = 'online' | 'offline' | 'unpaired';

export interface AppBarHost {
  id: string;
  name: string;
  status: AppBarHostStatus;
}

function getHostStatusLabel(status: AppBarHostStatus): string {
  if (status === 'online') return 'Online';
  if (status === 'offline') return 'Offline';
  return 'Unpaired';
}

function getHostStatusIndicatorClass(status: AppBarHostStatus): string {
  if (status === 'online') return 'bg-green';
  if (status === 'offline') return 'bg-fg-faint';
  return 'bg-surface border-amber';
}

function AppBarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="w-10 text-center text-[9px] font-medium leading-none tracking-wide text-fg-3">
      {children}
    </p>
  );
}

const appBarItemBaseClassName =
  'flex items-center justify-center w-10 h-10 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal';

type AppBarSection = {
  key: 'local' | 'remote' | 'projects' | 'export';
  label: string;
  items: AppBarSectionItem[];
};

type AppBarSectionItem =
  | {
      key: string;
      kind: 'icon-button';
      label: string;
      icon: Icon;
      isActive?: boolean;
      onClick?: () => void;
      className?: string;
      wrapperClassName?: string;
    }
  | {
      key: string;
      kind: 'host-button';
      host: AppBarHost;
      isActive: boolean;
      onClick?: () => void;
      wrapperClassName?: string;
    }
  | {
      key: string;
      kind: 'kanban-cta';
      label: string;
      onSignIn?: () => void;
    }
  | {
      key: string;
      kind: 'loading';
    }
  | {
      key: string;
      kind: 'project-list';
      projects: AppBarProject[];
      activeProjectId: string | null;
      isSavingProjectOrder?: boolean;
      onProjectClick: (projectId: string) => void;
      onProjectsDragEnd: (result: DropResult) => void;
    };

function getStandardAppBarButtonClassName({
  isActive = false,
  className,
}: {
  isActive?: boolean;
  className?: string;
}) {
  return cn(
    appBarItemBaseClassName,
    'cursor-pointer',
    isActive
      ? 'bg-signal/20 text-signal hover:bg-signal/20'
      : 'bg-surface text-fg-2 hover:bg-signal/10',
    className
  );
}

function getHostButtonClassName({
  host,
  isActive,
}: {
  host: AppBarHost;
  isActive: boolean;
}) {
  const isOffline = host.status === 'offline';

  return cn(
    appBarItemBaseClassName,
    isOffline
      ? 'bg-surface text-fg-3 opacity-50 cursor-not-allowed'
      : isActive
        ? 'bg-signal/20 text-signal cursor-pointer hover:bg-signal/20'
        : host.status === 'unpaired'
          ? 'bg-surface text-amber cursor-pointer hover:bg-amber/10'
          : 'bg-surface text-fg-2 cursor-pointer hover:bg-signal/10'
  );
}

export function AppBar({
  projects,
  hosts = [],
  onPairHostClick,
  activeHostId = null,
  onCreateProject,
  onExportClick,
  onWorkspacesClick,
  onHostClick,
  showWorkspacesButton = true,
  onProjectClick,
  onProjectsDragEnd,
  isSavingProjectOrder,
  isWorkspacesActive,
  isExportActive = false,
  activeProjectId,
  isSignedIn,
  isLoadingProjects,
  onSignIn,
  onHoverStart,
  onHoverEnd,
  notificationBell,
  userPopover,
  starCount,
  appVersion,
  updateVersion,
  onUpdateClick,
  githubIconPath,
}: AppBarProps) {
  const { t } = useTranslation('common');
  const sections: AppBarSection[] = [];

  if (showWorkspacesButton) {
    sections.push({
      key: 'local',
      label: 'Local',
      items: [
        {
          key: 'local-workspaces',
          kind: 'icon-button',
          label: 'Local workspaces',
          icon: LayoutIcon,
          isActive: isWorkspacesActive,
          onClick: onWorkspacesClick,
        },
      ],
    });
  }

  if (hosts.length > 0 || onPairHostClick) {
    sections.push({
      key: 'remote',
      label: 'Remote',
      items: [
        ...hosts.map((host) => ({
          key: `host-${host.id}`,
          kind: 'host-button' as const,
          host,
          isActive: host.id === activeHostId,
          onClick: () => {
            if (host.status === 'offline') {
              return;
            }

            onHostClick?.(host.id, host.status);
          },
        })),
        ...(onPairHostClick
          ? [
              {
                key: 'pair-remote-device',
                kind: 'icon-button' as const,
                label: 'Pair a remote device',
                icon: LinkIcon,
                onClick: onPairHostClick,
                className:
                  'bg-surface text-fg-3 hover:text-fg-2 hover:bg-surface-3',
              },
            ]
          : []),
      ],
    });
  }

  const projectSectionItems: AppBarSectionItem[] = [];

  if (!isSignedIn) {
    projectSectionItems.push({
      key: 'kanban-cta',
      kind: 'kanban-cta',
      label: t('appBar.kanban.tooltip'),
      onSignIn,
    });
  }

  if (isLoadingProjects) {
    projectSectionItems.push({ key: 'projects-loading', kind: 'loading' });
  }

  if (projects.length > 0) {
    projectSectionItems.push({
      key: 'project-list',
      kind: 'project-list',
      projects,
      activeProjectId,
      isSavingProjectOrder,
      onProjectClick,
      onProjectsDragEnd,
    });
  }

  if (isSignedIn) {
    projectSectionItems.push({
      key: 'create-project',
      kind: 'icon-button',
      label: 'Create project',
      icon: PlusIcon,
      onClick: onCreateProject,
      className: 'bg-surface text-fg-3 hover:text-fg-2 hover:bg-surface-3',
      wrapperClassName: 'pt-base',
    });
  }

  if (projectSectionItems.length > 0) {
    sections.push({
      key: 'projects',
      label: 'Projects',
      items: projectSectionItems,
    });
  }

  if (isSignedIn && onExportClick) {
    sections.push({
      key: 'export',
      label: 'Export',
      items: [
        {
          key: 'export-data',
          kind: 'icon-button',
          label: 'Export data',
          icon: DownloadSimpleIcon,
          isActive: isExportActive,
          onClick: onExportClick,
        },
      ],
    });
  }

  function renderSectionItem(item: AppBarSectionItem): ReactNode {
    switch (item.kind) {
      case 'icon-button':
        return (
          <Tooltip content={item.label} side="right">
            <button
              type="button"
              onClick={item.onClick}
              className={getStandardAppBarButtonClassName({
                isActive: item.isActive,
                className: item.className,
              })}
              aria-label={item.label}
            >
              <item.icon className="size-icon-base" weight="bold" />
            </button>
          </Tooltip>
        );
      case 'host-button': {
        const isOffline = item.host.status === 'offline';

        return (
          <Tooltip
            content={`${item.host.name} · ${getHostStatusLabel(item.host.status)}`}
            side="right"
          >
            <div className="relative">
              <span
                className={cn(
                  'absolute -top-1 -right-1 z-10',
                  'w-3.5 h-3.5 rounded-full border border-line',
                  getHostStatusIndicatorClass(item.host.status)
                )}
                aria-hidden="true"
              />
              <button
                type="button"
                disabled={isOffline}
                onClick={item.onClick}
                className={getHostButtonClassName({
                  host: item.host,
                  isActive: item.isActive,
                })}
                aria-label={`${item.host.name} (${getHostStatusLabel(item.host.status)})`}
              >
                {getProjectInitials(item.host.name)}
              </button>
            </div>
          </Tooltip>
        );
      }
      case 'kanban-cta':
        return (
          <Popover>
            <Tooltip content={item.label} side="right">
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={getStandardAppBarButtonClassName({})}
                  aria-label={item.label}
                >
                  <KanbanIcon className="size-icon-base" weight="bold" />
                </button>
              </PopoverTrigger>
            </Tooltip>
            <PopoverContent side="right" sideOffset={8}>
              <p className="text-sm font-medium text-fg">
                {t('appBar.kanban.title')}
              </p>
              <p className="text-xs text-fg-3 mt-1">
                {t('appBar.kanban.description')}
              </p>
              <div className="mt-base">
                <PopoverClose asChild>
                  <button
                    type="button"
                    onClick={item.onSignIn}
                    className={cn(
                      'px-base py-1 rounded-sm text-xs',
                      'bg-signal text-on-signal hover:bg-signal-2 cursor-pointer'
                    )}
                  >
                    {t('signIn')}
                  </button>
                </PopoverClose>
              </div>
            </PopoverContent>
          </Popover>
        );
      case 'loading':
        return (
          <div className="flex items-center justify-center w-10 h-10">
            <SpinnerIcon className="size-5 animate-spin text-fg-3" />
          </div>
        );
      case 'project-list':
        return (
          <DragDropContext onDragEnd={item.onProjectsDragEnd}>
            <Droppable
              droppableId="app-bar-projects"
              direction="vertical"
              isDropDisabled={item.isSavingProjectOrder}
            >
              {(dropProvided) => (
                <div
                  ref={dropProvided.innerRef}
                  {...dropProvided.droppableProps}
                  className="flex flex-col items-center -mb-base"
                >
                  {item.projects.map((project, index) => (
                    <Draggable
                      key={project.id}
                      draggableId={project.id}
                      index={index}
                      disableInteractiveElementBlocking
                      isDragDisabled={item.isSavingProjectOrder}
                    >
                      {(dragProvided, snapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          className="mb-base"
                          style={dragProvided.draggableProps.style}
                        >
                          <Tooltip content={project.name} side="right">
                            <button
                              type="button"
                              onClick={() => item.onProjectClick(project.id)}
                              className={cn(
                                appBarItemBaseClassName,
                                'cursor-grab',
                                snapshot.isDragging && 'shadow-lg',
                                item.activeProjectId === project.id
                                  ? ''
                                  : 'bg-surface text-fg-2 hover:opacity-80'
                              )}
                              style={
                                item.activeProjectId === project.id
                                  ? {
                                      color: `hsl(${project.color})`,
                                      backgroundColor: `hsl(${project.color} / 0.2)`,
                                    }
                                  : undefined
                              }
                              aria-label={project.name}
                            >
                              {getProjectInitials(project.name)}
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {dropProvided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        );
    }
  }

  return (
    <div
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className={cn(
        'flex flex-col items-center h-full min-h-0 overflow-y-auto p-base gap-base',
        'bg-surface-2 border-r border-line'
      )}
    >
      {sections.map((section) => (
        <div key={section.key} className="flex flex-col items-center gap-1">
          <AppBarSectionLabel>{section.label}</AppBarSectionLabel>
          {section.items.map((item) => (
            <div
              key={item.key}
              className={
                'wrapperClassName' in item ? item.wrapperClassName : undefined
              }
            >
              {renderSectionItem(item)}
            </div>
          ))}
        </div>
      ))}

      {/* Bottom section: Notifications + User popover + GitHub */}
      <div className="mt-auto pt-base flex flex-col items-center gap-4">
        {notificationBell}
        {userPopover}
        <AppBarSocialLink
          href="https://github.com/icemint/tasca"
          label="Star on GitHub"
          iconPath={githubIconPath}
          badge={
            starCount != null && (
              <>
                <StarIcon size={10} weight="fill" />
                {formatStarCount(starCount)}
              </>
            )
          }
        />
        {updateVersion ? (
          <Tooltip content={`Update to v${updateVersion}`} side="right">
            <button
              type="button"
              onClick={onUpdateClick}
              className={cn(
                'flex items-center justify-center py-1 rounded-md w-10',
                'text-[9px] font-ibm-plex-mono font-medium leading-none',
                'bg-signal text-on-signal hover:bg-signal-2',
                'transition-colors cursor-pointer'
              )}
            >
              Update
            </button>
          </Tooltip>
        ) : (
          appVersion && (
            <p
              className="text-[9px] font-ibm-plex-mono text-fg-3 leading-none truncate max-w-10 text-center"
              title={`v${appVersion}`}
            >
              v{appVersion}
            </p>
          )
        )}
      </div>
    </div>
  );
}
