// Project resolution at the REQUEST EDGE — the finer task-view filter WITHIN the org boundary.
//
// A project is NOT a tenant scope (org_id stays the tenant boundary — see resolve-org.ts); it is a
// filter applied AFTER the org is resolved. resolveProject() is the one session→active-project
// function, parallel to resolveOrg(). It returns the user's VALIDATED active project (validated
// against their CURRENT active org by the store, so a stale selection never leaks a foreign tenant's
// project), or null.
//
// null is the DEFAULT and means the "All projects" view — NO project filter. We deliberately do NOT
// auto-select a project: a single-tenant instance with one project still shows ALL its tasks by
// default, and the behavior degrades cleanly to N projects (the user picks one to narrow the view).

import type { SessionInfo } from './read-api';

/** The reader resolveProject needs — the active-project lookup the store backs (validated against the
 *  user's active org). A narrow surface so the read API depends only on what it uses. */
export interface ActiveProjectReader {
  /** The user's active project IF it is still in their current active org, else null (= all projects).
   *  Never a foreign tenant's project — the store validates org membership at read time. */
  getActiveProject(userId: string): Promise<string | null>;
}

/**
 * Resolve the project a request's task views are filtered to:
 * - an authenticated session → the user's validated active project, or null (= all projects);
 * - a null session (dev/no-auth, allowUnauthenticated-gated) → null (= all projects), no filter.
 * null is always a safe default — it widens to the org's full task set, never another tenant's.
 */
export async function resolveProject(
  reader: ActiveProjectReader,
  session: SessionInfo | null
): Promise<string | null> {
  if (session === null) return null; // dev/no-auth: no project filter (all of the resolved org's tasks)
  return reader.getActiveProject(session.userId);
}
