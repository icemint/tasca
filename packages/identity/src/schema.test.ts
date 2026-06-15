import { describe, it, expect } from 'vitest';
import {
  IDENTITY_SCHEMA_DDL,
  RBAC_ROLE_TABLE_DDL,
  AGENT_TABLE_DDL,
  SERVICE_USER_TABLE_DDL,
  AGENT_DESCRIPTION_DDL,
} from './index';

// Pure (no DB): the FK dependency order must hold so the bundle applies cleanly
// to an empty Postgres — referenced tables (rbac_role, agent) precede the tables
// that reference them.
describe('IDENTITY_SCHEMA_DDL ordering', () => {
  it('creates the seven core tables, then runs additive migrations after them', () => {
    // The seven CREATE TABLE statements come first (FK order), followed by additive
    // ALTERs (idempotent column adds) that must run after the table they extend exists.
    const creators = IDENTITY_SCHEMA_DDL.filter((d) => d.includes('CREATE TABLE IF NOT EXISTS'));
    expect(creators).toHaveLength(7);
    expect(IDENTITY_SCHEMA_DDL.slice(0, 7)).toEqual(creators); // creators precede migrations
    // The description migration is an idempotent ADD COLUMN, ordered after agent exists.
    expect(IDENTITY_SCHEMA_DDL.indexOf(AGENT_DESCRIPTION_DDL)).toBeGreaterThan(
      IDENTITY_SCHEMA_DDL.indexOf(AGENT_TABLE_DDL)
    );
    expect(AGENT_DESCRIPTION_DDL).toContain('ADD COLUMN IF NOT EXISTS');
  });

  it('puts rbac_role and agent before their dependents', () => {
    const idx = (s: string) => IDENTITY_SCHEMA_DDL.indexOf(s);
    expect(idx(RBAC_ROLE_TABLE_DDL)).toBeLessThan(idx(AGENT_TABLE_DDL));
    // service_user references agent → agent must come first.
    expect(idx(AGENT_TABLE_DDL)).toBeLessThan(idx(SERVICE_USER_TABLE_DDL));
  });

  it('never embeds a literal secret column (only credential_ref pointer)', () => {
    const all = IDENTITY_SCHEMA_DDL.join('\n');
    expect(all).toContain('credential_ref');
    expect(all).not.toMatch(/\bsecret\b|\btoken\b|\bcredential\s+text/i);
  });
});
