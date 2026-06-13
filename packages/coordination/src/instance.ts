// Single-tenant "single-org cut" (slice 3.5-B.1) — the open-core boundary mechanic.
//
// Tasca's OSS edition runs SINGLE-TENANT: every human who logs in joins ONE instance org, and the
// org-multiplicity surface (list/create/switch orgs) is hidden. The hosted SaaS tier flips this back
// to per-user personal orgs + the multiplicity routes. The single-tenant property is produced WITHOUT
// rewriting the tenant boundary: resolveOrg/getActiveOrg/getRole are unchanged (a user's only
// membership is the instance org, so they resolve to it — roles + fail-closed intact). What changes is
// only (a) ENROLLMENT (everyone joins the instance org, not a personal one — membership.ts), (b) GATING
// (the 3 multiplicity routes 404 — org-api.ts), and (c) first-boot PROVISIONING of the instance org
// (resolveInstanceOrgId, below).
//
// ALL of it is gated behind TASCA_SINGLE_TENANT (default OFF): an existing multi-tenant deployment is
// byte-identical until the operator opts in. `organization` is NOT a tenant table (it RESOLVES the
// tenant — see org-scoping.ts TENANT_TABLES), so the raw SQL here is outside the org-scoping guard.

import type { Pool } from 'pg';
import type { Logger } from './ports';

/** The id the greenfield first-boot provisions when no org exists and none is named. */
export const INSTANCE_ORG_ID = 'org_instance';

/** Is the single-tenant (OSS) edition enabled? Read ONCE at the composition root, never deep in a
 *  handler — the flag is injected downstream so the request path stays testable. */
export function singleTenantEnabled(): boolean {
  return process.env.TASCA_SINGLE_TENANT === 'on';
}

/**
 * Resolve the ONE instance org id at boot (single-tenant only). Three paths, each logged loudly so the
 * operator can see which one ran:
 *   1. TASCA_INSTANCE_ORG_ID set → that org MUST already exist (an operator naming a nonexistent org has
 *      a typo / wrong deployment — THROW rather than silently provision a different one).
 *   2. else adopt the OLDEST existing organization (an existing deployment with real data keeps its org).
 *   3. else provision a fresh `org_instance` (greenfield).
 * Resolved once at boot and passed into the wiring — there is no per-request DB hit.
 */
export async function resolveInstanceOrgId(pool: Pool, logger?: Logger): Promise<string> {
  const named = process.env.TASCA_INSTANCE_ORG_ID;
  if (named) {
    const found = await pool.query(`SELECT 1 FROM organization WHERE id = $1`, [named]);
    if ((found.rowCount ?? 0) === 0) {
      throw new Error(
        `TASCA_INSTANCE_ORG_ID='${named}' names an organization that does not exist — ` +
          `create it first, or unset the var to adopt the oldest existing org (or provision a fresh one).`
      );
    }
    logger?.info?.('instance org resolved', { instanceOrgId: named, source: 'TASCA_INSTANCE_ORG_ID' });
    return named;
  }

  const oldest = await pool.query<{ id: string }>(
    `SELECT id FROM organization ORDER BY created_at ASC, id ASC LIMIT 1`
  );
  const existing = oldest.rows[0]?.id;
  if (existing) {
    logger?.info?.('instance org resolved', { instanceOrgId: existing, source: 'adopted oldest existing org' });
    return existing;
  }

  await pool.query(
    `INSERT INTO organization (id, name) VALUES ($1, 'Instance') ON CONFLICT (id) DO NOTHING`,
    [INSTANCE_ORG_ID]
  );
  logger?.info?.('instance org resolved', { instanceOrgId: INSTANCE_ORG_ID, source: 'provisioned — greenfield' });
  return INSTANCE_ORG_ID;
}
