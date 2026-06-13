import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { TASK_TABLE_DDL } from '@tasca/db';
import { COORDINATION_SCHEMA_DDL } from './schema';
import { resolveInstanceOrgId, INSTANCE_ORG_ID, singleTenantEnabled } from './instance';

// DB-backed proof of the single-tenant instance-org resolution (slice 3.5-B.1). Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

describe('singleTenantEnabled', () => {
  afterEach(() => {
    delete process.env.TASCA_SINGLE_TENANT;
  });
  it("is true only for exactly 'on' (default OFF)", () => {
    expect(singleTenantEnabled()).toBe(false); // unset
    process.env.TASCA_SINGLE_TENANT = 'off';
    expect(singleTenantEnabled()).toBe(false);
    process.env.TASCA_SINGLE_TENANT = 'true';
    expect(singleTenantEnabled()).toBe(false); // only 'on' enables it
    process.env.TASCA_SINGLE_TENANT = 'on';
    expect(singleTenantEnabled()).toBe(true);
  });
});

run('resolveInstanceOrgId (Postgres, slice 3.5-B.1)', () => {
  let pool: Pool;
  // Each test runs in its own schema so the organization table state is isolated.
  const freshSchema = async (name: string): Promise<Pool> => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${name}`);
    await bootstrap.end();
    const p = new Pool({ connectionString: url, options: `-c search_path=${name}` });
    await p.query(TASK_TABLE_DDL);
    for (const ddl of COORDINATION_SCHEMA_DDL) await p.query(ddl); // organization table (+ org_default seed)
    return p;
  };

  afterEach(async () => {
    delete process.env.TASCA_INSTANCE_ORG_ID;
    await pool?.end();
  });
  afterAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    for (const s of ['inst_explicit', 'inst_missing', 'inst_adopt', 'inst_greenfield']) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
    }
    await bootstrap.end();
  });

  it('explicit TASCA_INSTANCE_ORG_ID that EXISTS → that id', async () => {
    pool = await freshSchema('inst_explicit');
    await pool.query(`INSERT INTO organization (id, name) VALUES ('chosen', 'Chosen') ON CONFLICT (id) DO NOTHING`);
    process.env.TASCA_INSTANCE_ORG_ID = 'chosen';
    expect(await resolveInstanceOrgId(pool)).toBe('chosen');
  });

  it('explicit TASCA_INSTANCE_ORG_ID naming a MISSING org → throws (no silent provision)', async () => {
    pool = await freshSchema('inst_missing');
    process.env.TASCA_INSTANCE_ORG_ID = 'does-not-exist';
    await expect(resolveInstanceOrgId(pool)).rejects.toThrow(/does not exist/);
    // It must NOT have created a different org behind the operator's back.
    const created = await pool.query(`SELECT 1 FROM organization WHERE id = 'does-not-exist'`);
    expect(created.rowCount).toBe(0);
  });

  it('no env + an existing org → adopts the OLDEST', async () => {
    pool = await freshSchema('inst_adopt');
    // COORDINATION_SCHEMA_DDL seeds org_default (the oldest); add a newer one to prove oldest wins.
    await pool.query(`INSERT INTO organization (id, name, created_at) VALUES ('newer', 'Newer', now() + interval '1 hour')`);
    expect(await resolveInstanceOrgId(pool)).toBe('org_default'); // oldest by created_at
  });

  it('no env + NO org → provisions a fresh org_instance (greenfield)', async () => {
    pool = await freshSchema('inst_greenfield');
    // Strip the seeded org_default to simulate a truly greenfield DB. session_replication_role=replica
    // skips the RI triggers for this delete (every org-scoped table is empty, so there is nothing to
    // orphan) — a plain DELETE trips a referential-integrity trigger query on the empty org_id FKs. The
    // SET + DELETE must share one connection, so check a client out of the pool for them.
    const client = await pool.connect();
    try {
      await client.query(`SET session_replication_role = replica`);
      await client.query(`DELETE FROM organization`);
    } finally {
      await client.query(`SET session_replication_role = origin`).catch(() => {});
      client.release();
    }
    expect(await resolveInstanceOrgId(pool)).toBe(INSTANCE_ORG_ID);
    const row = await pool.query<{ name: string }>(`SELECT name FROM organization WHERE id = $1`, [INSTANCE_ORG_ID]);
    expect(row.rows[0]!.name).toBe('Instance');
  });
});
