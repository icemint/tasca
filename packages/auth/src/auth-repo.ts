import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Provider } from './contract';

// Raw-`pg` repository for the human-login primitive — mirrors PgIdentityRepository
// (constructor takes a pool or single connection; plain SQL; rows mapped to
// camelCase). Boundary: imports ONLY @tasca/domain (none needed here) + pg + the
// local contract types.

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

export class PgAuthRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Find-or-create the app_user for a provider account. Keyed on
   * `auth_identity(provider, provider_user_id)`: if the binding exists we reuse
   * its user; otherwise we create a fresh app_user + binding. Either way the
   * user's last_login_at is bumped. Wrapped in a transaction so a user can never
   * exist without its anchoring identity row.
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
        user = existing.rows[0];
        await client.query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [user.id]);
      } else {
        const userId = `usr_${randomUUID()}`;
        const created = await client.query<AppUserRow>(
          `INSERT INTO app_user (id, email, email_verified, display_name, avatar_url, last_login_at)
           VALUES ($1,$2,$3,$4,$5, now())
           RETURNING id, email, email_verified, display_name, avatar_url`,
          [userId, input.email, input.emailVerified, input.displayName, input.avatarUrl]
        );
        user = created.rows[0]!;
        await client.query(
          `INSERT INTO auth_identity (id, user_id, provider, provider_user_id, provider_email)
           VALUES ($1,$2,$3,$4,$5)`,
          [`aid_${randomUUID()}`, userId, input.provider, input.providerUserId, input.email]
        );
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
        WHERE s.id = $1 AND s.expires_at > now()`,
      [id]
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

  /** Slide a session's lifetime: bump last_seen_at + extend expiry by ttlSec. */
  async touchSession(id: string, ttlSec: number): Promise<void> {
    await this.db.query(
      `UPDATE auth_session
          SET last_seen_at = now(),
              expires_at = now() + ($2 || ' seconds')::interval
        WHERE id = $1`,
      [id, String(ttlSec)]
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
