import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { serveBroker, brokerClient, type BrokerServerHandle, type RepoTokenMinter } from './index';

// Real unix-socket round-trips. /tmp keeps the path short (unix socket paths are
// capped ~104 bytes; os.tmpdir() on macOS is too long).
const sockPath = () => `/tmp/tb-${randomBytes(6).toString('hex')}.sock`;

let servers: BrokerServerHandle[] = [];
async function start(mint: RepoTokenMinter): Promise<string> {
  const socketPath = sockPath();
  servers.push(await serveBroker({ socketPath, mint }));
  return socketPath;
}
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

// A master secret the worker holds; it must NEVER reach the client or the wire.
const MASTER_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMASTER-SECRET-DO-NOT-LEAK\n-----END-----';

describe('credential broker — round-trip', () => {
  it('mints a scoped token over the socket', async () => {
    const socketPath = await start(async (repoRef) => ({ token: `scoped-for-${repoRef}`, expiresAt: 123 }));
    const token = await brokerClient({ socketPath }).mintRepoToken('acme/widgets');
    expect(token).toEqual({ token: 'scoped-for-acme/widgets', expiresAt: 123 });
  });

  it('serves concurrent requests, each its own token', async () => {
    const socketPath = await start(async (r) => ({ token: `t-${r}`, expiresAt: 1 }));
    const client = brokerClient({ socketPath });
    const [a, b, c] = await Promise.all([
      client.mintRepoToken('o/a'),
      client.mintRepoToken('o/b'),
      client.mintRepoToken('o/c'),
    ]);
    expect([a.token, b.token, c.token]).toEqual(['t-o/a', 't-o/b', 't-o/c']);
  });
});

describe('THE INVARIANT — the master key never reaches the runner', () => {
  it('the App key lives only in the injected mint closure; the wire carries only the scoped token', async () => {
    // mint closes over the master key but returns ONLY a scoped token.
    const mint: RepoTokenMinter = async (repoRef) => {
      void MASTER_KEY; // captured here, in the worker — never returned
      return { token: `scoped-${repoRef}`, expiresAt: 9 };
    };
    const socketPath = await start(mint);

    // Capture the RAW bytes on the wire (what a compromised runner could read).
    const raw = await rawExchange(socketPath, JSON.stringify({ repoRef: 'acme/widgets' }) + '\n');
    expect(raw).not.toContain('MASTER-SECRET');
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).toContain('scoped-acme/widgets');

    const token = await brokerClient({ socketPath }).mintRepoToken('acme/widgets');
    expect(JSON.stringify(token)).not.toContain('MASTER-SECRET');
  });

  it('a mint error NEVER leaks its message to the wire (could carry credential detail)', async () => {
    const mint: RepoTokenMinter = async () => {
      throw new Error(`upstream rejected jwt signed with ${MASTER_KEY}`);
    };
    const socketPath = await start(mint);
    const raw = await rawExchange(socketPath, JSON.stringify({ repoRef: 'acme/widgets' }) + '\n');
    expect(raw).not.toContain('MASTER-SECRET');
    expect(raw).toContain('mint failed'); // generic, not the underlying message
    await expect(brokerClient({ socketPath }).mintRepoToken('acme/widgets')).rejects.toThrow('mint failed');
  });

  it('a bad repoRef NEVER invokes mint (no path traversal / owner spoof reaches credentials)', async () => {
    const calls: string[] = [];
    const mint: RepoTokenMinter = async (r) => {
      calls.push(r);
      return { token: 't', expiresAt: 1 };
    };
    const socketPath = await start(mint);
    const client = brokerClient({ socketPath });
    for (const bad of ['../etc', 'owner', 'a/b/c', 'owner/repo;rm', '', 'o/..']) {
      await expect(client.mintRepoToken(bad)).rejects.toThrow(/invalid repoRef/);
    }
    expect(calls).toEqual([]); // mint was never reached with a malformed ref
  });
});

describe('robustness', () => {
  it('a malformed (non-JSON) request is rejected without invoking mint', async () => {
    let called = false;
    const socketPath = await start(async () => {
      called = true;
      return { token: 't', expiresAt: 1 };
    });
    const raw = await rawExchange(socketPath, 'not json\n');
    expect(raw).toContain('invalid request');
    expect(called).toBe(false);
  });

  it('survives a failing request and serves the next one', async () => {
    let n = 0;
    const socketPath = await start(async (r) => {
      n++;
      if (n === 1) throw new Error('first fails');
      return { token: `t-${r}`, expiresAt: 1 };
    });
    const client = brokerClient({ socketPath });
    await expect(client.mintRepoToken('o/a')).rejects.toThrow('mint failed');
    expect((await client.mintRepoToken('o/b')).token).toBe('t-o/b'); // server still up
  });

  it('an oversized request is rejected and the server stays up (bounded memory)', async () => {
    const socketPath = await start(async (r) => ({ token: `t-${r}`, expiresAt: 1 }));
    const client = brokerClient({ socketPath });
    // A multi-KB request (no newline yet) trips the cap and the connection is dropped.
    await expect(client.mintRepoToken('o/' + 'x'.repeat(9000))).rejects.toThrow();
    // The server survived — a normal request still works.
    expect((await client.mintRepoToken('o/ok')).token).toBe('t-o/ok');
  });
});

/** Send raw bytes to the socket and collect the raw response (what's actually on the wire). */
function rawExchange(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (c: string) => {
      buf += c;
    });
    sock.on('close', () => resolve(buf));
    // The server may half-close while we're still flushing a large payload (EPIPE);
    // that's expected on the oversized path — resolve with whatever response arrived.
    sock.on('error', () => resolve(buf));
    setTimeout(() => {
      sock.destroy();
      resolve(buf);
    }, 2000);
  });
}
