// The credential broker's contract. The WHOLE point of this package is a process
// boundary that keeps the GitHub App master key OUT of the agent-runner: the worker
// holds the key and runs the broker server; the runner holds only a socket path and
// can ask for a short-lived, repo-scoped token — nothing else. The key is never part
// of any type here and never crosses the wire.

/** A short-lived token scoped to a single repo (a GitHub installation access token). */
export interface RepoToken {
  token: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
}

/**
 * Mints a repo-scoped token for `repoRef` ("owner/repo"). This is the ONLY thing in
 * the broker that touches credentials, and it is INJECTED by the worker — the App
 * private key is captured in this closure, inside the worker process. The broker
 * server invokes it and serializes only the returned {token, expiresAt}; the key
 * itself is never referenced by, returned from, or logged by the transport.
 */
export type RepoTokenMinter = (repoRef: string) => Promise<RepoToken>;

/** What a consumer (the agent-runner) sees: it can ask for a scoped token, nothing more. */
export interface CredentialBroker {
  mintRepoToken(repoRef: string): Promise<RepoToken>;
}

/** Wire request: a single repo ref. No credential ever appears in a request. */
export interface BrokerRequest {
  repoRef: string;
}

/** Wire response: a scoped token, or an opaque error. Never the App key. */
export type BrokerResponse =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string };

/** owner/repo — both segments restricted to GitHub-legal name characters (no spoofed
 *  second slash). NOTE: the dot is allowed (real repo names use it), so this alone
 *  would admit a `..` segment — `isValidRepoRef` additionally bans `..` so a request
 *  can never traverse to a different installation/path before reaching `mint`. */
export const REPO_REF_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A repoRef the broker will act on: shape-valid AND free of any `..` traversal. */
export function isValidRepoRef(s: unknown): s is string {
  return typeof s === 'string' && REPO_REF_RE.test(s) && !s.includes('..');
}
