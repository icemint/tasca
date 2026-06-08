import { createSign } from 'node:crypto';

// @tasca/adapters — the GitHub App client. Mints a short-lived App JWT (RS256)
// from the App id + PEM private key, exchanges it for an installation access
// token, and issues authenticated REST calls under that installation.
//
// Identity model: a GitHub App acts as `app[bot]` per INSTALLATION. The App JWT
// authenticates the App itself (only to mint installation tokens); the
// installation token authenticates the per-customer write-back (issue comment +
// state). Tokens are short-lived (~1h), so we cache them in memory keyed by
// installation id and re-mint a safety margin before expiry. The token is NEVER
// persisted — it lives only in this process's cache.
//
// Boundary: imports ONLY node builtins. NO new runtime deps — the JWT is signed
// with node:crypto (RSA-SHA256) + base64url, not jsonwebtoken/jose; all HTTP is
// the global fetch with an AbortSignal.timeout.

/** GitHub REST v3 base. Overridable for tests; no trailing slash. */
const DEFAULT_API_BASE = 'https://api.github.com';

/** App JWT lifetime: GitHub caps it at 10 minutes; use 600s exactly. */
const JWT_TTL_SECONDS = 600;

/**
 * Re-mint an installation token this many ms BEFORE its stated expiry, so a
 * call never races a token that expires mid-flight (clock skew + request time).
 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Per-call timeout for every GitHub HTTP request. */
const REQUEST_TIMEOUT_MS = 8000;

export interface GitHubAppClientConfig {
  /** The numeric GitHub App id (as a string or number). */
  appId: string | number;
  /**
   * The App's RSA private key, PEM-encoded. Accepts PKCS#1 (`BEGIN RSA PRIVATE
   * KEY`, GitHub's download) or PKCS#8 (`BEGIN PRIVATE KEY`). Env-mangled forms are
   * tolerated: literal `\n` escapes are restored to newlines, and a base64-encoded
   * PEM (no header) is decoded — see normalizePrivateKey.
   */
  privateKey: string;
  /** REST v3 base override (tests). Defaults to the public GitHub API. */
  apiBase?: string;
  /** fetch override (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Clock override (tests). Returns epoch ms; defaults to Date.now. */
  now?: () => number;
}

/** A minted installation access token + its absolute expiry (epoch ms). */
export interface InstallationToken {
  token: string;
  /** Absolute expiry as epoch ms (parsed from GitHub's `expires_at`). */
  expiresAt: number;
}

/**
 * Normalize a PEM private key sourced from an env var. Env/secret stores routinely
 * mangle multi-line PEMs two ways: escaping newlines as the literal characters
 * `\n`, or (when the store can't hold newlines at all) base64-encoding the whole
 * PEM onto one line. OpenSSL rejects both with `DECODER routines::unsupported`.
 * Restore literal `\n` to real newlines, and base64-decode a key that has no PEM
 * header. Format (PKCS#1 `BEGIN RSA PRIVATE KEY` vs PKCS#8 `BEGIN PRIVATE KEY`) is
 * NOT touched — node:crypto accepts both; only the transport corruption is undone.
 */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  if (!key.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8').trim();
      if (decoded.includes('-----BEGIN')) key = decoded;
    } catch {
      // leave as-is; the signer (and the boot decode-check) will report it clearly
    }
  }
  return key;
}

/** base64url-encode a Buffer or UTF-8 string (no padding), per JWS. */
function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The GitHub App client. Mints App JWTs (RS256), exchanges them for installation
 * tokens (cached in memory, re-minted before expiry), and runs authenticated
 * REST requests under an installation token.
 */
export class GitHubAppClient {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /** In-memory installation-token cache, keyed by installation id. */
  private readonly tokenCache = new Map<string, InstallationToken>();

  constructor(config: GitHubAppClientConfig) {
    if (config.appId === undefined || config.appId === null || String(config.appId) === '') {
      throw new Error('GitHubAppClient: appId is required');
    }
    if (!config.privateKey) {
      throw new Error('GitHubAppClient: privateKey (PEM) is required');
    }
    this.appId = String(config.appId);
    // Undo env-transport corruption (escaped newlines / base64) before the PEM
    // reaches OpenSSL. validateSigningKey() (or the first sign) surfaces a key that
    // still won't decode.
    this.privateKey = normalizePrivateKey(config.privateKey);
    this.apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  /**
   * Mint a short-lived App JWT (RS256). The header is `{alg:'RS256',typ:'JWT'}`;
   * the payload is `{iss: appId, iat, exp}` with `exp - iat == 600s`. `iat` is
   * backdated 60s to absorb clock skew between us and GitHub (a JWT whose `iat`
   * is in GitHub's future is rejected). Signed with RSA-SHA256 over
   * `base64url(header).base64url(payload)`; the JWT authenticates ONLY the App,
   * used to mint installation tokens.
   */
  mintAppJwt(): string {
    const nowSec = Math.floor(this.now() / 1000);
    const iat = nowSec - 60;
    const exp = iat + JWT_TTL_SECONDS;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iss: this.appId, iat, exp }));
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(this.privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  /**
   * Decode-check the configured private key by signing a throwaway JWT. Cheap and
   * offline (no network) — call once at boot so a mangled/garbage PEM fails LOUDLY
   * at startup with an actionable message, instead of as a cryptic OpenSSL
   * `DECODER routines::unsupported` at the first dispatch. Throws on failure.
   */
  validateSigningKey(): void {
    try {
      this.mintAppJwt();
    } catch (err) {
      throw new Error(
        'GitHubAppClient: private key failed to decode/sign — check GITHUB_APP_PRIVATE_KEY ' +
          `(newlines or format): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Get an installation access token for `installationId`, minting one if the
   * cache is empty or the cached token is within the refresh margin of expiry.
   * POSTs `${apiBase}/app/installations/{id}/access_tokens` authenticated by the
   * App JWT. The token is cached in memory only and NEVER persisted.
   */
  async getInstallationToken(installationId: string): Promise<InstallationToken> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached;
    }

    const jwt = this.mintAppJwt();
    const res = await this.fetchImpl(
      `${this.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `github installation-token failed: ${res.status} ${res.statusText} ${detail}`.trim()
      );
    }
    const json = (await res.json()) as { token?: string; expires_at?: string };
    if (!json.token || !json.expires_at) {
      throw new Error('github installation-token: response missing token/expires_at');
    }
    const minted: InstallationToken = {
      token: json.token,
      expiresAt: new Date(json.expires_at).getTime(),
    };
    this.tokenCache.set(installationId, minted);
    return minted;
  }

  /**
   * Issue an authenticated REST request under an installation token. `path` is a
   * leading-slash API path (`/repos/{owner}/{repo}/issues/{n}/comments`); `body`
   * is JSON-serialized when present. Resolves to the parsed JSON (or null for an
   * empty body); throws on a non-2xx.
   */
  async request(
    token: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `github ${method} ${path} failed: ${res.status} ${res.statusText} ${detail}`.trim()
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
