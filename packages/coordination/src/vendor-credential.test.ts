import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  loadMasterKey,
  sealVendorKey,
  openVendorKey,
  fingerprintVendorKey,
  VendorKeyResolver,
  type SealedCredential,
  type SealedCredentialReader,
  type VendorProvider,
} from './vendor-credential';

const KEY = randomBytes(32);
const SECRET = 'sk-ant-SUPER-SECRET-do-not-leak-0123456789';

describe('vendor-credential crypto — AES-256-GCM, no plaintext at rest', () => {
  it('seal → open round-trips', () => {
    const sealed = sealVendorKey(SECRET, KEY);
    expect(openVendorKey(sealed, KEY)).toBe(SECRET);
  });

  it('the sealed blob contains NO plaintext (only ciphertext/nonce/tag)', () => {
    const sealed = sealVendorKey(SECRET, KEY);
    const blob = JSON.stringify(sealed);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain('sk-ant'); // not even a recognizable prefix
  });

  it('a WRONG master key cannot open it (GCM auth fails → throws)', () => {
    const sealed = sealVendorKey(SECRET, KEY);
    expect(() => openVendorKey(sealed, randomBytes(32))).toThrow();
  });

  it('TAMPERING with the ciphertext is detected (GCM auth → throws)', () => {
    const sealed = sealVendorKey(SECRET, KEY);
    const ct = Buffer.from(sealed.ciphertext, 'base64');
    ct[0]! ^= 0xff;
    const tampered: SealedCredential = { ...sealed, ciphertext: ct.toString('base64') };
    expect(() => openVendorKey(tampered, KEY)).toThrow();
  });

  it('two seals of the same key differ (random nonce) but both open', () => {
    const a = sealVendorKey(SECRET, KEY);
    const b = sealVendorKey(SECRET, KEY);
    expect(a.ciphertext).not.toBe(b.ciphertext); // nonce-randomized
    expect(openVendorKey(a, KEY)).toBe(openVendorKey(b, KEY));
  });

  it('fingerprint is non-reversible and reveals no key bytes', () => {
    const fp = fingerprintVendorKey('anthropic', SECRET);
    expect(fp).toHaveLength(16);
    expect(SECRET).not.toContain(fp);
    expect(fp).not.toContain('sk-ant');
    // deterministic for the same key, different for a different key
    expect(fingerprintVendorKey('anthropic', SECRET)).toBe(fp);
    expect(fingerprintVendorKey('anthropic', SECRET + 'x')).not.toBe(fp);
  });
});

describe('loadMasterKey — env only, never the DB', () => {
  it('parses a 32-byte hex key', () => {
    const hex = randomBytes(32).toString('hex');
    expect(loadMasterKey({ TASCA_SECRET_STORE_KEY: hex } as NodeJS.ProcessEnv)?.length).toBe(32);
  });
  it('parses a 32-byte base64 key', () => {
    const b64 = randomBytes(32).toString('base64');
    expect(loadMasterKey({ TASCA_SECRET_STORE_KEY: b64 } as NodeJS.ProcessEnv)?.length).toBe(32);
  });
  it('returns null when unset or wrong length (→ BYOK disabled, fail closed)', () => {
    expect(loadMasterKey({} as NodeJS.ProcessEnv)).toBeNull();
    expect(loadMasterKey({ TASCA_SECRET_STORE_KEY: 'too-short' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

class FakeReader implements SealedCredentialReader {
  reads = 0;
  constructor(private sealed: SealedCredential | null) {}
  async getSealedVendorCredential(_org: string, _p: VendorProvider) {
    this.reads++;
    return this.sealed;
  }
  set(s: SealedCredential | null) {
    this.sealed = s;
  }
}

describe('VendorKeyResolver — injection seam, ~60s cache, fail-closed', () => {
  it('resolves the decrypted key and caches it (one store read within the TTL)', async () => {
    const reader = new FakeReader(sealVendorKey(SECRET, KEY));
    let t = 1000;
    const r = new VendorKeyResolver(reader, KEY, () => t);
    expect(await r.resolve('org1', 'anthropic')).toBe(SECRET);
    expect(await r.resolve('org1', 'anthropic')).toBe(SECRET); // cached
    expect(reader.reads).toBe(1);
    t += 61_000; // past the 60s TTL
    expect(await r.resolve('org1', 'anthropic')).toBe(SECRET);
    expect(reader.reads).toBe(2); // re-read after expiry
  });

  it('returns null when there is no master key (→ heuristic / needs_attention)', async () => {
    const r = new VendorKeyResolver(new FakeReader(sealVendorKey(SECRET, KEY)), null);
    expect(await r.resolve('org1', 'anthropic')).toBeNull();
  });

  it('returns null when the org has no key', async () => {
    expect(await new VendorKeyResolver(new FakeReader(null), KEY).resolve('org1', 'anthropic')).toBeNull();
  });

  it('FAIL-CLOSED: a tampered/undecryptable row resolves to null, not a throw into routing', async () => {
    const bad = sealVendorKey(SECRET, randomBytes(32)); // sealed under a DIFFERENT master key
    expect(await new VendorKeyResolver(new FakeReader(bad), KEY).resolve('org1', 'anthropic')).toBeNull();
  });

  it('invalidate() busts the cache so a write takes effect immediately', async () => {
    const reader = new FakeReader(sealVendorKey(SECRET, KEY));
    const r = new VendorKeyResolver(reader, KEY);
    await r.resolve('org1', 'anthropic');
    r.invalidate('org1', 'anthropic');
    reader.set(sealVendorKey('sk-ant-ROTATED', KEY));
    expect(await r.resolve('org1', 'anthropic')).toBe('sk-ant-ROTATED'); // not the stale cached value
  });
});
