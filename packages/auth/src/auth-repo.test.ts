import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgAuthRepository, AUTH_SCHEMA_DDL } from './index';

// DB-backed proof of the auth primitive's invariants. Runs only when DATABASE_URL
// points at a Postgres (mirrors identity-repo.test.ts); skipped otherwise so the
// suite stays green without a DB. CI provides a Postgres.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run('PgAuthRepository (Postgres) — user upsert, state replay, session lifecycle', () => {
  let pool: Pool;
  let repo: PgAuthRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    for (const ddl of AUTH_SCHEMA_DDL) {
      await pool.query(ddl);
    }
    repo = new PgAuthRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE auth_session, auth_oauth_state, auth_identity, app_user CASCADE');
  });

  const sampleUser = {
    provider: 'github' as const,
    providerUserId: 'gh-1',
    email: 'Dev@Example.com',
    emailVerified: true,
    displayName: 'Dev',
    avatarUrl: 'http://a',
  };

  it('upsertUserFromProvider is idempotent on (provider, provider_user_id)', async () => {
    const a = await repo.upsertUserFromProvider(sampleUser);
    const b = await repo.upsertUserFromProvider(sampleUser);
    expect(b.id).toBe(a.id);
    expect(a.id).toMatch(/^usr_/);

    const count = await pool.query<{ c: number }>('SELECT count(*)::int AS c FROM app_user');
    expect(count.rows[0]!.c).toBe(1);
  });

  it('enforces one account per email regardless of case', async () => {
    await repo.upsertUserFromProvider(sampleUser);
    // A different provider account with the same email (different case) must
    // collide on the lower(email) unique index.
    await expect(
      repo.upsertUserFromProvider({ ...sampleUser, provider: 'google', providerUserId: 'goog-1', email: 'dev@example.com' })
    ).rejects.toThrow();
  });

  it('consumeOAuthState returns the row once then null (replay-safe)', async () => {
    const state = await repo.createOAuthState({ provider: 'github', codeVerifier: 'v', nonce: 'n', ttlSec: 600 });
    const first = await repo.consumeOAuthState(state);
    expect(first).toMatchObject({ provider: 'github', codeVerifier: 'v', nonce: 'n' });
    const second = await repo.consumeOAuthState(state);
    expect(second).toBeNull();
  });

  it('consumeOAuthState returns null for an expired state', async () => {
    const state = await repo.createOAuthState({ provider: 'google', codeVerifier: 'v', nonce: 'n', ttlSec: -1 });
    expect(await repo.consumeOAuthState(state)).toBeNull();
  });

  it('session lifecycle: create → get → touch → delete', async () => {
    const user = await repo.upsertUserFromProvider(sampleUser);
    const sid = await repo.createSession(user.id, 600);

    const got = await repo.getSession(sid);
    expect(got?.user.id).toBe(user.id);
    expect(got?.provider).toBe('github');
    const firstSeen = got!.lastSeenAt.getTime();

    await new Promise((r) => setTimeout(r, 10));
    await repo.touchSession(sid, 600);
    const touched = await repo.getSession(sid);
    expect(touched!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(firstSeen);

    await repo.deleteSession(sid);
    expect(await repo.getSession(sid)).toBeNull();
  });

  it('getSession returns null for an expired session', async () => {
    const user = await repo.upsertUserFromProvider(sampleUser);
    const sid = await repo.createSession(user.id, -1);
    expect(await repo.getSession(sid)).toBeNull();
  });

  it('deleteExpired sweeps expired sessions and states', async () => {
    const user = await repo.upsertUserFromProvider(sampleUser);
    await repo.createSession(user.id, -1); // expired
    await repo.createSession(user.id, 600); // live
    await repo.createOAuthState({ provider: 'github', codeVerifier: 'v', nonce: 'n', ttlSec: -1 });

    const removed = await repo.deleteExpired();
    expect(removed).toBe(2);
    const live = await pool.query<{ c: number }>('SELECT count(*)::int AS c FROM auth_session');
    expect(live.rows[0]!.c).toBe(1);
  });
});
