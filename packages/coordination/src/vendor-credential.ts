// BYOK vendor-credential vault (slice 3.5-A, the keystone). Custodial AEAD: each org's vendor key is
// sealed with AES-256-GCM under a master key held in the SERVER ENV (`TASCA_SECRET_STORE_KEY`), NEVER in
// the DB — so a DB-only breach yields ciphertext that is useless without the env-held key. Plaintext
// exists ONLY transiently here (seal at write, open at injection); it is never persisted, logged, or
// returned by any API (write-only from the UI: set/replace/delete, never read back). Vendor-agnostic by
// shape (a `provider` enum + the resolver seam); Anthropic is the only live provider today.
//
// No homegrown crypto — node:crypto AES-256-GCM (12-byte nonce, 16-byte auth tag), the standard AEAD.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/** Vendor enum — vendor-agnostic by shape; only `anthropic` is live (OpenAI later = a new provider). */
export type VendorProvider = 'anthropic';
export const VENDOR_PROVIDERS: readonly VendorProvider[] = ['anthropic'];
export function isVendorProvider(v: string): v is VendorProvider {
  return (VENDOR_PROVIDERS as readonly string[]).includes(v);
}

/** What persists — ciphertext + nonce + auth tag (all base64). NO key material is recoverable from this
 *  alone; the env-held master key is required to open it. */
export interface SealedCredential {
  ciphertext: string;
  nonce: string;
  authTag: string;
}

/** Load the 32-byte master KEK from the server env (hex or base64). NEVER read from the DB. Returns null
 *  when unset/malformed → the BYOK surface is disabled and callers fail closed (no key → heuristic /
 *  needs_attention). */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.TASCA_SECRET_STORE_KEY;
  if (!raw) return null;
  let key: Buffer;
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      return null;
    }
  }
  return key.length === 32 ? key : null;
}

/** AES-256-GCM seal. */
export function sealVendorKey(plaintext: string, masterKey: Buffer): SealedCredential {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/** AES-256-GCM open. THROWS on a wrong master key or any tampering (GCM authenticates ciphertext+tag). */
export function openVendorKey(sealed: SealedCredential, masterKey: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(sealed.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  return decipher.update(Buffer.from(sealed.ciphertext, 'base64'), undefined, 'utf8') + decipher.final('utf8');
}

/** A non-reversible fingerprint for display / "same key?" dedup — reveals NO bytes of the key. */
export function fingerprintVendorKey(provider: VendorProvider, plaintext: string): string {
  return createHash('sha256').update(`${provider}:${plaintext}`).digest('hex').slice(0, 16);
}

// ── the injection seam ─────────────────────────────────────────────────────────

/** Reads the SEALED blob (a store seam) — never plaintext. */
export interface SealedCredentialReader {
  getSealedVendorCredential(orgId: string, provider: VendorProvider): Promise<SealedCredential | null>;
}

/** Status of an org's vendor credential — what the API may return (NO key, NO ciphertext). */
export interface VendorCredentialStatus {
  provider: VendorProvider;
  status: 'active' | 'invalid';
  fingerprint: string;
  lastValidatedAt: string | null;
}

/** The org-scoped vendor-credential store (a narrow seam, kept off the big CoordinationStore so the
 *  many fakes don't ripple). `getSealedVendorCredential` is the resolver's read; the rest are writes +
 *  the status read. None ever returns a plaintext key. */
export interface VendorCredentialStore extends SealedCredentialReader {
  setVendorCredential(
    orgId: string,
    provider: VendorProvider,
    sealed: SealedCredential,
    fingerprint: string,
    createdBy: string | null
  ): Promise<void>;
  getVendorCredentialStatuses(orgId: string): Promise<VendorCredentialStatus[]>;
  deleteVendorCredential(orgId: string, provider: VendorProvider): Promise<boolean>;
}

const CACHE_TTL_MS = 60_000; // ~60s per (org,provider) — rotation takes effect within the window (D-locked)

/**
 * Resolves an org's decrypted vendor key for INJECTION — the only path that ever holds plaintext.
 * ~60s cache. Returns null when there is no key OR no master key (callers then fail closed: heuristic
 * routing / needs_attention). NEVER logs the key. A tampered/undecryptable row resolves to null (fail
 * closed) rather than throwing into the routing hot path.
 *
 * KNOWN LIMITATION (multi-node): `invalidate` busts only THIS node's cache, so on a multi-worker fleet a
 * rotated/deleted key can still be served by another node for up to the TTL. Fine for routine rotation;
 * for EMERGENCY revocation of a compromised key the ~60s fleet-wide window is a real exposure — a
 * DB revocation-epoch checked on cache hit (or push invalidation) is the follow-up. (Single-node /
 * in-process dispatch — today's deploy — has no such window: one cache, busted immediately on write.)
 */
export class VendorKeyResolver {
  private readonly cache = new Map<string, { key: string; expires: number }>();

  constructor(
    private readonly reader: SealedCredentialReader,
    private readonly masterKey: Buffer | null,
    private readonly now: () => number = Date.now
  ) {}

  async resolve(orgId: string, provider: VendorProvider): Promise<string | null> {
    if (!this.masterKey) return null;
    const k = `${orgId}\u0000${provider}`;
    const hit = this.cache.get(k);
    if (hit) {
      if (hit.expires > this.now()) return hit.key;
      this.cache.delete(k); // expired → drop the stale plaintext now (re-resolve below repopulates or not)
    }
    const sealed = await this.reader.getSealedVendorCredential(orgId, provider);
    if (!sealed) {
      this.cache.delete(k);
      return null;
    }
    let key: string;
    try {
      key = openVendorKey(sealed, this.masterKey);
    } catch {
      return null; // wrong master key / tampered ciphertext → fail closed
    }
    this.cache.set(k, { key, expires: this.now() + CACHE_TTL_MS });
    return key;
  }

  /** Drop the cache for an org+provider — called on set/replace/delete so a write isn't TTL-delayed. */
  invalidate(orgId: string, provider: VendorProvider): void {
    this.cache.delete(`${orgId}\u0000${provider}`);
  }
}

// ── validate-on-input ──────────────────────────────────────────────────────────

/** Live probe of the vendor before a key is saved (authenticates + model access). Injected so tests
 *  use a fake; the live impl calls the provider. The key is passed by value and never logged. */
export interface VendorValidator {
  validate(provider: VendorProvider, key: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Live Anthropic validator — a cheap authenticated GET /v1/models (no token spend). 200 → ok; 401/403
 *  → invalid key; anything else → a non-leaky reason. The key rides only in the x-api-key header. */
export function liveVendorValidator(fetchImpl: typeof fetch = fetch): VendorValidator {
  return {
    async validate(provider, key) {
      if (provider !== 'anthropic') return { ok: false, reason: `unsupported provider: ${provider}` };
      let res: Response;
      try {
        res = await fetchImpl('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        return { ok: false, reason: 'could not reach the vendor to validate the key' };
      }
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'the key was rejected by the vendor (invalid or revoked)' };
      return { ok: false, reason: `vendor returned ${res.status} during validation` };
    },
  };
}
