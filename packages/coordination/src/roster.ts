// The org roster: which managed agents an org has hired (slice 5d, the Option-B realization).
//
// Agents stay GLOBAL (the agent/identity tables gain NO org_id — that boundary was deliberately
// deferred). org_agent is a JOIN — org↔agent — exactly like org_membership is org↔user. "Hiring" an
// agent is inserting a row; the routing engine then considers ONLY the org's hired agents for that
// org's tasks. A global agent the org hasn't hired is structurally absent from the candidate set, so
// it can never be routed to — that is the 5d tenant boundary on the candidate set.
//
// org_agent is NOT a tenant data table (it RESOLVES which agents serve a tenant), so it is not under
// the org-scoping CI guard; but the routing candidate query IS org-scoped (carries the orgId).

import type { Queryable } from './store';

/**
 * org↔agent hiring. References organization (3a) and agent (identity) — applied AFTER both. PK
 * (org_id, agent_id) makes hire idempotent. ON DELETE CASCADE: dropping an org or retiring an agent
 * drops its roster rows.
 */
export const ORG_AGENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS org_agent (
  org_id     text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  agent_id   text NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, agent_id)
);
CREATE INDEX IF NOT EXISTS org_agent_org_idx ON org_agent (org_id);`;

/** A hired agent as the roster lists it. */
export interface HiredAgent {
  agentId: string;
  name: string;
  status: 'active' | 'paused' | 'retired';
}

/** Outcome of a hire. `not_found` = no such global agent. */
export type HireOutcome = 'ok' | 'not_found' | 'already_hired';

/** The org roster repository (slice 5d). */
export interface OrgRosterRepo {
  /** Hire a global agent into the org. `not_found` if the agent id doesn't exist; `already_hired`
   *  if the org already hired it (idempotent). */
  hire(orgId: string, agentId: string): Promise<HireOutcome>;
  /** Unhire an agent from the org. Returns true if a row was removed. */
  unhire(orgId: string, agentId: string): Promise<boolean>;
  /** The org's hired agents (id + name + status), for the roster view. */
  listHired(orgId: string): Promise<HiredAgent[]>;
  /** Just the hired agent ids — the routing candidate filter. */
  hiredAgentIds(orgId: string): Promise<string[]>;
  /** Is this agent hired by this org? */
  isHired(orgId: string, agentId: string): Promise<boolean>;
  /** Resolve an `agent:<name>` label to a HIRED agent's id, or null if the org hasn't hired any
   *  agent by that name. The label is a preference WITHIN the hired set — this enforces the boundary
   *  (an unhired/unknown name → null → the caller fails closed, never routes to an unhired agent). */
  findHiredAgentByName(orgId: string, name: string): Promise<string | null>;
}

export class PgOrgRosterRepo implements OrgRosterRepo {
  constructor(private readonly db: Queryable) {}

  async hire(orgId: string, agentId: string): Promise<HireOutcome> {
    try {
      const res = await this.db.query(
        `INSERT INTO org_agent (org_id, agent_id) VALUES ($1, $2) ON CONFLICT (org_id, agent_id) DO NOTHING`,
        [orgId, agentId]
      );
      return res.rowCount === 1 ? 'ok' : 'already_hired';
    } catch (e) {
      if ((e as { code?: string }).code === '23503') return 'not_found'; // FK: no such agent (or org)
      throw e;
    }
  }

  async unhire(orgId: string, agentId: string): Promise<boolean> {
    const res = await this.db.query(`DELETE FROM org_agent WHERE org_id = $1 AND agent_id = $2`, [orgId, agentId]);
    return (res.rowCount ?? 0) > 0;
  }

  async listHired(orgId: string): Promise<HiredAgent[]> {
    const res = await this.db.query<{ agent_id: string; name: string; status: HiredAgent['status'] }>(
      `SELECT oa.agent_id, a.name, a.status
         FROM org_agent oa JOIN agent a ON a.id = oa.agent_id
        WHERE oa.org_id = $1
        ORDER BY a.name, oa.agent_id`,
      [orgId]
    );
    return res.rows.map((r) => ({ agentId: r.agent_id, name: r.name, status: r.status }));
  }

  async hiredAgentIds(orgId: string): Promise<string[]> {
    const res = await this.db.query<{ agent_id: string }>(
      `SELECT agent_id FROM org_agent WHERE org_id = $1`,
      [orgId]
    );
    return res.rows.map((r) => r.agent_id);
  }

  async isHired(orgId: string, agentId: string): Promise<boolean> {
    const res = await this.db.query(`SELECT 1 FROM org_agent WHERE org_id = $1 AND agent_id = $2`, [orgId, agentId]);
    return (res.rowCount ?? 0) > 0;
  }

  async findHiredAgentByName(orgId: string, name: string): Promise<string | null> {
    const res = await this.db.query<{ agent_id: string }>(
      `SELECT oa.agent_id
         FROM org_agent oa JOIN agent a ON a.id = oa.agent_id
        WHERE oa.org_id = $1 AND lower(a.name) = lower($2)
        ORDER BY oa.agent_id LIMIT 1`,
      [orgId, name]
    );
    return res.rows[0]?.agent_id ?? null;
  }
}
