import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { Project } from "shared/remote-types";
import type { OrganizationWithRole } from "shared/types";
import { listOrganizationProjects } from "@remote/shared/lib/api";
import { clearTokens } from "@remote/shared/lib/auth";
import { SettingsDialog } from "@/shared/dialogs/settings/SettingsDialog";
import { useOrganizationStore } from "@/shared/stores/useOrganizationStore";
import { useUserOrganizations } from "@/shared/hooks/useUserOrganizations";
import { useAuth } from "@/shared/hooks/auth/useAuth";
import { useIsMobile } from "@/shared/hooks/useIsMobile";
import {
  resolveRelayNavigationHostId,
  useRelayAppBarHosts,
} from "@remote/shared/hooks/useRelayAppBarHosts";

type OrganizationWithProjects = {
  organization: OrganizationWithRole;
  projects: Project[];
};

function getHostInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "??";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export default function HomePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/" });
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);
  const {
    data: orgsResponse,
    isLoading: orgsLoading,
    error: orgsError,
  } = useUserOrganizations();
  const organizations = orgsResponse?.organizations;
  const [items, setItems] = useState<OrganizationWithProjects[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isSignedIn } = useAuth();
  const { hosts } = useRelayAppBarHosts(isSignedIn);
  const isMobile = useIsMobile();
  const preferredHostId = useMemo(
    () => resolveRelayNavigationHostId(hosts),
    [hosts],
  );

  const openRelaySettings = useCallback((hostId?: string) => {
    void SettingsDialog.show({
      initialSection: "relay",
      ...(hostId ? { initialState: { hostId } } : {}),
    });
  }, []);

  useEffect(() => {
    const legacyOrgId = search.legacyOrgSettingsOrgId;
    if (!legacyOrgId) {
      return;
    }

    setSelectedOrgId(legacyOrgId);
    navigate({
      to: "/",
      search: {},
      replace: true,
    });

    void SettingsDialog.show({
      initialSection: "organizations",
      initialState: { organizationId: legacyOrgId },
    });
  }, [navigate, search.legacyOrgSettingsOrgId, setSelectedOrgId]);

  const handleSignInAgain = async () => {
    await clearTokens();
    navigate({
      to: "/account",
      replace: true,
    });
  };

  useEffect(() => {
    if (!organizations) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      setIsLoadingProjects(true);
      setError(null);

      try {
        const organizationsWithProjects = await Promise.all(
          organizations.map(async (organization) => {
            const projects = await listOrganizationProjects(organization.id);
            return {
              organization,
              projects: projects.sort((a, b) => a.sort_order - b.sort_order),
            };
          }),
        );

        if (!cancelled) {
          setItems(organizationsWithProjects);
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Failed to load organizations",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoadingProjects(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [organizations]);

  const loading = orgsLoading || isLoadingProjects;
  const displayError =
    error ??
    (orgsError
      ? orgsError instanceof Error
        ? orgsError.message
        : "Failed to load organizations"
      : null);

  if (loading) {
    return (
      <CenteredCard>
        <h1 className="text-lg font-semibold text-fg">Organizations</h1>
        <p className="mt-base text-sm text-fg-2" role="status" aria-live="polite">
          Loading organizations and projects...
        </p>
      </CenteredCard>
    );
  }

  if (displayError) {
    return (
      <CenteredCard>
        <h1 className="text-lg font-semibold text-fg">Failed to load</h1>
        <p className="mt-base text-sm text-fg-2" role="alert">
          {displayError}
        </p>
        <button
          type="button"
          className="mt-double rounded-sm bg-signal px-base py-half text-sm font-medium text-on-signal transition-colors hover:bg-signal-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          onClick={() => {
            void handleSignInAgain();
          }}
        >
          Sign in again
        </button>
      </CenteredCard>
    );
  }

  const organizationCount = items.length;
  const totalProjectCount = items.reduce(
    (count, item) => count + item.projects.length,
    0,
  );

  return (
    <div className="h-full overflow-auto bg-bg">
      <div className="mx-auto w-full max-w-6xl px-base py-base sm:px-double sm:py-double">
        {isMobile && isSignedIn && (
          <section className="mb-double">
            <h2 className="text-lg font-semibold text-fg">Your Hosts</h2>
            {hosts.length === 0 ? (
              <div className="mt-base rounded-sm border border-line bg-surface p-base text-center">
                <p className="text-sm text-fg-3">No hosts linked yet</p>
                <button
                  type="button"
                  className="mt-base rounded-sm border border-line bg-surface px-base py-half text-sm font-medium text-fg-2 hover:border-signal hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  onClick={() => {
                    openRelaySettings();
                  }}
                >
                  Link a host
                </button>
              </div>
            ) : (
              <div className="mt-base space-y-half">
                {hosts.map((host) => {
                  const isOnline = host.status === "online";
                  const isUnpaired = host.status === "unpaired";
                  const isClickable = isOnline || isUnpaired;

                  return (
                    <button
                      key={host.id}
                      type="button"
                      disabled={!isClickable}
                      className={`flex w-full items-center gap-base rounded-sm border border-line bg-surface px-base py-base text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal ${
                        isClickable
                          ? "hover:border-signal hover:bg-surface-2"
                          : "opacity-50"
                      }`}
                      onClick={() => {
                        if (isOnline) {
                          navigate({
                            to: "/hosts/$hostId/workspaces",
                            params: { hostId: host.id },
                          });
                        } else if (isUnpaired) {
                          openRelaySettings(host.id);
                        }
                      }}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-signal">
                        {getHostInitials(host.name)}
                      </div>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                        {host.name}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          isOnline
                            ? "bg-green"
                            : isUnpaired
                              ? "border border-amber bg-bg"
                              : "bg-fg-3"
                        }`}
                      />
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="flex w-full items-center justify-center rounded-sm border border-dashed border-line px-base py-half text-sm text-fg-3 hover:border-signal hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  onClick={() => {
                    openRelaySettings();
                  }}
                >
                  Link a host
                </button>
              </div>
            )}
          </section>
        )}

        <header className="space-y-half">
          <h1 className="text-2xl font-semibold text-fg">Organizations</h1>
          <p className="text-sm text-fg-3">
            {organizationCount}{" "}
            {organizationCount === 1 ? "organization" : "organizations"} •{" "}
            {totalProjectCount}{" "}
            {totalProjectCount === 1 ? "project" : "projects"}
          </p>
        </header>

        {organizationCount === 0 ? (
          <section className="mt-double rounded-sm border border-dashed border-line bg-surface p-base sm:p-double">
            <h2 className="text-base font-medium text-fg">
              No organizations found
            </h2>
            <p className="mt-half text-sm text-fg-3">
              Create or join an organization to start working on projects.
            </p>
          </section>
        ) : (
          <div className="mt-double space-y-double">
            {items.map(({ organization, projects }) => (
              <OrganizationSection
                key={organization.id}
                organization={organization}
                projects={projects}
                hostId={preferredHostId}
                onRequireHost={openRelaySettings}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg px-base">
      <section className="w-full max-w-md rounded-sm border border-line bg-surface p-double text-center">
        {children}
      </section>
    </div>
  );
}

function OrganizationSection({
  organization,
  projects,
  hostId,
  onRequireHost,
}: OrganizationWithProjects & {
  hostId: string | null;
  onRequireHost: () => void;
}) {
  return (
    <section className="space-y-base">
      <header className="flex items-center justify-between gap-base">
        <h2 className="truncate text-lg font-medium text-fg">
          {organization.name}
        </h2>
        <p className="shrink-0 text-xs text-fg-3">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </p>
      </header>

      {projects.length === 0 ? (
        <div className="rounded-sm border border-dashed border-line bg-surface px-base py-base text-sm text-fg-3">
          No projects yet
        </div>
      ) : (
        <ul className="grid gap-base sm:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard
                project={project}
                hostId={hostId}
                onRequireHost={onRequireHost}
              />
            </li>
          ))}
          {projects.length % 2 === 1 ? (
            <li className="hidden sm:block" aria-hidden="true">
              <ProjectCardSkeleton />
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

/** Project brand dot — color is per-project HSL channels (e.g. "210 40% 50%"). */
function ProjectColorDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: `hsl(${color})` }}
    />
  );
}

function ProjectCard({
  project,
  hostId,
  onRequireHost,
}: {
  project: Project;
  hostId: string | null;
  onRequireHost: () => void;
}) {
  const setSelectedOrgId = useOrganizationStore((s) => s.setSelectedOrgId);

  if (!hostId) {
    return (
      <button
        type="button"
        aria-label={`${project.name} — link a host to open`}
        className="group flex h-[61px] w-full flex-col justify-center rounded-sm border border-line bg-surface px-base py-base text-left hover:border-signal hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        onClick={onRequireHost}
      >
        <span className="flex items-center gap-base">
          <ProjectColorDot color={project.color} />
          <span className="min-w-0 truncate text-sm font-medium text-fg">
            {project.name}
          </span>
        </span>
        <p className="mt-half text-xs text-fg-3">Link a host to open project</p>
      </button>
    );
  }

  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      aria-label={`Open project ${project.name}`}
      onClick={() => {
        setSelectedOrgId(project.organization_id);
      }}
      className="group flex h-[61px] flex-col justify-center rounded-sm border border-line bg-surface px-base py-base hover:border-signal hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      <span className="flex items-center gap-base">
        <ProjectColorDot color={project.color} />
        <span className="min-w-0 truncate text-sm font-medium text-fg">
          {project.name}
        </span>
      </span>
      <p className="mt-half text-xs text-fg-3 group-hover:text-fg-2">
        Open project
      </p>
    </Link>
  );
}

function ProjectCardSkeleton() {
  return (
    <div className="h-[61px] animate-pulse rounded-sm border border-line bg-surface" />
  );
}
