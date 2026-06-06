import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import type { CapabilityProfile } from '@tasca/domain';
import {
  PgIdentityRepository,
  IDENTITY_SCHEMA_DDL,
  bindShortcutIdentity,
  rotateShortcutCredential,
} from './index';

// DB-backed proof of the identity primitive's invariants. Runs only when
// DATABASE_URL points at a Postgres (mirrors the claim-CAS test); skipped
// otherwise so the suite stays green without a DB. CI provides a Postgres.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('PgIdentityRepository (Postgres) — stable principal + binding lifecycle', () => {
  let pool: Pool;
  let repo: PgIdentityRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    for (const ddl of IDENTITY_SCHEMA_DDL) {
      await pool.query(ddl);
    }
    repo = new PgIdentityRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  // Isolate each test: clear the identity tables (CASCADE handles dependents).
  beforeEach(async () => {
    await pool.query('TRUNCATE audit_event, identity_binding, delegation, capability_profile, service_user, agent, rbac_role CASCADE');
  });

  async function makeAgent() {
    return repo.createAgent({ name: 'Elvis', model: 'claude-sonnet', vendor: 'claude' });
  }

  it('creating an agent yields a stable principal_id and an empty binding set', async () => {
    const { agent, serviceUser } = await makeAgent();
    expect(agent.name).toBe('Elvis');
    expect(serviceUser.agentId).toBe(agent.id);
    expect(serviceUser.principalId).toMatch(/^prn_/);

    const fetched = await repo.getServiceUser(agent.id);
    expect(fetched?.principalId).toBe(serviceUser.principalId);

    const bindings = await repo.listBindings(agent.id);
    expect(bindings).toEqual([]);
  });

  it('identity_binding CRUD carries a per-binding credential_ref', async () => {
    const { agent } = await makeAgent();

    const created = await repo.upsertBinding({
      agentId: agent.id,
      platform: 'shortcut',
      externalId: 'sc-agent-123',
      externalHandle: 'elvis',
      credentialRef: 'secret://shortcut/elvis/v1',
    });
    expect(created.credentialRef).toBe('secret://shortcut/elvis/v1');
    expect(created.state).toBe('provisioned');

    const got = await repo.getBinding(agent.id, 'shortcut');
    expect(got?.externalId).toBe('sc-agent-123');

    const all = await repo.listBindings(agent.id);
    expect(all).toHaveLength(1);

    await repo.revokeBinding(agent.id, 'shortcut');
    const revoked = await repo.getBinding(agent.id, 'shortcut');
    expect(revoked?.state).toBe('revoked');
  });

  it('rotating a binding credential_ref leaves principal_id unchanged (key invariant)', async () => {
    const { agent, serviceUser } = await makeAgent();
    await bindShortcutIdentity(repo, {
      agentId: agent.id,
      shortcutAgentUserId: 'sc-agent-456',
      handle: 'elvis',
      credentialRef: 'secret://shortcut/elvis/v1',
    });

    const before = await repo.getServiceUser(agent.id);
    const rotated = await rotateShortcutCredential(repo, agent.id, 'secret://shortcut/elvis/v2');
    const after = await repo.getServiceUser(agent.id);

    expect(rotated.credentialRef).toBe('secret://shortcut/elvis/v2');
    expect(rotated.externalId).toBe('sc-agent-456'); // native identity preserved
    // THE invariant: external credential rotated, internal principal unchanged.
    expect(after?.principalId).toBe(before?.principalId);
    expect(after?.principalId).toBe(serviceUser.principalId);
  });

  it('capability_profile set/get round-trips numeric + array fields', async () => {
    const { agent } = await makeAgent();
    const profile: CapabilityProfile = {
      agentId: agent.id,
      maxTier: 'hard',
      tiersCovered: ['basic', 'low', 'medium', 'hard'],
      languageSpecialties: ['typescript'],
      frameworkSpecialties: ['astro'],
      concurrencyLimit: 3,
      costCeiling: 12.5,
      successRate: null,
      avgLatencyMs: null,
    };
    await repo.setCapabilityProfile(profile);
    const got = await repo.getCapabilityProfile(agent.id);
    expect(got).toEqual(profile);
  });

  it('audit_event append attributes to the stable principal_id', async () => {
    const { agent, serviceUser } = await makeAgent();
    await repo.appendAuditEvent({
      principalId: serviceUser.principalId,
      agentId: agent.id,
      action: 'pr.create',
      target: 'PR-7',
      platform: 'github',
      payload: { url: 'https://example/pr/7' },
    });

    const events = await repo.listAuditEvents(serviceUser.principalId);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('pr.create');
    expect(events[0]!.principalId).toBe(serviceUser.principalId);
    expect(events[0]!.payload).toEqual({ url: 'https://example/pr/7' });
  });

  it('binding + rotation each write an audit row under the same principal', async () => {
    const { agent, serviceUser } = await makeAgent();
    await bindShortcutIdentity(repo, {
      agentId: agent.id,
      shortcutAgentUserId: 'sc-agent-789',
      credentialRef: 'secret://shortcut/elvis/v1',
    });
    await rotateShortcutCredential(repo, agent.id, 'secret://shortcut/elvis/v2');

    const events = await repo.listAuditEvents(serviceUser.principalId);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('identity.binding.shortcut.bound');
    expect(actions).toContain('identity.binding.shortcut.credential_rotated');
  });
});
