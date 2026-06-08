import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { serveBroker, brokerClient, type BrokerServerHandle } from '@tasca/broker';
import { makeRepoTokenMinter, type MinterDeps } from './broker-minter';

function setup(over: Partial<MinterDeps> = {}) {
  const mintCalls: Array<{ installationId: string; repositories: string[] }> = [];
  const resolveCalls: string[] = [];
  const deps: MinterDeps = {
    resolveInstallation: async (owner) => {
      resolveCalls.push(owner);
      return '4242';
    },
    mintScoped: async (installationId, scope) => {
      mintCalls.push({ installationId, repositories: scope.repositories });
      return { token: 'ghs_scoped', expiresAt: 9 };
    },
    ...over,
  };
  return { mint: makeRepoTokenMinter(deps), mintCalls, resolveCalls };
}

describe('makeRepoTokenMinter — scopes to the ONE task repo', () => {
  it('resolves owner→installation and mints a token scoped to JUST that repo (not all installation repos)', async () => {
    const { mint, mintCalls, resolveCalls } = setup();
    const token = await mint('acme/widgets');
    expect(token).toEqual({ token: 'ghs_scoped', expiresAt: 9 });
    expect(resolveCalls).toEqual(['acme']); // installation resolved by OWNER
    // The scope is exactly the one repo NAME — never empty (which GitHub reads as ALL repos).
    expect(mintCalls).toEqual([{ installationId: '4242', repositories: ['widgets'] }]);
    expect(mintCalls[0]!.repositories).not.toHaveLength(0);
  });

  it('throws when the owner has no installation (never mints)', async () => {
    const { mint, mintCalls } = setup({ resolveInstallation: async () => null });
    await expect(mint('acme/widgets')).rejects.toThrow(/no GitHub App installation for owner acme/);
    expect(mintCalls).toEqual([]);
  });

  it('rejects an invalid / traversal repoRef before resolving or minting', async () => {
    const { mint, mintCalls, resolveCalls } = setup();
    for (const bad of ['../etc', 'owner', 'a/b/c', 'o/..', '']) {
      await expect(mint(bad)).rejects.toThrow(/invalid repoRef/);
    }
    expect(resolveCalls).toEqual([]);
    expect(mintCalls).toEqual([]);
  });

  it('handles a repo name containing dots (real repo names) but still one repo', async () => {
    const { mint, mintCalls } = setup();
    await mint('acme/my.repo');
    expect(mintCalls[0]).toEqual({ installationId: '4242', repositories: ['my.repo'] });
  });
});

describe('end-to-end: the broker live with the real minter (worker mints → runner gets a scoped token)', () => {
  let server: BrokerServerHandle | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('a runner-side brokerClient receives a token scoped to its task repo; the App key never crosses', async () => {
    const APP_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMASTER-DO-NOT-LEAK\n-----END-----';
    const mintCalls: Array<{ installationId: string; repositories: string[] }> = [];
    const mint = makeRepoTokenMinter({
      resolveInstallation: async (owner) => (owner === 'acme' ? '99' : null),
      mintScoped: async (installationId, scope) => {
        void APP_KEY; // the key is closed over in the worker — never returned
        mintCalls.push({ installationId, repositories: scope.repositories });
        return { token: 'ghs_scoped_for_widgets', expiresAt: 123 };
      },
    });

    const socketPath = `/tmp/tbm-${randomBytes(6).toString('hex')}.sock`;
    server = await serveBroker({ socketPath, mint });

    // The runner side has ONLY the socket path.
    const token = await brokerClient({ socketPath }).mintRepoToken('acme/widgets');
    expect(token).toEqual({ token: 'ghs_scoped_for_widgets', expiresAt: 123 });
    expect(mintCalls).toEqual([{ installationId: '99', repositories: ['widgets'] }]); // scoped to the one repo
    expect(JSON.stringify(token)).not.toContain('MASTER-DO-NOT-LEAK'); // key never on the wire
  });

  it('a repo with no installation surfaces a GENERIC broker error (no internal detail leaks)', async () => {
    const mint = makeRepoTokenMinter({
      resolveInstallation: async () => null,
      mintScoped: async () => ({ token: 't', expiresAt: 1 }),
    });
    const socketPath = `/tmp/tbm-${randomBytes(6).toString('hex')}.sock`;
    server = await serveBroker({ socketPath, mint });
    // The broker maps the minter throw to a generic 'mint failed' (never the detail).
    await expect(brokerClient({ socketPath }).mintRepoToken('nobody/repo')).rejects.toThrow(/mint failed/);
  });
});
