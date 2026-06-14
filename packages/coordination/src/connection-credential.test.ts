import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  sealVendorKey,
  openVendorKey,
  fingerprintVendorKey,
  fingerprintAgentKey,
  fingerprintConnectionKey,
  isConnectionCredentialKind,
  ConnectionCredentialResolver,
  type SealedCredential,
  type SealedConnectionCredentialReader,
  type ConnectionCredentialKind,
} from './vendor-credential';

// Unit tests for the per-connection credential vault (slice SC-1). The seal primitives are shared with
// the org-vendor + per-agent paths (round-trip is covered there); here we cover the connection-credential
// additions: the fingerprint hash-domain separation, the kind guard, and the ConnectionCredentialResolver's
// cache + fail-closed contract (which the connection-scoped webhook route relies on to never throw).

const KEY = randomBytes(32);
const SECRET = 'shortcut-webhook-signing-secret-do-not-leak-0123456789';

/** A hand-rolled fake reader backing the resolver with in-memory sealed state. */
class FakeConnReader implements SealedConnectionCredentialReader {
  reads = 0;
  constructor(private sealed: SealedCredential | null) {}
  async getSealedConnectionCredential(_org: string, _conn: string, _kind: ConnectionCredentialKind) {
    this.reads++;
    return this.sealed;
  }
  set(s: SealedCredential | null) {
    this.sealed = s;
  }
}

describe('connection credential fingerprint — domain-separated from the vendor + agent fingerprints', () => {
  it('is non-reversible, deterministic, and reveals no secret bytes', () => {
    const fp = fingerprintConnectionKey('webhook_secret', SECRET);
    expect(fp).toHaveLength(16);
    expect(SECRET).not.toContain(fp);
    expect(fingerprintConnectionKey('webhook_secret', SECRET)).toBe(fp); // deterministic
    expect(fingerprintConnectionKey('webhook_secret', SECRET + 'x')).not.toBe(fp);
  });

  it('separates the two kinds (a webhook_secret and a read_token with the same bytes do not collide)', () => {
    expect(fingerprintConnectionKey('webhook_secret', SECRET)).not.toBe(fingerprintConnectionKey('read_token', SECRET));
  });

  it('uses a different hash domain than the vendor + agent fingerprints (no cross-collision)', () => {
    // Same plaintext through each fingerprint must NOT collide — the domains keep a connection secret,
    // an agent token, and an org vendor key distinct even if their bytes matched.
    expect(fingerprintConnectionKey('webhook_secret', SECRET)).not.toBe(fingerprintVendorKey('anthropic', SECRET));
    expect(fingerprintConnectionKey('webhook_secret', SECRET)).not.toBe(fingerprintAgentKey('shortcut', SECRET));
  });
});

describe('isConnectionCredentialKind', () => {
  it('accepts the two kinds, rejects anything else', () => {
    expect(isConnectionCredentialKind('webhook_secret')).toBe(true);
    expect(isConnectionCredentialKind('read_token')).toBe(true);
    expect(isConnectionCredentialKind('anthropic')).toBe(false);
    expect(isConnectionCredentialKind('shortcut')).toBe(false);
  });
});

describe('ConnectionCredentialResolver — use seam, ~60s cache, fail-closed', () => {
  it('resolves the decrypted secret and caches it (one store read within the TTL)', async () => {
    const reader = new FakeConnReader(sealVendorKey(SECRET, KEY));
    let t = 1000;
    const r = new ConnectionCredentialResolver(reader, KEY, () => t);
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBe(SECRET);
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBe(SECRET); // cached
    expect(reader.reads).toBe(1);
    t += 61_000; // past the 60s TTL
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBe(SECRET);
    expect(reader.reads).toBe(2); // re-read after expiry
  });

  it('returns null when there is no master key (→ webhook route 401s, never throws)', async () => {
    const r = new ConnectionCredentialResolver(new FakeConnReader(sealVendorKey(SECRET, KEY)), null);
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBeNull();
  });

  it('returns null when the connection has no secret of that kind configured', async () => {
    const r = new ConnectionCredentialResolver(new FakeConnReader(null), KEY);
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBeNull();
  });

  it('FAIL-CLOSED: a tampered/undecryptable row resolves to null, not a throw', async () => {
    const bad = sealVendorKey(SECRET, randomBytes(32)); // sealed under a DIFFERENT master key
    const r = new ConnectionCredentialResolver(new FakeConnReader(bad), KEY);
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBeNull();
  });

  it('the cache key is per (org, connection, kind) — a different tuple re-reads', async () => {
    const reader = new FakeConnReader(sealVendorKey(SECRET, KEY));
    const r = new ConnectionCredentialResolver(reader, KEY);
    await r.resolve('orgA', 'conn1', 'webhook_secret');
    await r.resolve('orgB', 'conn1', 'webhook_secret'); // different org → separate slot
    await r.resolve('orgA', 'conn1', 'read_token'); // different kind → separate slot
    expect(reader.reads).toBe(3);
  });

  it('invalidate() busts the cache so a re-set takes effect immediately', async () => {
    const reader = new FakeConnReader(sealVendorKey(SECRET, KEY));
    const r = new ConnectionCredentialResolver(reader, KEY);
    await r.resolve('org1', 'conn1', 'webhook_secret');
    r.invalidate('org1', 'conn1', 'webhook_secret');
    reader.set(sealVendorKey('rotated-secret', KEY));
    expect(await r.resolve('org1', 'conn1', 'webhook_secret')).toBe('rotated-secret'); // not the stale value
  });

  it('seal → open round-trips the secret (same AEAD as the vendor path)', () => {
    const sealed = sealVendorKey(SECRET, KEY);
    expect(openVendorKey(sealed, KEY)).toBe(SECRET);
    expect(JSON.stringify(sealed)).not.toContain(SECRET); // no plaintext at rest
  });
});
