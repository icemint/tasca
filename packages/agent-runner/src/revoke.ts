// Revoke a scoped installation token when a task finishes. GitHub fixes installation
// tokens at ~1h and the API has NO knob to issue a shorter one — so the runner
// revokes the token at task end (DELETE /installation/token, authenticated by the
// token itself), making the token's EFFECTIVE lifetime the task duration (minutes),
// not the 1h cap. A compromised-mid-task runner therefore holds a one-repo,
// minimal-perm, soon-revoked credential. Best-effort: a revoke failure must NEVER
// fail the task (the token still self-expires at the 1h cap as a backstop).

const GITHUB_API = 'https://api.github.com';
const REVOKE_TIMEOUT_MS = 8000;

export interface RevokeOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/** Revoke `token`. Returns true on a 204 (revoked), false otherwise. Never throws. */
export async function revokeToken(token: string, opts: RevokeOptions = {}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${opts.apiBase ?? GITHUB_API}/installation/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}
