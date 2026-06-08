// The worker-side scoped-token minter — the function injected into the credential
// broker (#236). The broker keeps the App MASTER key in this process; `mint` is the
// only thing that touches it, and it returns ONLY a per-task token. This minter
// resolves a task's `owner/repo` to its GitHub App installation and mints a token
// SCOPED TO THAT ONE REPO — never the whole installation. The runner therefore can
// only ever receive a one-repo, minimal-permission token for its assigned task.

import { isValidRepoRef, type RepoToken, type RepoTokenMinter } from '@tasca/broker';

export interface MinterDeps {
  /** Resolve the GitHub App installation id for a repo owner, or null if none. */
  resolveInstallation: (owner: string) => Promise<string | null>;
  /**
   * Mint an installation token scoped to the given repositories (a backstop in
   * @tasca/adapters rejects an empty list, which GitHub would treat as ALL repos, and
   * defaults to a minimal permission set). Wraps GitHubAppClient.mintScopedToken.
   */
  mintScoped: (installationId: string, scope: { repositories: string[] }) => Promise<RepoToken>;
}

/**
 * Build the broker's `mint(repoRef)`: owner/repo → installation → a token scoped to
 * JUST that repo. Throws on an invalid ref or a missing installation; the broker maps
 * any throw to a generic "mint failed" on the wire (never the underlying detail).
 */
export function makeRepoTokenMinter(deps: MinterDeps): RepoTokenMinter {
  return async (repoRef: string): Promise<RepoToken> => {
    // Validate here too (the broker already does) — defense in depth, and it bans `..`.
    if (!isValidRepoRef(repoRef)) {
      throw new Error(`minter: invalid repoRef ${JSON.stringify(repoRef)}`);
    }
    const slash = repoRef.indexOf('/');
    const owner = repoRef.slice(0, slash);
    const repo = repoRef.slice(slash + 1);
    const installationId = await deps.resolveInstallation(owner);
    if (installationId === null) {
      throw new Error(`minter: no GitHub App installation for owner ${owner}`);
    }
    // Scope to the ONE repo of this task — NOT every repo in the installation. (An
    // empty `repositories` would be installation-wide; #236's mintScopedToken rejects
    // that, and supplies the minimal agent permission set since none is passed here.)
    return deps.mintScoped(installationId, { repositories: [repo] });
  };
}
