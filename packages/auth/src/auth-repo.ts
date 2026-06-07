import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Provider } from './contract';

// Raw-`pg` repository for the human-login primitive — mirrors PgIdentityRepository
// (constructor takes a pool or single connection; plain SQL; rows mapped to
// camelCase). Boundary: imports only pg + the local contract types + node stdlib.

/** A pool or a single checked-out connection — both expose `.query`. */
export type Queryable = Pool | PoolClient;

export interface UpsertUserInput {
  provider: Provider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface AppUserRecord {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A live session joined to its user + the provider it was created through. */
export interface SessionRecord {
  sessionId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  user: AppUserRecord;
  provider: Provider;
}

export interface CreateOAuthStateInput {
  provider: Provider;
  codeVerifier: string;
  nonce: string;
  ttlSec: number;
}

export interface OAuthStateRecord {
  state: string;
  provider: Provider;
  codeVerifier: string;
  nonce: string;
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as Pool).connect === 'function';
}

/** Opaque session/state token: 32 random bytes, base64url (URL + cookie safe). */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Absolute session lifetime cap (30 days from `created_at`). The 7-day sliding
 * TTL would otherwise let an active session extend indefinitely; this caps the
 * total lifetime so a session is always re-authenticated at least monthly.
 * `getSession` treats a session past this as expired; `touchSession` never slides
 * `expires_at` beyond it.
 */
export const SESSION_ABSOLUTE_MAX_SEC = 30 * 24 * 60 * 60;

export class PgAuthRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Find-or-create the app_user for a provider account. Keyed on
   * `auth_identity(provider, provider_user_id)`: if the binding exists we reuse
   * its user; otherwise we create a fresh app_user + binding. Either way the
   * user's profile (last_login_at + the provider-sourced fields) is refreshed.
   * Wrapped in a transaction so a user can never exist without its anchoring
   * identity row.
   *
   * Race-safe on first login: two concurrent first logins of the same
   * (provider, provider_user_id) both SELECT empty, both INSERT an app_user, then
   * both race to INSERT the identity. The identity INSERT uses
   * `ON CONFLICT (provider, provider_user_id) DO NOTHING`; the loser sees no
   * RETURNING row, deletes the orphan app_user it just created, and falls back to
   * the existing identity's user — so neither caller errors and no duplicate
   * app_user survives.
   */
  async upsertUserFromProvider(input: UpsertUserInput): Promise<AppUserRecord> {
    const ownsTx = isPool(this.db);
    const client: Queryable = ownsTx ? await (this.db as Pool).connect() : this.db;
    try {
      if (ownsTx) await client.query('BEGIN');

      const existing = await client.query<AppUserRow>(
        `SELECT u.id, u.email, u.email_verified, u.display_name, u.avatar_url
           FROM auth_identity i
           JOIN app_user u ON u.id = i.user_id
          WHERE i.provider = $1 AND i.provider_user_id = $2`,
        [input.provider, input.providerUserId]
      );

      let user: AppUserRow;
      if (existing.rows[0]) {
        // Existing account: refresh the provider-sourced profile so it doesn't go
        // stale between logins, and bump last_login_at.
        user = await this.refreshUser(client, existing.rows[0].id, input);
      } else {
        const userId = `usr_${randomUUID()}`;
        const created = await client.query<AppUserRow>(
          `INSERT INTO app_user (id, email, email_verified, display_name, avatar_url, last_login_at)
           VALUES ($1,$2,$3,$4,$5, now())
           RETURNING id, email, email_verified, display_name, avatar_url`,
          [userId, input.email, input.emailVerified, input.displayName, input.avatarUrl]
        );
        const won = await client.query(
          `INSERT INTO auth_identity (id, user_id, provider, provider_user_id, provider_email)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (provider, provider_user_id) DO NOTHING
           RETURNING id`,
          [`aid_${randomUUID()}`, userId, input.provider, input.providerUserId, input.email]
        );
        if (won.rows[0]) {
          user = created.rows[0]!;
        } else {
          // Lost the first-login race: another tx already created the identity.
          // Drop the orphan app_user we just made and adopt the winner's user.
          await client.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
          const winner = await client.query<AppUserRow>(
            `SELECT u.id, u.email, u.email_verified, u.display_name, u.avatar_url
               FROM auth_identity i
               JOIN app_user u ON u.id = i.user_id
              WHERE i.provider = $1 AND i.provider_user_id = $2`,
            [input.provider, input.providerUserId]
          );
          user = await this.refreshUser(client, winner.rows[0]!.id, input);
        }
      }

      if (ownsTx) await client.query('COMMIT');
      return mapUser(user);
    } catch (err) {
      if (ownsTx) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (ownsTx) (client as PoolClient).release();
    }
  }

  /**
   * Refresh an existing user's provider-sourced profile on login + bump
   * last_login_at. Keeps email/display_name/avatar_url/email_verified current so
   * they don't drift from the provider between sessions. Parameterized.
   */
  private async refreshUser(
    client: Queryable,
    userId: string,
    input: UpsertUserInput
  ): Promise<AppUserRow> {
    const updated = await client.query<AppUserRow>(
      `UPDATE app_user
          SET email = $2,
              email_verified = $3,
              display_name = $4,
              avatar_url = $5,
              last_login_at = now()
        WHERE id = $1
        RETURNING id, email, email_verified, display_name, avatar_url`,
      [userId, input.email, input.emailVerified, input.displayName, input.avatarUrl]
    );
    return updated.rows[0]!;
  }

  /** Persist a fresh OAuth-flow state row; returns its `state` token. */
  async createOAuthState(input: CreateOAuthStateInput): Promise<string> {
    const state = newToken();
    await this.db.query(
      `INSERT INTO auth_oauth_state (state, provider, code_verifier, nonce, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)`,
      [state, input.provider, input.codeVerifier, input.nonce, String(input.ttlSec)]
    );
    return state;
  }

  /**
   * Atomically SELECT-and-DELETE an OAuth state row. Returns the row, or null if
   * it is absent OR expired. Replay-safe: a second consume of the same state
   * finds nothing (the first DELETE removed it) and returns null. The
   * SELECT+DELETE runs in one tx on a single checked-out client so two parallel
   * callbacks can't both win the same state.
   */
  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const ownsTx = isPool(this.db);
    const client: Queryable = ownsTx ? await (this.db as Pool).connect() : this.db;
    try {
      if (ownsTx) await client.query('BEGIN');
      const res = await client.query<OAuthStateRow>(
        `DELETE FROM auth_oauth_state
          WHERE state = $1 AND expires_at > now()
        RETURNING state, provider, code_verifier, nonce`,
        [state]
      );
      if (ownsTx) await client.query('COMMIT');
      const row = res.rows[0];
      return row
        ? {
            state: row.state,
            provider: row.provider as Provider,
            codeVerifier: row.code_verifier,
            nonce: row.nonce,
          }
        : null;
    } catch (err) {
      if (ownsTx) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (ownsTx) (client as PoolClient).release();
    }
  }

  /** Create a session row; the returned token IS the cookie value (the row PK). */
  async createSession(userId: string, ttlSec: number): Promise<string> {
    const id = newToken();
    await this.db.query(
      `INSERT INTO auth_session (id, user_id, expires_at)
       VALUES ($1,$2, now() + ($3 || ' seconds')::interval)`,
      [id, userId, String(ttlSec)]
    );
    return id;
  }

  /**
   * Resolve a session id to its user (joined) — or null if the session is
   * missing or expired. The provider is the most recently linked identity for
   * that user (the one they most likely just signed in with).
   */
  async getSession(id: string): Promise<SessionRecord | null> {
    const res = await this.db.query<SessionJoinRow>(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
              u.id, u.email, u.email_verified, u.display_name, u.avatar_url,
              (SELECT i.provider FROM auth_identity i
                WHERE i.user_id = u.id ORDER BY i.linked_at DESC LIMIT 1) AS provider
         FROM auth_session s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.id = $1
          AND s.expires_at > now()
          AND s.created_at + ($2 || ' seconds')::interval > now()`,
      [id, String(SESSION_ABSOLUTE_MAX_SEC)]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      user: mapUser(row),
      // A session always has at least one identity (created via OAuth); default
      // to github only as a type-safe fallback if the subquery somehow returns null.
      provider: (row.provider ?? 'github') as Provider,
    };
  }

  /**
   * Slide a session's lifetime: bump last_seen_at + extend expiry by ttlSec, but
   * never past the absolute cap (`created_at + SESSION_ABSOLUTE_MAX_SEC`). The
   * new expiry is `LEAST(now()+ttl, created_at+cap)` so the sliding window can
   * never push a session beyond its absolute lifetime.
   */
  async touchSession(id: string, ttlSec: number): Promise<void> {
    await this.db.query(
      `UPDATE auth_session
          SET last_seen_at = now(),
              expires_at = LEAST(
                now() + ($2 || ' seconds')::interval,
                created_at + ($3 || ' seconds')::interval
              )
        WHERE id = $1`,
      [id, String(ttlSec), String(SESSION_ABSOLUTE_MAX_SEC)]
    );
  }

  /** Delete a session (logout). Idempotent. */
  async deleteSession(id: string): Promise<void> {
    await this.db.query(`DELETE FROM auth_session WHERE id = $1`, [id]);
  }

  /** Sweep expired sessions + states. Returns the total rows removed. */
  async deleteExpired(): Promise<number> {
    const s = await this.db.query(`DELETE FROM auth_session WHERE expires_at <= now()`);
    const o = await this.db.query(`DELETE FROM auth_oauth_state WHERE expires_at <= now()`);
    return (s.rowCount ?? 0) + (o.rowCount ?? 0);
  }
}

// ── Row mappers ────────────────────────────────────────────────────────────────

interface AppUserRow {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  avatar_url: string | null;
}

interface OAuthStateRow {
  state: string;
  provider: string;
  code_verifier: string;
  nonce: string;
}

interface SessionJoinRow extends AppUserRow {
  session_id: string;
  expires_at: Date;
  last_seen_at: Date;
  provider: string | null;
}

function mapUser(row: AppUserRow): AppUserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}
