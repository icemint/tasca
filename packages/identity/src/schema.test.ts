import { describe, it, expect } from 'vitest';
import {
  IDENTITY_SCHEMA_DDL,
  RBAC_ROLE_TABLE_DDL,
  AGENT_TABLE_DDL,
  SERVICE_USER_TABLE_DDL,
} from './index';

// Pure (no DB): the FK dependency order must hold so the bundle applies cleanly
// to an empty Postgres — referenced tables (rbac_role, agent) precede the tables
// that reference them.
describe('IDENTITY_SCHEMA_DDL ordering', () => {
  it('lists every table-creating statement', () => {
    expect(IDENTITY_SCHEMA_DDL).toHaveLength(7);
    for (const ddl of IDENTITY_SCHEMA_DDL) {
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS');
    }
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
