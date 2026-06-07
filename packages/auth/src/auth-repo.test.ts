import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgAuthRepository, AUTH_SCHEMA_DDL, SESSION_ABSOLUTE_MAX_SEC } from './index';

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

  it('refreshes the existing user profile from the provider on each login', async () => {
    const first = await repo.upsertUserFromProvider(sampleUser);
    // Same provider account logs in again with an updated provider profile.
    const refreshed = await repo.upsertUserFromProvider({
      ...sampleUser,
      email: 'dev@example.com',
      emailVerified: false,
      displayName: 'Dev Renamed',
      avatarUrl: 'http://b',
    });
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.displayName).toBe('Dev Renamed');
    expect(refreshed.avatarUrl).toBe('http://b');
    expect(refreshed.emailVerified).toBe(false);
    expect(refreshed.email).toBe('dev@example.com');
  });

  it('is race-safe: a pre-existing identity for (provider, provider_user_id) yields the existing user, no duplicate', async () => {
    const existing = await repo.upsertUserFromProvider(sampleUser);
    // Simulate the lost-race branch: the identity for (provider, provider_user_id)
    // already exists when a concurrent first login runs. It must return the SAME
    // user and must not leave a duplicate app_user behind.
    const again = await repo.upsertUserFromProvider(sampleUser);
    expect(again.id).toBe(existing.id);
    const users = await pool.query<{ c: number }>('SELECT count(*)::int AS c FROM app_user');
    expect(users.rows[0]!.c).toBe(1);
    const ids = await pool.query<{ c: number }>('SELECT count(*)::int AS c FROM auth_identity');
    expect(ids.rows[0]!.c).toBe(1);
  });

  it('two concurrent first logins of the same account converge on one user (no unique violation)', async () => {
    // Both calls race: each SELECTs empty, each INSERTs an app_user, then both
    // race the identity INSERT. The loser's ON CONFLICT DO NOTHING + orphan
    // cleanup must make BOTH resolve to the same user with no duplicate rows.
    const [a, b] = await Promise.all([
      repo.upsertUserFromProvider(sampleUser),
      repo.upsertUserFromProvider(sampleUser),
    ]);
    expect(a.id).toBe(b.id);
    const users = await pool.query<{ c: number }>('SELECT count(*)::int AS c FROM app_user');
    expect(users.rows[0]!.c).toBe(1);
    const ids = await pool.query<{ c: number }>('SELECT count(*)::int AS c FROM auth_identity');
    expect(ids.rows[0]!.c).toBe(1);
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

  it('getSession returns null past the absolute cap even when the sliding expiry is live', async () => {
    const user = await repo.upsertUserFromProvider(sampleUser);
    const sid = await repo.createSession(user.id, 600); // sliding expiry is live
    // Backdate created_at to just beyond the absolute cap; the sliding expires_at
    // remains in the future, so only the absolute cap can expire this session.
    await pool.query(
      `UPDATE auth_session
          SET created_at = now() - ($2 || ' seconds')::interval
        WHERE id = $1`,
      [sid, String(SESSION_ABSOLUTE_MAX_SEC + 60)]
    );
    expect(await repo.getSession(sid)).toBeNull();
  });

  it('touchSession never slides expiry past the absolute cap', async () => {
    const user = await repo.upsertUserFromProvider(sampleUser);
    const sid = await repo.createSession(user.id, 600);
    // Age the session to one hour short of the cap, then slide by the full TTL.
    await pool.query(
      `UPDATE auth_session
          SET created_at = now() - ($2 || ' seconds')::interval
        WHERE id = $1`,
      [sid, String(SESSION_ABSOLUTE_MAX_SEC - 3600)]
    );
    await repo.touchSession(sid, 7 * 24 * 60 * 60); // 7-day slide would overshoot the cap
    const row = await pool.query<{ expires_at: Date; cap: Date }>(
      `SELECT expires_at, created_at + ($2 || ' seconds')::interval AS cap
         FROM auth_session WHERE id = $1`,
      [sid, String(SESSION_ABSOLUTE_MAX_SEC)]
    );
    // expires_at is clamped to the cap, not pushed a week out.
    expect(row.rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(row.rows[0]!.cap.getTime());
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
