import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AGENT_CREDENTIAL_TABLE_DDL, AGENT_CREDENTIAL_PROVIDER_DDL } from './schema';

// PG proof of the prod-critical provider CHECK migration (slice SC-3-B): AGENT_CREDENTIAL_TABLE_DDL
// creates org_agent_credential_provider_check INLINE with the OLD set {'shortcut'}; on an already-migrated
// DB the CREATE TABLE (IF NOT EXISTS) never re-fires, so the inline CHECK is never re-applied — the prod
// table keeps the OLD constraint (which rejects 'github') unless AGENT_CREDENTIAL_PROVIDER_DDL drops+adds
// it to the {'shortcut','github'} superset. We deliberately apply the TABLE DDL FIRST (the old constraint),
// seed a 'shortcut' row UNDER it, THEN the provider widening — exactly the prod upgrade order — and prove:
//   1. the pre-existing 'shortcut' row is preserved (superset never rejects what was valid),
//   2. a 'github' INSERT is now accepted (the old CHECK would have rejected it),
//   3. a bogus provider ('linear') is still REJECTED (the CHECK is widened, not dropped),
//   4. re-applying the widening is idempotent (DROP IF EXISTS + the duplicate_object-guarded ADD).
// Minimal parent tables (organization, agent) satisfy the table's FKs; the CHECK is the only thing under
// test. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('org_agent_credential.provider widening for github (slice SC-3-B)', () => {
  const SCHEMA = 'agent_credential_provider_migration_test';
  let pool: Pool;
  const ORG = randomUUID();
  const AGENT = randomUUID();

  // A sealed-blob stand-in — the migration is about the provider CHECK, not the AEAD, so any non-null
  // ciphertext/nonce/auth_tag/fingerprint satisfies the NOT NULLs.
  const blob = (provider: string) =>
    `INSERT INTO org_agent_credential (org_id, agent_id, provider, ciphertext, nonce, auth_tag, key_fingerprint)
       VALUES ('${ORG}','${AGENT}','${provider}','ct','nc','tg','fp')`;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });

    // Minimal parent tables so org_agent_credential's FKs resolve (the CHECK is what's under test).
    await pool.query(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await pool.query(`CREATE TABLE agent (id text PRIMARY KEY)`);
    await pool.query(`INSERT INTO organization (id) VALUES ('${ORG}')`);
    await pool.query(`INSERT INTO agent (id) VALUES ('${AGENT}')`);

    // Apply the TABLE DDL first — it carries the OLD provider CHECK (shortcut only).
    await pool.query(AGENT_CREDENTIAL_TABLE_DDL);
    // Seed a pre-existing 'shortcut' row UNDER THE OLD CONSTRAINT, to prove the widening never rejects a
    // row that was valid before.
    await pool.query(blob('shortcut'));

    // Now apply the provider widening — the DROP+ADD that adds 'github'.
    await pool.query(AGENT_CREDENTIAL_PROVIDER_DDL);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('preserves the pre-existing shortcut row (superset never rejects a previously-valid provider)', async () => {
    const res = await pool.query<{ provider: string }>(`SELECT provider FROM org_agent_credential WHERE agent_id = '${AGENT}'`);
    expect(res.rows.map((r) => r.provider)).toContain('shortcut');
  });

  it('accepts a github INSERT (the old CHECK would have rejected it)', async () => {
    await pool.query(blob('github'));
    const res = await pool.query<{ provider: string }>(`SELECT provider FROM org_agent_credential WHERE agent_id = '${AGENT}' ORDER BY provider`);
    expect(res.rows.map((r) => r.provider)).toEqual(['github', 'shortcut']);
  });

  it('still REJECTS a bogus provider (the CHECK is widened, not dropped)', async () => {
    await expect(pool.query(blob('linear'))).rejects.toThrow(/org_agent_credential_provider_check|check constraint/i);
  });

  it('is idempotent — re-applying the widening does not error (DROP IF EXISTS + ADD)', async () => {
    await pool.query(AGENT_CREDENTIAL_PROVIDER_DDL);
    // and github is still valid after the re-apply (the prior test left a github row there).
    const res = await pool.query<{ provider: string }>(`SELECT provider FROM org_agent_credential WHERE agent_id = '${AGENT}'`);
    expect(res.rows.map((r) => r.provider)).toContain('github');
  });
});
