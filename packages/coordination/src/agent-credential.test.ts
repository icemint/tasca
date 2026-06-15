import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  sealVendorKey,
  openVendorKey,
  fingerprintVendorKey,
  fingerprintAgentKey,
  isAgentCredentialProvider,
  AgentCredentialResolver,
  type SealedCredential,
  type SealedAgentCredentialReader,
  type AgentCredentialProvider,
} from './vendor-credential';

// Unit tests for the per-agent credential vault (slice SC-3). The seal primitives are shared with the
// org-vendor path (round-trip is covered there); here we cover the agent-credential additions: the
// fingerprint hash-domain separation, the provider guard, and the AgentCredentialResolver's cache +
// fail-closed contract (which the Shortcut status reporter relies on to never throw).

const KEY = randomBytes(32);
const TOKEN = 'shortcut-agent-user-token-do-not-leak-0123456789';

/** A hand-rolled fake reader backing the resolver with in-memory sealed state. */
class FakeAgentReader implements SealedAgentCredentialReader {
  reads = 0;
  constructor(private sealed: SealedCredential | null) {}
  async getSealedAgentCredential(_org: string, _agent: string, _p: AgentCredentialProvider) {
    this.reads++;
    return this.sealed;
  }
  set(s: SealedCredential | null) {
    this.sealed = s;
  }
}

describe('agent credential fingerprint — domain-separated from the vendor fingerprint', () => {
  it('is non-reversible, deterministic, and reveals no token bytes', () => {
    const fp = fingerprintAgentKey('shortcut', TOKEN);
    expect(fp).toHaveLength(16);
    expect(TOKEN).not.toContain(fp);
    expect(fingerprintAgentKey('shortcut', TOKEN)).toBe(fp); // deterministic
    expect(fingerprintAgentKey('shortcut', TOKEN + 'x')).not.toBe(fp);
  });

  it('uses a different hash domain than the vendor fingerprint (no cross-collision)', () => {
    // Same plaintext through both fingerprints must NOT collide — the domains ('agent:shortcut:' vs
    // 'anthropic:') keep an agent token and an org vendor key distinct even if their bytes matched.
    expect(fingerprintAgentKey('shortcut', TOKEN)).not.toBe(fingerprintVendorKey('anthropic', TOKEN));
  });
});

describe('isAgentCredentialProvider', () => {
  it('accepts shortcut + github, rejects anything else', () => {
    expect(isAgentCredentialProvider('shortcut')).toBe(true);
    expect(isAgentCredentialProvider('github')).toBe(true);
    expect(isAgentCredentialProvider('anthropic')).toBe(false);
    expect(isAgentCredentialProvider('linear')).toBe(false);
  });
});

describe('AgentCredentialResolver — injection seam, ~60s cache, fail-closed', () => {
  it('resolves the decrypted token and caches it (one store read within the TTL)', async () => {
    const reader = new FakeAgentReader(sealVendorKey(TOKEN, KEY));
    let t = 1000;
    const r = new AgentCredentialResolver(reader, KEY, () => t);
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBe(TOKEN);
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBe(TOKEN); // cached
    expect(reader.reads).toBe(1);
    t += 61_000; // past the 60s TTL
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBe(TOKEN);
    expect(reader.reads).toBe(2); // re-read after expiry
  });

  it('returns null when there is no master key (→ reporter skips, never throws)', async () => {
    const r = new AgentCredentialResolver(new FakeAgentReader(sealVendorKey(TOKEN, KEY)), null);
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBeNull();
  });

  it('returns null when the agent has no credential configured', async () => {
    const r = new AgentCredentialResolver(new FakeAgentReader(null), KEY);
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBeNull();
  });

  it('FAIL-CLOSED: a tampered/undecryptable row resolves to null, not a throw', async () => {
    const bad = sealVendorKey(TOKEN, randomBytes(32)); // sealed under a DIFFERENT master key
    const r = new AgentCredentialResolver(new FakeAgentReader(bad), KEY);
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBeNull();
  });

  it('the cache key is per (org, agent) — org B never reads org A’s token', async () => {
    // Distinct readers per tenant would be the prod reality; here one reader with a known token proves
    // the cache does not bleed: a second (org,agent) tuple is a separate cache slot, so it re-reads.
    const reader = new FakeAgentReader(sealVendorKey(TOKEN, KEY));
    const r = new AgentCredentialResolver(reader, KEY);
    await r.resolve('orgA', 'agent1', 'shortcut');
    await r.resolve('orgB', 'agent1', 'shortcut');
    expect(reader.reads).toBe(2); // not served orgA's cached entry
  });

  it('invalidate() busts the cache so a re-set takes effect immediately', async () => {
    const reader = new FakeAgentReader(sealVendorKey(TOKEN, KEY));
    const r = new AgentCredentialResolver(reader, KEY);
    await r.resolve('org1', 'agent1', 'shortcut');
    r.invalidate('org1', 'agent1', 'shortcut');
    reader.set(sealVendorKey('rotated-token', KEY));
    expect(await r.resolve('org1', 'agent1', 'shortcut')).toBe('rotated-token'); // not the stale value
  });

  it('seal → open round-trips the agent token (same AEAD as the vendor path)', () => {
    const sealed = sealVendorKey(TOKEN, KEY);
    expect(openVendorKey(sealed, KEY)).toBe(TOKEN);
    expect(JSON.stringify(sealed)).not.toContain(TOKEN); // no plaintext at rest
  });
});
