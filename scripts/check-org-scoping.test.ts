import { describe, it, expect } from 'vitest';
import {
  scanSourceForTenantSql,
  findOrgScopingViolations,
  TENANT_TABLES,
  SCOPED_LAYER,
} from './check-org-scoping';
import path from 'node:path';

describe('org-scoping guard — it MUST fire on raw tenant SQL outside the scoped layer', () => {
  it('FLAGS a raw `FROM task` in a non-scoped source file (the deliberate violation)', () => {
    const v = scanSourceForTenantSql(
      `const r = await db.query('SELECT * FROM task WHERE id = $1', [id]);`,
      'packages/coordination/src/read-api.ts'
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.table).toBe('task');
    expect(v[0]!.line).toBe(1);
  });

  it('FLAGS INSERT INTO / UPDATE / JOIN / DELETE FROM on every tenant table', () => {
    const cases: Array<[string, string]> = [
      [`INSERT INTO webhook_event (id) VALUES ($1)`, 'webhook_event'],
      [`UPDATE dispatch_job SET status='x'`, 'dispatch_job'],
      [`SELECT 1 FROM routing_decision`, 'routing_decision'],
      [`DELETE FROM pull_request WHERE id=$1`, 'pull_request'],
      [`SELECT * FROM platform_connection pc JOIN webhook_event w ON true`, 'platform_connection'],
    ];
    for (const [sql, table] of cases) {
      const v = scanSourceForTenantSql(sql, 'packages/coordination/src/orchestrate.ts');
      expect(v.length).toBeGreaterThanOrEqual(1);
      expect(v.map((x) => x.table)).toContain(table);
    }
  });

  it('catches the BYPASSES an adversary would try (no false negatives)', () => {
    const nonScoped = 'packages/coordination/src/read-api.ts';
    // TRUNCATE — a different DDL keyword.
    expect(scanSourceForTenantSql(`await db.query('TRUNCATE task CASCADE')`, nonScoped).map((v) => v.table)).toContain('task');
    expect(scanSourceForTenantSql(`await db.query('TRUNCATE TABLE dispatch_job')`, nonScoped).map((v) => v.table)).toContain('dispatch_job');
    // Keyword and table split across lines (the per-line scan used to miss this).
    expect(scanSourceForTenantSql('const r = db.query(`SELECT *\n  FROM\n    task WHERE id=$1`)', nonScoped).map((v) => v.table)).toContain('task');
    // Quoted identifier.
    expect(scanSourceForTenantSql(`db.query('SELECT * FROM "task" WHERE id=$1')`, nonScoped).map((v) => v.table)).toContain('task');
    // Schema-qualified.
    expect(scanSourceForTenantSql(`db.query('UPDATE public.task SET x=1')`, nonScoped).map((v) => v.table)).toContain('task');
    // CTE / MERGE still caught (from/into present).
    expect(scanSourceForTenantSql(`WITH x AS (SELECT id FROM webhook_event) SELECT 1`, nonScoped).map((v) => v.table)).toContain('webhook_event');
  });

  it('PASSES the SCOPED LAYER — those files may contain tenant SQL (their methods are org-scoped)', () => {
    for (const f of SCOPED_LAYER) {
      expect(scanSourceForTenantSql(`SELECT * FROM task WHERE org_id = $1 AND id = $2`, f)).toEqual([]);
    }
  });

  it('PASSES test files (fixtures legitimately seed data with raw SQL)', () => {
    expect(scanSourceForTenantSql(`INSERT INTO task (id) VALUES ('t1')`, 'packages/coordination/src/foo.test.ts')).toEqual([]);
  });

  it('PASSES compliant non-scoped code that goes THROUGH the store (no raw tenant SQL)', () => {
    const compliant = `const tasks = await deps.store.listTasks(orgId, { limit: 200 });\nconst t = await deps.store.getTask(orgId, id);`;
    expect(scanSourceForTenantSql(compliant, 'packages/coordination/src/read-api.ts')).toEqual([]);
  });

  it('does not false-positive on a non-tenant table or a substring (e.g. taskfoo)', () => {
    expect(scanSourceForTenantSql(`SELECT * FROM agent WHERE id=$1`, 'packages/coordination/src/read-api.ts')).toEqual([]);
    expect(scanSourceForTenantSql(`SELECT * FROM taskfoo`, 'packages/coordination/src/read-api.ts')).toEqual([]);
  });

  it('the REAL repo is clean — all tenant SQL is already confined to the scoped layer', () => {
    const root = path.resolve(__dirname, '..');
    const violations = findOrgScopingViolations(root);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('covers all thirteen tenant tables', () => {
    expect([...TENANT_TABLES].sort()).toEqual(
      ['dispatch_job', 'task', 'routing_decision', 'pull_request', 'platform_connection', 'webhook_event', 'proposal', 'usage_event', 'org_vendor_credential', 'org_agent_credential', 'governance_audit_event', 'org_invite', 'project'].sort()
    );
  });
});
