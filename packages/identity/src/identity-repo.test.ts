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

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Block until `n` sessions are *waiting* on the exclusive advisory lock `gateKey`.
 * Single-bigint advisory locks under 2^32 register in pg_locks as
 * (classid=0, objid=key, objsubid=1). Used to know every worker has reached the
 * gate before we release them at once (mirrors claim-cas.test.ts).
 */
async function waitForWaiters(pool: Pool, gateKey: number, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND NOT granted`,
      [gateKey]
    );
    if ((r.rows[0]?.c ?? 0) >= n) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${n} advisory-lock waiters`);
}

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

  it('rotate writes the new credential_ref AND exactly one audit row atomically', async () => {
    const { agent, serviceUser } = await makeAgent();
    await bindShortcutIdentity(repo, {
      agentId: agent.id,
      shortcutAgentUserId: 'sc-agent-atomic',
      credentialRef: 'secret://shortcut/elvis/v1',
    });

    await rotateShortcutCredential(repo, agent.id, 'secret://shortcut/elvis/v2');

    const binding = await repo.getBinding(agent.id, 'shortcut');
    expect(binding?.credentialRef).toBe('secret://shortcut/elvis/v2');

    const rotations = (await repo.listAuditEvents(serviceUser.principalId)).filter(
      (e) => e.action === 'identity.binding.shortcut.credential_rotated'
    );
    expect(rotations).toHaveLength(1);
  });

  it('rotate rolls back the credential_ref when the audit append fails (no partial write)', async () => {
    const { agent, serviceUser } = await makeAgent();
    await bindShortcutIdentity(repo, {
      agentId: agent.id,
      shortcutAgentUserId: 'sc-agent-rollback',
      credentialRef: 'secret://shortcut/elvis/v1',
    });

    // Force the audit step inside the rotation's transaction to throw, exercising
    // the ROLLBACK path: the binding write must NOT survive, and no audit row may
    // be written. We spy on appendAuditEvent so the binding UPDATE has already run
    // when the failure fires (proving it is rolled back, not merely skipped).
    const failing = new PgIdentityRepository(pool);
    const realWithTransaction = failing.withTransaction.bind(failing);
    failing.withTransaction = (fn) =>
      realWithTransaction((tx) => {
        tx.appendAuditEvent = () => Promise.reject(new Error('injected audit failure'));
        return fn(tx);
      });

    await expect(
      rotateShortcutCredential(failing, agent.id, 'secret://shortcut/elvis/v2')
    ).rejects.toThrow('injected audit failure');

    // Credential unchanged (rolled back) …
    const binding = await repo.getBinding(agent.id, 'shortcut');
    expect(binding?.credentialRef).toBe('secret://shortcut/elvis/v1');
    // … and no rotation audit row was written.
    const rotations = (await repo.listAuditEvents(serviceUser.principalId)).filter(
      (e) => e.action === 'identity.binding.shortcut.credential_rotated'
    );
    expect(rotations).toHaveLength(0);
  });

  it('concurrent rotations serialize on the locked binding (both succeed, two audit rows)', async () => {
    const { agent, serviceUser } = await makeAgent();
    await bindShortcutIdentity(repo, {
      agentId: agent.id,
      shortcutAgentUserId: 'sc-agent-race',
      credentialRef: 'secret://shortcut/elvis/v0',
    });

    const GATE = 615243; // advisory-lock latch key (distinct from claim-cas)
    // A pool large enough that both rotations hold their own tx connection plus
    // the gate holder at once — so they genuinely overlap on the FOR UPDATE row
    // lock rather than being serialized by pool exhaustion.
    const racePool = new Pool({ connectionString: url, max: 6 });
    try {
      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      const refs = ['secret://shortcut/elvis/A', 'secret://shortcut/elvis/B'];
      const workers = refs.map((ref) =>
        (async () => {
          const client = await racePool.connect();
          try {
            await client.query('SELECT pg_advisory_lock_shared($1)', [GATE]); // park
            const txRepo = new PgIdentityRepository(racePool);
            return await rotateShortcutCredential(txRepo, agent.id, ref);
          } finally {
            await client.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
            client.release();
          }
        })()
      );

      await waitForWaiters(racePool, GATE, refs.length); // both parked
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE]); // release together
      gate.release();

      const results = await Promise.all(workers); // both must complete without error
      expect(results).toHaveLength(2);

      // Final credential_ref is one of the two (last committer wins the serialized order).
      const binding = await repo.getBinding(agent.id, 'shortcut');
      expect(refs).toContain(binding?.credentialRef);

      // No lost audit: exactly two rotation rows, one per rotation.
      const rotations = (await repo.listAuditEvents(serviceUser.principalId)).filter(
        (e) => e.action === 'identity.binding.shortcut.credential_rotated'
      );
      expect(rotations).toHaveLength(2);
    } finally {
      await racePool.end();
    }
  });

  it('audit_event is append-only: UPDATE/DELETE are no-ops, TRUNCATE still clears', async () => {
    const { agent, serviceUser } = await makeAgent();
    await repo.appendAuditEvent({
      principalId: serviceUser.principalId,
      agentId: agent.id,
      action: 'pr.create',
      target: 'PR-9',
    });

    // UPDATE is rewritten to NOTHING by the rule → row unchanged.
    await pool.query(`UPDATE audit_event SET action = 'x'`);
    let events = await repo.listAuditEvents(serviceUser.principalId);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('pr.create');

    // DELETE is rewritten to NOTHING by the rule → row still present.
    await pool.query(`DELETE FROM audit_event`);
    events = await repo.listAuditEvents(serviceUser.principalId);
    expect(events).toHaveLength(1);

    // TRUNCATE bypasses rules → row cleared (this is how test cleanup works).
    await pool.query(`TRUNCATE audit_event`);
    events = await repo.listAuditEvents(serviceUser.principalId);
    expect(events).toHaveLength(0);
  });

  it('withTransaction reuses a caller-supplied client tx (no nested BEGIN; rolls back with the outer)', async () => {
    const { agent, serviceUser } = await makeAgent();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A repo bound to an in-flight client: withTransaction must REUSE this tx
      // (isPool(client) === false), not try to open a nested one. With the old
      // connect()-based isPool this misclassified the client as a Pool.
      const txRepo = new PgIdentityRepository(client);
      await txRepo.withTransaction((r) =>
        r.appendAuditEvent({ principalId: serviceUser.principalId, agentId: agent.id, action: 'tx.test' })
      );
      // Visible inside the outer tx (same client)...
      const inTx = await client.query(`SELECT count(*)::int AS c FROM audit_event`);
      expect(inTx.rows[0]!.c).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // ...and gone after the OUTER rollback — proving it joined the caller's tx
    // rather than committing independently.
    const after = await repo.listAuditEvents(serviceUser.principalId);
    expect(after).toHaveLength(0);
  });
});

// Versioned agent writes (pause/resume/edit-profile) under optimistic concurrency:
// the agent row's `version` is the token. A stale write loses and learns the truth.
run('PgIdentityRepository — versioned agent writes (optimistic concurrency)', () => {
  let pool: Pool;
  let repo: PgIdentityRepository;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    for (const ddl of IDENTITY_SCHEMA_DDL) await pool.query(ddl);
    repo = new PgIdentityRepository(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE audit_event, identity_binding, delegation, capability_profile, service_user, agent, rbac_role CASCADE');
  });
  const make = () => repo.createAgent({ name: 'Elvis', model: 'claude-sonnet', vendor: 'claude' });

  it('setAgentStatus bumps the version and applies the status at the expected version', async () => {
    const { agent } = await make();
    expect(agent.version).toBe(0);
    const out = await repo.setAgentStatus(agent.id, 'paused', 0);
    expect(out).toEqual({ ok: true, version: 1 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent.status).toBe('paused');
    expect(got!.agent.version).toBe(1);
  });

  it('a stale-version write loses and surfaces currentVersion (no silent overwrite)', async () => {
    const { agent } = await make();
    await repo.setAgentStatus(agent.id, 'paused', 0); // version → 1
    const stale = await repo.setAgentStatus(agent.id, 'active', 0); // someone else already moved it
    expect(stale).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 1 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent.status).toBe('paused'); // NOT overwritten to active
  });

  it('setAgentStatus on a missing agent is not_found', async () => {
    expect(await repo.setAgentStatus('nope', 'paused', 0)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('updateCapabilityProfile atomically edits the profile + bumps the agent version', async () => {
    const { agent } = await make();
    await repo.setCapabilityProfile({
      agentId: agent.id, maxTier: 'low', tiersCovered: ['basic', 'low'],
      languageSpecialties: ['ts'], frameworkSpecialties: [], concurrencyLimit: 1, costCeiling: 5,
      successRate: null, avgLatencyMs: null,
    });
    const out = await repo.updateCapabilityProfile(agent.id, { maxTier: 'hard', concurrencyLimit: 4, costCeiling: null }, 0);
    expect(out).toEqual({ ok: true, version: 1 });
    const prof = await repo.getCapabilityProfile(agent.id);
    // cost_ceiling NULL = "no cap", which the mapper surfaces as 0.
    expect(prof).toMatchObject({ maxTier: 'hard', concurrencyLimit: 4, costCeiling: 0 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent.version).toBe(1);
  });

  it('updateCapabilityProfile persists the tier range + structured specialties when provided', async () => {
    const { agent } = await make();
    const out = await repo.updateCapabilityProfile(
      agent.id,
      {
        maxTier: 'hard',
        concurrencyLimit: 2,
        costCeiling: null,
        tiersCovered: ['low', 'medium', 'hard'],
        languageSpecialties: ['typescript', 'python'],
        frameworkSpecialties: ['react'],
      },
      0
    );
    expect(out).toEqual({ ok: true, version: 1 });
    const prof = await repo.getCapabilityProfile(agent.id);
    expect(prof).toMatchObject({
      maxTier: 'hard',
      tiersCovered: ['low', 'medium', 'hard'],
      languageSpecialties: ['typescript', 'python'],
      frameworkSpecialties: ['react'],
    });
  });

  it('updateCapabilityProfile PRESERVES specialties when the patch omits them (edit the three numerics alone)', async () => {
    const { agent } = await make();
    // First set specialties…
    await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'medium', concurrencyLimit: 1, costCeiling: null, languageSpecialties: ['go'], frameworkSpecialties: ['fastify'] },
      0
    );
    // …then edit only maxTier/concurrency/cost — the omitted specialty fields must NOT be wiped.
    const out = await repo.updateCapabilityProfile(agent.id, { maxTier: 'hard', concurrencyLimit: 3, costCeiling: 10 }, 1);
    expect(out).toEqual({ ok: true, version: 2 });
    const prof = await repo.getCapabilityProfile(agent.id);
    expect(prof).toMatchObject({
      maxTier: 'hard',
      concurrencyLimit: 3,
      languageSpecialties: ['go'], // preserved, not wiped to []
      frameworkSpecialties: ['fastify'],
    });
  });

  it('a PRESENT empty specialty array CLEARS it (absent=preserve, []=clear — the other half of the contract)', async () => {
    const { agent } = await make();
    await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'medium', concurrencyLimit: 1, costCeiling: null, languageSpecialties: ['go', 'rust'] },
      0
    );
    // A present [] is a deliberate clear (distinct from omitting the field, which preserves).
    const out = await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'medium', concurrencyLimit: 1, costCeiling: null, languageSpecialties: [] },
      1
    );
    expect(out).toEqual({ ok: true, version: 2 });
    const prof = await repo.getCapabilityProfile(agent.id);
    expect(prof!.languageSpecialties).toEqual([]); // cleared, not preserved
  });

  it('editing an agent that has NO profile row creates+persists it (no false success)', async () => {
    const { agent } = await make(); // createAgent does not seed a capability_profile
    expect(await repo.getCapabilityProfile(agent.id)).toBeNull(); // none yet
    const out = await repo.updateCapabilityProfile(agent.id, { maxTier: 'medium', concurrencyLimit: 2, costCeiling: 7 }, 0);
    expect(out).toEqual({ ok: true, version: 1 });
    // The edit actually landed — not a phantom success on a missing row.
    const prof = await repo.getCapabilityProfile(agent.id);
    expect(prof).toMatchObject({ maxTier: 'medium', concurrencyLimit: 2, costCeiling: 7 });
  });

  it('a conflicting profile edit does NOT half-apply (atomic CAS + profile update)', async () => {
    const { agent } = await make();
    await repo.setCapabilityProfile({
      agentId: agent.id, maxTier: 'low', tiersCovered: ['low'],
      languageSpecialties: [], frameworkSpecialties: [], concurrencyLimit: 1, costCeiling: 5,
      successRate: null, avgLatencyMs: null,
    });
    await repo.setAgentStatus(agent.id, 'paused', 0); // bump to version 1 out-of-band
    const stale = await repo.updateCapabilityProfile(agent.id, { maxTier: 'ultra', concurrencyLimit: 9, costCeiling: 99 }, 0);
    expect(stale).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 1 });
    // The profile is UNCHANGED — the edit rolled back with the failed CAS.
    const prof = await repo.getCapabilityProfile(agent.id);
    expect(prof).toMatchObject({ maxTier: 'low', concurrencyLimit: 1, costCeiling: 5 });
  });

  it('updateCapabilityProfile edits the identity fields + description atomically with the version bump', async () => {
    const { agent } = await make(); // Elvis / claude-sonnet / claude, no description
    const out = await repo.updateCapabilityProfile(
      agent.id,
      {
        maxTier: 'hard', concurrencyLimit: 2, costCeiling: null,
        name: 'Mona', vendor: 'openai', model: 'gpt-5', avatarUrl: 'https://x/a.png',
        description: '# Mona\nInstructions.',
      },
      0
    );
    expect(out).toEqual({ ok: true, version: 1 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent).toMatchObject({
      name: 'Mona', vendor: 'openai', model: 'gpt-5', avatarUrl: 'https://x/a.png',
      description: '# Mona\nInstructions.', version: 1,
    });
  });

  it('updateCapabilityProfile PRESERVES the identity fields when the patch omits them (edit capability alone)', async () => {
    const { agent } = await make();
    // Seed identity + description…
    await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'low', concurrencyLimit: 1, costCeiling: null, name: 'Elvis', description: 'keep me' },
      0
    );
    // …then edit only the capability subset — name/description must NOT be wiped.
    const out = await repo.updateCapabilityProfile(agent.id, { maxTier: 'hard', concurrencyLimit: 3, costCeiling: 10 }, 1);
    expect(out).toEqual({ ok: true, version: 2 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent).toMatchObject({ name: 'Elvis', description: 'keep me' });
  });

  it('a PRESENT null/empty description CLEARS it (absent=preserve, null/empty=clear)', async () => {
    const { agent } = await make();
    await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'low', concurrencyLimit: 1, costCeiling: null, description: 'temporary', avatarUrl: 'https://x/a.png' },
      0
    );
    // null clears description; '' clears avatar_url — both are deliberate clears, not omissions.
    const out = await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'low', concurrencyLimit: 1, costCeiling: null, description: null, avatarUrl: '' },
      1
    );
    expect(out).toEqual({ ok: true, version: 2 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent.description).toBeNull();
    expect(got!.agent.avatarUrl).toBe(''); // a present '' is stored as-given (the clear the form sends)
  });

  it('a conflicting identity edit does NOT half-apply — neither the agent row NOR the profile changes', async () => {
    const { agent } = await make();
    await repo.setAgentStatus(agent.id, 'paused', 0); // bump to version 1 out-of-band
    const stale = await repo.updateCapabilityProfile(
      agent.id,
      { maxTier: 'ultra', concurrencyLimit: 9, costCeiling: 99, name: 'SHOULD-NOT-LAND', description: 'nope' },
      0
    );
    expect(stale).toEqual({ ok: false, reason: 'version_conflict', currentVersion: 1 });
    const got = await repo.getAgentWithProfile(agent.id);
    expect(got!.agent.name).toBe('Elvis'); // identity untouched
    expect(got!.agent.description).toBeNull();
    expect(got!.profile).toBeNull(); // the profile UPSERT never ran either
  });
});
