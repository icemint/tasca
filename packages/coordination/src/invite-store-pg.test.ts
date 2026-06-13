import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
import { AUTH_SCHEMA_DDL } from '@tasca/auth';
import { PgCoordinationStore } from './store';
import { COORDINATION_SCHEMA_DDL } from './schema';
import { ORG_MEMBERSHIP_TABLE_DDL, USER_ACTIVE_ORG_TABLE_DDL, PgOrgMembershipRepo } from './membership';
import { hashToken } from './invite';

// DB-backed proof of the slice-3.5-B.3.1 invite store: hashed-at-rest, single-use, expiring, org-scoped,
// possession-based enroll. Skipped without DATABASE_URL.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('org invites (Postgres) — hashed single-use, expiry, org-scoping, enroll', () => {
  const SCHEMA = 'invite_b331_test';
  let pool: Pool;
  let store: PgCoordinationStore;
  let membership: PgOrgMembershipRepo;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    await pool.query(DISPATCH_JOB_DDL);
    for (const ddl of AUTH_SCHEMA_DDL) await pool.query(ddl); // app_user
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl); // organization + org_invite
    await pool.query(ORG_MEMBERSHIP_TABLE_DDL); // accept enrolls here
    await pool.query(USER_ACTIVE_ORG_TABLE_DDL); // accept sets the active org here
    store = new PgCoordinationStore(pool);
    membership = new PgOrgMembershipRepo(pool);
    // Two orgs + a few users.
    await pool.query(`INSERT INTO organization (id, name) VALUES ('orgA','Org A'), ('orgB','Org B')`);
    for (const u of ['inviter', 'newcomer', 'existing', 'other']) {
      await pool.query(`INSERT INTO app_user (id, email) VALUES ($1, $2)`, [u, `${u}@x.test`]);
    }
    // `existing` is already a member of orgA (role member) — to prove accept doesn't downgrade.
    await pool.query(`INSERT INTO org_membership (user_id, org_id, role) VALUES ('existing','orgA','member')`);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await pool?.end();
  });

  const future = () => new Date(Date.now() + 60_000);
  const past = () => new Date(Date.now() - 60_000);

  it('create → listPending shows it (no token/hash exposed)', async () => {
    const tok = 'raw-token-1';
    const { id } = await store.createInvite('orgA', {
      email: 'a@x.test',
      role: 'member',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    const pending = await store.listPendingInvites('orgA');
    const row = pending.find((p) => p.id === id);
    expect(row).toBeTruthy();
    expect(row).toEqual({
      id,
      email: 'a@x.test',
      role: 'member',
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    // The summary must carry NO token/hash field.
    expect(JSON.stringify(row)).not.toContain(tok);
    expect(JSON.stringify(row)).not.toContain(hashToken(tok));
  });

  it('stores ONLY the token_hash = sha256(token); the raw token is never persisted', async () => {
    const tok = 'raw-token-secret-xyz';
    await store.createInvite('orgA', {
      email: 'hash@x.test',
      role: 'member',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    const stored = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM org_invite WHERE email = 'hash@x.test'`
    );
    expect(stored.rows[0]!.token_hash).toBe(hashToken(tok));
    // The raw token appears in NO column of the row.
    const dump = await pool.query(`SELECT * FROM org_invite WHERE email = 'hash@x.test'`);
    expect(JSON.stringify(dump.rows[0])).not.toContain(tok);
  });

  it('accept happy path: enrolls the user at the role, marks accepted, returns {ok,orgId,role}', async () => {
    const tok = 'accept-happy';
    await store.createInvite('orgA', {
      email: 'n@x.test',
      role: 'admin',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    const result = await store.acceptInvite(hashToken(tok), 'newcomer');
    expect(result).toEqual({ kind: 'ok', orgId: 'orgA', role: 'admin' });
    expect(await membership.getRole('newcomer', 'orgA')).toBe('admin');
    expect(await membership.getActiveOrg('newcomer')).toBe('orgA');
    const row = await pool.query<{ status: string; accepted_by: string }>(
      `SELECT status, accepted_by FROM org_invite WHERE token_hash = $1`,
      [hashToken(tok)]
    );
    expect(row.rows[0]).toMatchObject({ status: 'accepted', accepted_by: 'newcomer' });
  });

  it('single-use: a second accept of the same token is consumed', async () => {
    const tok = 'accept-twice';
    await store.createInvite('orgA', {
      email: 't@x.test',
      role: 'member',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    expect((await store.acceptInvite(hashToken(tok), 'other')).kind).toBe('ok');
    expect((await store.acceptInvite(hashToken(tok), 'other')).kind).toBe('consumed');
  });

  it('accept does NOT downgrade an existing member (keeps their role), still marks accepted', async () => {
    const tok = 'accept-existing';
    await store.createInvite('orgA', {
      email: 'e@x.test',
      role: 'owner', // higher than `existing`'s current member role
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    const result = await store.acceptInvite(hashToken(tok), 'existing');
    expect(result.kind).toBe('ok');
    expect(await membership.getRole('existing', 'orgA')).toBe('member'); // no downgrade/upgrade
    const row = await pool.query<{ status: string }>(`SELECT status FROM org_invite WHERE token_hash = $1`, [hashToken(tok)]);
    expect(row.rows[0]!.status).toBe('accepted');
  });

  it('accept of an EXPIRED invite is consumed', async () => {
    const tok = 'accept-expired';
    await store.createInvite('orgA', {
      email: 'exp@x.test',
      role: 'member',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: past(),
    });
    expect((await store.acceptInvite(hashToken(tok), 'other')).kind).toBe('consumed');
  });

  it('accept of an unknown token_hash is invalid', async () => {
    expect((await store.acceptInvite(hashToken('no-such-token'), 'other')).kind).toBe('invalid');
  });

  it('revoke flips pending → not-pending; a revoked invite then accepts as consumed', async () => {
    const tok = 'revoke-me';
    const { id } = await store.createInvite('orgA', {
      email: 'r@x.test',
      role: 'member',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    expect(await store.revokeInvite('orgA', id)).toBe(true);
    expect((await store.listPendingInvites('orgA')).find((p) => p.id === id)).toBeUndefined();
    // A second revoke of the same (now non-pending) invite changes no row.
    expect(await store.revokeInvite('orgA', id)).toBe(false);
    // The token of a revoked invite is consumed (not 'invalid' — the row exists, just not pending).
    expect((await store.acceptInvite(hashToken(tok), 'other')).kind).toBe('consumed');
  });

  it('cross-org: listPending/revoke are org-scoped — org B can neither see nor revoke org A\'s invite', async () => {
    const tok = 'cross-org';
    const { id } = await store.createInvite('orgA', {
      email: 'x@x.test',
      role: 'member',
      tokenHash: hashToken(tok),
      invitedBy: 'inviter',
      expiresAt: future(),
    });
    // Org B's pending list does not include org A's invite.
    expect((await store.listPendingInvites('orgB')).find((p) => p.id === id)).toBeUndefined();
    // Org B cannot revoke org A's invite (no row changes); it stays pending in org A.
    expect(await store.revokeInvite('orgB', id)).toBe(false);
    expect((await store.listPendingInvites('orgA')).find((p) => p.id === id)).toBeTruthy();
  });
});
