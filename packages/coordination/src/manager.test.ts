import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
import { AUTH_SCHEMA_DDL } from '@tasca/auth';
import { IDENTITY_SCHEMA_DDL, PgIdentityRepository } from '@tasca/identity';
import { COORDINATION_SCHEMA_DDL, MANAGER_CREDENTIAL_TABLE_DDL } from './schema';
import { ORG_AGENT_TABLE_DDL, PgOrgRosterRepo } from './roster';
import { PgCoordinationStore } from './store';
import { PgAgentCreator } from './agent-creator';
import { ManagerCredentialResolver, openVendorKey, sealVendorKey } from './vendor-credential';

// DB-backed proof of EM v1 slice 1: the manager entity + its sealed credential + project link, all
// org-scoped, AND the structural proof that a manager can never enter worker routing. Skipped without
// DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
const MASTER = randomBytes(32);

run('PgCoordinationStore — Engineering Manager entity (EM v1 slice 1)', () => {
  const SCHEMA = 'manager_store_test';
  let pool: Pool;
  let store: PgCoordinationStore;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    await pool.query(DISPATCH_JOB_DDL);
    for (const ddl of IDENTITY_SCHEMA_DDL) await pool.query(ddl); // agent/service_user/capability_profile/...
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl); // app_user
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl); // organization + project + manager + manager_credential + project.manager_id
    await pool.query(ORG_AGENT_TABLE_DDL); // the roster join (FKs organization + agent)
    await pool.query(MANAGER_CREDENTIAL_TABLE_DDL); // FKs organization + manager (in the bundle too; re-apply is idempotent)
    store = new PgCoordinationStore(pool);

    // Two orgs, so we also prove cross-org isolation.
    await pool.query(`INSERT INTO organization (id, name) VALUES ('org_a','A'),('org_b','B') ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  it('createManager + getManager + listManagers are ORG-SCOPED', async () => {
    const { managerId: a1 } = await store.createManager('org_a', 'Elvis');
    const { managerId: a2 } = await store.createManager('org_a', 'Mona');
    const { managerId: b1 } = await store.createManager('org_b', 'Qwen');

    // getManager is org-scoped: org_a sees its own, but NOT org_b's (foreign id → null).
    expect(await store.getManager('org_a', a1)).toMatchObject({ id: a1, name: 'Elvis', shortcutMemberId: null, shortcutHandle: null });
    expect(await store.getManager('org_a', b1)).toBeNull(); // foreign-org id → indistinguishable from missing
    expect(await store.getManager('org_b', b1)).toMatchObject({ id: b1, name: 'Qwen' });

    // listManagers is org-scoped — never another org's managers.
    const aList = await store.listManagers('org_a');
    expect(aList.map((m) => m.id).sort()).toEqual([a1, a2].sort());
    const bList = await store.listManagers('org_b');
    expect(bList.map((m) => m.id)).toEqual([b1]);
  });

  it('setManagerShortcutIdentity sets the identity projection AND seals the token (no plaintext at rest)', async () => {
    const { managerId } = await store.createManager('org_a', 'Elvis-EM');
    const TOKEN = 'shortcut-em-token-PROD-do-not-leak-abc';
    const sealed = sealVendorKey(TOKEN, MASTER);
    await store.setManagerShortcutIdentity('org_a', managerId, 'sc-member-42', 'elvis', sealed, 'fp-em', 'admin-user');

    // the identity projection (load-bearing for self-comment dedupe) is set
    expect(await store.getManager('org_a', managerId)).toMatchObject({ shortcutMemberId: 'sc-member-42', shortcutHandle: 'elvis' });

    // the sealed credential is stored; the raw row carries NO plaintext token
    const raw = await pool.query<{ ciphertext: string; key_fingerprint: string }>(
      `SELECT ciphertext, key_fingerprint FROM manager_credential WHERE org_id = 'org_a' AND manager_id = $1`,
      [managerId]
    );
    expect(raw.rows[0]!.key_fingerprint).toBe('fp-em');
    expect(raw.rows[0]!.ciphertext).not.toContain(TOKEN);

    // getSealedManagerCredential returns the blob; the resolver opens it ONLY with the master key
    const blob = await store.getSealedManagerCredential('org_a', managerId, 'shortcut');
    expect(JSON.stringify(blob)).not.toContain(TOKEN);
    expect(openVendorKey(blob!, MASTER)).toBe(TOKEN);

    const resolver = new ManagerCredentialResolver(store, MASTER);
    expect(await resolver.resolve('org_a', managerId, 'shortcut')).toBe(TOKEN);
    // org-scoped: another org cannot resolve this manager's token
    expect(await resolver.resolve('org_b', managerId, 'shortcut')).toBeNull();
  });

  it('getSealedManagerCredential is org-scoped (another org cannot read the blob)', async () => {
    const { managerId } = await store.createManager('org_a', 'Scoped');
    await store.setManagerShortcutIdentity('org_a', managerId, 'm', null, sealVendorKey('tok', MASTER), 'fp', null);
    expect(await store.getSealedManagerCredential('org_a', managerId, 'shortcut')).not.toBeNull();
    expect(await store.getSealedManagerCredential('org_b', managerId, 'shortcut')).toBeNull();
  });

  it('setProjectManager + getManagerForProject: both-in-org link; foreign-org entity → not_found', async () => {
    const { managerId: mgrA } = await store.createManager('org_a', 'PM-A');
    const { managerId: mgrB } = await store.createManager('org_b', 'PM-B');
    const projA = await store.getOrCreateProject('org_a', 'owner/repo-a');
    const projB = await store.getOrCreateProject('org_b', 'owner/repo-b');

    // happy path: both in org_a → linked
    expect(await store.setProjectManager('org_a', projA, mgrA)).toBe('ok');
    expect(await store.getManagerForProject('org_a', projA)).toBe(mgrA);

    // a foreign-org MANAGER → not_found (no cross-tenant link, no existence oracle)
    expect(await store.setProjectManager('org_a', projA, mgrB)).toBe('not_found');
    // a foreign-org PROJECT → not_found
    expect(await store.setProjectManager('org_a', projB, mgrA)).toBe('not_found');
    // the link is unchanged by the rejected attempts
    expect(await store.getManagerForProject('org_a', projA)).toBe(mgrA);

    // getManagerForProject is org-scoped: org_b can't read org_a's link; a project with no manager → null
    expect(await store.getManagerForProject('org_b', projA)).toBeNull();
    expect(await store.getManagerForProject('org_b', projB)).toBeNull();
  });

  it('a manager NEVER appears as a routing candidate (by construction — it is not in agent/org_agent)', async () => {
    // A real hired AGENT in org_a — the directory MUST return it.
    const creator = new PgAgentCreator(pool);
    const created = await creator.create('org_a', { name: 'RealAgent', vendor: 'claude', model: 'claude-haiku-4-5', maxTier: 'low' });
    expect(created.ok).toBe(true);
    const realAgentId = created.ok ? created.agent.id : '';

    // A manager in org_a with the SAME would-be capability — it must be invisible to routing.
    const { managerId } = await store.createManager('org_a', 'Ghost-EM');

    // Drive the EXACT routing-candidate path the factory uses: roster.hiredAgentIds → identity profile.
    const roster = new PgOrgRosterRepo(pool);
    const identity = new PgIdentityRepository(pool);
    const hiredIds = await roster.hiredAgentIds('org_a');
    expect(hiredIds).toContain(realAgentId); // the real agent is hired
    expect(hiredIds).not.toContain(managerId); // the manager is NOT in the roster

    // No agent row, no service-user, no capability profile exists for the manager id.
    const agentRow = await pool.query(`SELECT 1 FROM agent WHERE id = $1`, [managerId]);
    expect(agentRow.rowCount).toBe(0);
    const profile = await identity.getCapabilityProfile(managerId);
    expect(profile).toBeNull();
  });
});
