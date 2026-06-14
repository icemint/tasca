import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  sealVendorKey,
  fingerprintManagerKey,
  fingerprintAgentKey,
  fingerprintConnectionKey,
  fingerprintVendorKey,
  ManagerCredentialResolver,
  type SealedCredential,
  type SealedManagerCredentialReader,
  type ManagerCredentialProvider,
} from './vendor-credential';

const KEY = randomBytes(32);
const TOKEN = 'shortcut-em-token-do-not-leak-0123456789';
const ORG = 'org1';
const MGR = 'mgr-elvis';

// A real-state fake reader (mirrors the store's getSealedManagerCredential seam).
class FakeReader implements SealedManagerCredentialReader {
  rows = new Map<string, SealedCredential>();
  key(org: string, mgr: string, p: ManagerCredentialProvider) {
    return `${org}:${mgr}:${p}`;
  }
  async getSealedManagerCredential(org: string, mgr: string, p: ManagerCredentialProvider) {
    return this.rows.get(this.key(org, mgr, p)) ?? null;
  }
}

describe('fingerprintManagerKey — its OWN hash domain (no cross-entity collision)', () => {
  it('is deterministic, 16 chars, and reveals no token bytes', () => {
    const fp = fingerprintManagerKey('shortcut', TOKEN);
    expect(fp).toHaveLength(16);
    expect(TOKEN).not.toContain(fp);
    expect(fingerprintManagerKey('shortcut', TOKEN)).toBe(fp);
    expect(fingerprintManagerKey('shortcut', TOKEN + 'x')).not.toBe(fp);
  });

  it('the SAME token fingerprints DIFFERENTLY as a manager vs an agent/connection/vendor key', () => {
    const mgr = fingerprintManagerKey('shortcut', TOKEN);
    const agent = fingerprintAgentKey('shortcut', TOKEN);
    const conn = fingerprintConnectionKey('webhook_secret', TOKEN);
    const vendor = fingerprintVendorKey('anthropic', TOKEN);
    // every domain is distinct — a manager token can never collide with an agent/connection/vendor one
    expect(new Set([mgr, agent, conn, vendor]).size).toBe(4);
  });
});

describe('ManagerCredentialResolver — injection seam, ~60s cache, fail-closed', () => {
  it('resolves the sealed token to plaintext with the master key', async () => {
    const reader = new FakeReader();
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey(TOKEN, KEY));
    const resolver = new ManagerCredentialResolver(reader, KEY);
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBe(TOKEN);
  });

  it('FAIL-CLOSED: no master key → null (never throws)', async () => {
    const reader = new FakeReader();
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey(TOKEN, KEY));
    const resolver = new ManagerCredentialResolver(reader, null);
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBeNull();
  });

  it('FAIL-CLOSED: no stored row → null', async () => {
    const resolver = new ManagerCredentialResolver(new FakeReader(), KEY);
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBeNull();
  });

  it('FAIL-CLOSED: a row sealed under a DIFFERENT master key → null (tamper/wrong-key, no throw)', async () => {
    const reader = new FakeReader();
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey(TOKEN, randomBytes(32)));
    const resolver = new ManagerCredentialResolver(reader, KEY);
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBeNull();
  });

  it('caches within the TTL and re-resolves after expiry (injected clock)', async () => {
    const reader = new FakeReader();
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey(TOKEN, KEY));
    let now = 1_000;
    const resolver = new ManagerCredentialResolver(reader, KEY, () => now);
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBe(TOKEN);

    // mutate the underlying row; within the TTL the cached plaintext is still served
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey('rotated-token', KEY));
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBe(TOKEN);

    // past the TTL the resolver re-reads and serves the rotated token
    now += 61_000;
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBe('rotated-token');
  });

  it('invalidate drops the cache so a re-set is served immediately', async () => {
    const reader = new FakeReader();
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey(TOKEN, KEY));
    const resolver = new ManagerCredentialResolver(reader, KEY);
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBe(TOKEN);
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey('rotated-token', KEY));
    resolver.invalidate(ORG, MGR, 'shortcut');
    expect(await resolver.resolve(ORG, MGR, 'shortcut')).toBe('rotated-token');
  });

  it('is org+manager-scoped: another org cannot resolve this manager’s token', async () => {
    const reader = new FakeReader();
    reader.rows.set(reader.key(ORG, MGR, 'shortcut'), sealVendorKey(TOKEN, KEY));
    const resolver = new ManagerCredentialResolver(reader, KEY);
    expect(await resolver.resolve('other-org', MGR, 'shortcut')).toBeNull();
  });
});
