import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { IDENTITY_SCHEMA_DDL } from '@tasca/identity';
import { ORG_AGENT_TABLE_DDL } from './roster';
import { PgAgentCreator } from './agent-creator';

// The organization table (org_agent FKs it). The full ORG_SCOPING_DDL also touches task/
// routing_decision/etc. that this isolated schema doesn't have, so create just the table org_agent
// references.
const ORGANIZATION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS organization (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`;

// DB-backed proof that create + capability profile + auto-hire is ONE atomic operation: on success a
// principal-anchored agent exists with a derived-or-overridden tier AND an org_agent row; on a hire
// failure NO orphan agent survives. Runs only when DATABASE_URL points at a Postgres; skipped otherwise.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('PgAgentCreator (Postgres) — atomic create + profile + auto-hire', () => {
  let pool: Pool;
  let creator: PgAgentCreator;
  const ORG = 'org_caller';
  const SCHEMA = 'agent_creator_test';

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    for (const ddl of IDENTITY_SCHEMA_DDL) await pool.query(ddl);
    await pool.query(ORGANIZATION_TABLE_DDL); // the org_agent FK target
    await pool.query(ORG_AGENT_TABLE_DDL);
    creator = new PgAgentCreator(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE org_agent, audit_event, identity_binding, delegation, capability_profile, service_user, agent, rbac_role CASCADE');
    await pool.query(`INSERT INTO organization (id, name) VALUES ($1, 'Caller'), ('org_other', 'Other') ON CONFLICT (id) DO NOTHING`, [ORG]);
  });

  async function rowsFor(agentId: string) {
    const su = await pool.query(`SELECT principal_id FROM service_user WHERE agent_id = $1`, [agentId]);
    const cp = await pool.query<{ max_tier: string; tiers_covered: string[] }>(
      `SELECT max_tier, tiers_covered FROM capability_profile WHERE agent_id = $1`,
      [agentId]
    );
    const hired = await pool.query(`SELECT org_id FROM org_agent WHERE agent_id = $1`, [agentId]);
    return { su, cp, hired };
  }

  it('derives the tier from the model (opus → ultra → all five) + mints a principal + hires into the org', async () => {
    const out = await creator.create(ORG, { name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8', maxTier: 'ultra' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.agent).toMatchObject({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8', maxTier: 'ultra' });

    const { su, cp, hired } = await rowsFor(out.agent.id);
    expect(su.rowCount).toBe(1); // a service_user / principal was minted
    expect(typeof su.rows[0]!.principal_id).toBe('string');
    expect(cp.rows[0]!.max_tier).toBe('ultra');
    expect(cp.rows[0]!.tiers_covered).toEqual(['basic', 'low', 'medium', 'hard', 'ultra']);
    expect(hired.rowCount).toBe(1); // auto-hired
    expect(hired.rows[0]!.org_id).toBe(ORG); // into the CALLER's org, not org_other
  });

  it('an explicit low tier overrides — tiers_covered = [basic, low]', async () => {
    const out = await creator.create(ORG, { name: 'Mona', vendor: 'claude', model: 'claude-opus-4-8', maxTier: 'low' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { cp } = await rowsFor(out.agent.id);
    expect(cp.rows[0]!.max_tier).toBe('low');
    expect(cp.rows[0]!.tiers_covered).toEqual(['basic', 'low']);
  });

  it('ATOMICITY: a hire failure (the org vanished) leaves NO orphan agent', async () => {
    const out = await creator.create('org_ghost', { name: 'Ghost', vendor: 'claude', model: 'claude-opus-4-8', maxTier: 'ultra' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_found'); // FK: no such org → hire not_found
    // The whole tx rolled back: zero agents, zero service_users, zero capability_profiles, zero hires.
    expect((await pool.query('SELECT count(*)::int AS n FROM agent')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM service_user')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM capability_profile')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM org_agent')).rows[0].n).toBe(0);
  });
});
