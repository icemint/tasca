// Workspace→org connect: the GitHub App INSTALLATION flow (slice 5c). A customer, from an
// authenticated session with an active org, installs the single shared Tasca App on their GitHub
// account; the resulting platform_connection binds to THEIR org. (This is the App-INSTALLATION
// flow — install the existing App — NOT the App-Manifest/create-App flow, which would be
// per-customer App registration, the deferred §10 enterprise path.)
//
// THE ATTRIBUTION PROBLEM: the `installation` webhook is server-to-server with no session and no
// `state` (GitHub round-trips `state` only to the Setup-URL redirect). So the webhook CANNOT
// securely attribute an install to an org — the CALLBACK binds (it has the session + the
// round-tripped nonce), the webhook only confirms.
//
// THREE-SIGNAL unforgeable binding at the callback:
//   1. the single-use nonce (issued from an authed begin, bound to {userId, activeOrg} AT BEGIN),
//   2. session.userId === the nonce's userId (a second, independent signal), and
//   3. the re-connect guard — an account already bound to a DIFFERENT org is refused (no hijack);
//      the SAME org is an allowed idempotent re-install.
// The nonce's org is AUTHORITATIVE — the callback binds to the org captured at begin, NOT a
// re-resolve of the session's current active org (a re-resolve would be a TOCTOU: switch org
// mid-flow → bind to the wrong one).

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Queryable } from './store';
import type { SessionInfo } from './read-api';
import type { Logger } from './ports';
import type { RoleReader } from './membership';
import { atLeast } from './membership';

/** The short-lived install-attribution nonce: ties a GitHub install back to the org that initiated
 *  it. Single-use (deleted on consume) + TTL'd; FK-cascaded so a deleted user/org drops it. */
export const GITHUB_INSTALL_STATE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS github_install_state (
  state      text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  org_id     text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);`;

/**
 * A GitHub account installs the App ONCE → at most one platform_connection (one org). Slice 3b
 * dropped the global `(platform, workspace_id)` unique for org-scoping; we re-add it for GitHub ONLY
 * as a NARROWER partial index, so the connect re-bind guard is DB-ENFORCED: two concurrent callbacks
 * cannot bind one account to two orgs (the second upsert fails this unique, where the read-then-write
 * app guard alone would race). Idempotent; safe on existing data (pre-5c installs are all org_default,
 * one row per account). Applied after platform_connection exists.
 */
export const GITHUB_CONNECTION_UNIQUE_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS platform_connection_github_account_uniq
  ON platform_connection (workspace_id) WHERE platform = 'github';`;

const STATE_TTL_SEC = 600; // 10 minutes to complete the GitHub install round-trip

export interface ConsumedState {
  userId: string;
  orgId: string;
}

/** The install-state nonce store. */
export interface GitHubInstallStateRepo {
  /** Mint a single-use nonce bound to {userId, orgId}; returns the state token. */
  issue(userId: string, orgId: string): Promise<string>;
  /** Atomically CONSUME a nonce (delete + return its binding) — null if unknown/expired/already
   *  used. Single-use is enforced by the delete: a replay finds no row. */
  consume(state: string): Promise<ConsumedState | null>;
  /** Sweep expired nonces. */
  deleteExpired(): Promise<number>;
}

export class PgGitHubInstallStateRepo implements GitHubInstallStateRepo {
  constructor(private readonly db: Queryable) {}

  async issue(userId: string, orgId: string): Promise<string> {
    const state = randomBytes(32).toString('hex');
    await this.db.query(
      `INSERT INTO github_install_state (state, user_id, org_id, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)`,
      [state, userId, orgId, String(STATE_TTL_SEC)]
    );
    return state;
  }

  async consume(state: string): Promise<ConsumedState | null> {
    const res = await this.db.query<{ user_id: string; org_id: string }>(
      `DELETE FROM github_install_state WHERE state = $1 AND expires_at > now()
       RETURNING user_id, org_id`,
      [state]
    );
    const row = res.rows[0];
    return row ? { userId: row.user_id, orgId: row.org_id } : null;
  }

  async deleteExpired(): Promise<number> {
    const res = await this.db.query(`DELETE FROM github_install_state WHERE expires_at <= now()`);
    return res.rowCount ?? 0;
  }
}

// ── the connect ports (narrow subsets of the App client + store) ───────────────

/** Resolve an installation's account login (the App client). */
export interface InstallAccountResolver {
  getInstallationAccount(installationId: string): Promise<string>;
}

/** The connection writes/reads the connect flow needs (subset of CoordinationStore). */
export interface ConnectionStore {
  getOrgForConnection(platform: 'shortcut' | 'github' | 'linear', workspaceId: string): Promise<string | null>;
  upsertGitHubInstallation(orgId: string, input: { workspaceId: string; installationId: string }): Promise<void>;
}

export interface GitHubConnectDeps {
  installState: GitHubInstallStateRepo;
  membership: RoleReader;
  store: ConnectionStore;
  appClient: InstallAccountResolver;
  /** The Tasca App's slug — the install URL is github.com/apps/<slug>/installations/new. */
  appSlug: string;
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  allowUnauthenticated?: boolean;
  logger?: Logger;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location }).end();
}

/**
 * Handle the GitHub connect routes (slice 5c). Returns true when it owned the request.
 *   GET /api/connect/github           — begin: admin+ → issue nonce → 302 to the GitHub install URL
 *   GET /api/connect/github/callback  — Setup URL: consume nonce → verify session → bind installation→org
 */
export async function githubConnectHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GitHubConnectDeps
): Promise<boolean> {
  if (req.url === undefined || req.method !== 'GET') return false;
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (path !== '/api/connect/github' && path !== '/api/connect/github/callback') return false;

  // ── session enforcement (the flow is initiated + completed in the user's browser) ──
  let session: SessionInfo | null = null;
  if (deps.verifySession) {
    try {
      session = await deps.verifySession(req);
    } catch (err) {
      deps.logger?.error('connect: session verification threw', { err: String(err) });
      res.writeHead(401).end('unauthorized');
      return true;
    }
    if (!session) {
      res.writeHead(401).end('unauthorized');
      return true;
    }
  } else if (!deps.allowUnauthenticated) {
    res.writeHead(503).end('auth not configured');
    return true;
  }
  const userId = session?.userId ?? '(dev)';

  try {
    if (path === '/api/connect/github') {
      // BEGIN — admin+ in the active org may connect a workspace (5b: manage-connections = admin).
      const orgId = await deps.membership.getActiveOrg(userId);
      if (orgId === null) {
        res.writeHead(403).end('no organization membership');
        return true;
      }
      const role = await deps.membership.getRole(userId, orgId);
      if (role === null || !atLeast(role, 'admin')) {
        res.writeHead(403).end('admin role required to connect a workspace');
        return true;
      }
      // Capture the org HERE (at begin). The nonce carries it; the callback binds to THIS org,
      // never a re-resolve at callback (which would let a mid-flow org-switch bind the wrong org).
      const state = await deps.installState.issue(userId, orgId);
      redirect(res, `https://github.com/apps/${encodeURIComponent(deps.appSlug)}/installations/new?state=${state}`);
      return true;
    }

    // CALLBACK (Setup URL) — ?installation_id & state.
    const installationId = url.searchParams.get('installation_id');
    const state = url.searchParams.get('state');
    if (!installationId || !state) {
      redirect(res, '/?connect=error&reason=missing_params');
      return true;
    }
    // SIGNAL 1: consume the single-use nonce (replay/expiry/forgery → null).
    const consumed = await deps.installState.consume(state);
    if (!consumed) {
      redirect(res, '/?connect=error&reason=bad_state');
      return true;
    }
    // SIGNAL 2: the session that completes the callback must be the user who began it.
    if (consumed.userId !== userId) {
      deps.logger?.error('connect: callback session does not match the nonce initiator', { userId });
      redirect(res, '/?connect=error&reason=session_mismatch');
      return true;
    }
    // The org is the one CAPTURED AT BEGIN (consumed.orgId) — authoritative, not re-resolved here.
    const account = await deps.appClient.getInstallationAccount(installationId);
    // SIGNAL 3: re-connect guard — refuse to claim an account already bound to a DIFFERENT org
    // (hijack). The SAME org is an allowed idempotent re-install (e.g. re-install after a delete).
    const existingOrg = await deps.store.getOrgForConnection('github', account);
    if (existingOrg !== null && existingOrg !== consumed.orgId) {
      deps.logger?.error('connect: account already bound to another org', { account });
      redirect(res, '/?connect=error&reason=already_connected');
      return true;
    }
    try {
      await deps.store.upsertGitHubInstallation(consumed.orgId, { workspaceId: account, installationId });
    } catch (e) {
      // The github-account partial unique caught a CONCURRENT callback that bound this account first
      // (the read-then-check guard above races; the DB index is the hard guarantee). Same outcome:
      // the account belongs to whoever won — refuse this bind.
      if ((e as { code?: string }).code === '23505') {
        deps.logger?.error('connect: account bound concurrently by another request', { account });
        redirect(res, '/?connect=error&reason=already_connected');
        return true;
      }
      throw e;
    }
    deps.logger?.info?.('connect: github workspace bound to org', { account });
    redirect(res, '/?connect=success');
    return true;
  } catch (err) {
    deps.logger?.error('connect: handler failed', { path, err: String(err) });
    redirect(res, '/?connect=error&reason=internal');
    return true;
  }
}
