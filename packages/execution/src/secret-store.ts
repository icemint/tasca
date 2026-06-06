// Headless SecretStore (secrets seam).
//
// The vendored execution core stores credentials via `keytar` (OS keychain)
// behind a clean get/set/clear in AccountCredentialStore.ts — there is NO
// Electron `safeStorage` anywhere. This wraps that same approach behind a small
// SecretStore interface { get, set, delete, list } and adds an env + encrypted-
// file fallback so the store resolves secrets even where the OS keychain native
// binding is missing (CI, containers). Production backends (KMS/Vault) drop in
// behind this interface.
//
// Precedence on get(): process.env[KEY]  ->  keytar  ->  file.
// safeStorage is never imported or used.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SERVICE = 'tasca-execution';

export type SecretBackend = 'env+file' | 'keytar';

/** A pluggable secret store: env -> OS keychain -> AES-256-GCM file. */
export interface SecretStore {
  /** Which backend is in effect once probed. */
  backend(): Promise<SecretBackend>;
  /** Resolve a secret by name, or null if absent. */
  get(name: string): Promise<string | null>;
  /** Persist a secret. */
  set(name: string, value: string): Promise<void>;
  /** Remove a secret. */
  delete(name: string): Promise<void>;
  /** List known secret names (excludes the process.env shortcut). */
  list(): Promise<string[]>;
}

interface KeytarApi {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

interface EncEntry {
  iv: string;
  tag: string;
  data: string;
}

export interface MakeSecretStoreOptions {
  /** Path for the encrypted-file fallback. */
  filePath?: string;
}

export function makeSecretStore({ filePath }: MakeSecretStoreOptions = {}): SecretStore {
  // A per-user 0700 directory — NOT the shared, world-traversable, periodically
  // cleared os.tmpdir(). (Env-first precedence means CI never touches this file.)
  const file = filePath || path.join(os.homedir(), '.tasca', 'execution-secrets.json');
  let backendName: SecretBackend = 'env+file';

  // Create the parent dir 0700 and write a file 0600, tightening perms even if it
  // already exists with a looser mode (the {mode} option only applies on create).
  function writeSecure(p: string, data: string | Buffer): void {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, data, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  }
  // null = not probed; false = unavailable; object = the keytar api.
  let keytar: KeytarApi | false | null = null;

  async function getKeytar(): Promise<KeytarApi | false> {
    if (keytar !== null) return keytar;
    try {
      // keytar is an optional native module resolved at runtime from the
      // vendored execution core's node_modules; it is not a typed dependency of
      // this package. The env+file fallback covers its absence.
      // @ts-expect-error -- runtime-optional, no type declarations here
      const mod: unknown = await import('keytar');
      // ESM interop: the full keytar API (findCredentials/setPassword/...) is on
      // .default; only getPassword is re-exported as a named binding. Normalize
      // to `mod.default ?? mod` so both the CJS- and ESM-compiled shapes work.
      const api = ((mod as { default?: KeytarApi }).default ?? (mod as KeytarApi)) as KeytarApi;
      // probe that the native binding actually works
      await api.findCredentials(SERVICE);
      keytar = api;
      backendName = 'keytar';
    } catch {
      keytar = false; // mark unavailable
    }
    return keytar;
  }

  // --- file backend (AES-256-GCM, key derived from a machine-local salt file) ---
  function fileKey(): Buffer {
    const saltPath = file + '.salt';
    let salt: Buffer;
    if (fs.existsSync(saltPath)) {
      salt = fs.readFileSync(saltPath);
    } else {
      salt = crypto.randomBytes(32);
      writeSecure(saltPath, salt);
    }
    return crypto.scryptSync(os.userInfo().username + os.hostname(), salt, 32);
  }

  function readFileStore(): Record<string, string> {
    if (!fs.existsSync(file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, EncEntry>;
      const key = fileKey();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        const iv = Buffer.from(v.iv, 'base64');
        const tag = Buffer.from(v.tag, 'base64');
        const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
        dec.setAuthTag(tag);
        out[k] = dec.update(Buffer.from(v.data, 'base64'), undefined, 'utf8') + dec.final('utf8');
      }
      return out;
    } catch {
      return {};
    }
  }

  function writeFileStore(map: Record<string, string>): void {
    const key = fileKey();
    const enc: Record<string, EncEntry> = {};
    for (const [k, val] of Object.entries(map)) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(String(val), 'utf8'), c.final()]);
      enc[k] = {
        iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      };
    }
    writeSecure(file, JSON.stringify(enc));
  }

  return {
    async backend(): Promise<SecretBackend> {
      await getKeytar();
      return backendName;
    },
    async get(name: string): Promise<string | null> {
      const fromEnv = process.env[name];
      if (fromEnv) return fromEnv;
      const kt = await getKeytar();
      if (kt) {
        const v = await kt.getPassword(SERVICE, name);
        if (v != null) return v;
      }
      return readFileStore()[name] ?? null;
    },
    async set(name: string, value: string): Promise<void> {
      const kt = await getKeytar();
      if (kt) {
        await kt.setPassword(SERVICE, name, value);
        return;
      }
      const m = readFileStore();
      m[name] = value;
      writeFileStore(m);
    },
    async delete(name: string): Promise<void> {
      const kt = await getKeytar();
      if (kt) {
        await kt.deletePassword(SERVICE, name);
        return;
      }
      const m = readFileStore();
      delete m[name];
      writeFileStore(m);
    },
    async list(): Promise<string[]> {
      const kt = await getKeytar();
      if (kt) return (await kt.findCredentials(SERVICE)).map((c) => c.account);
      return Object.keys(readFileStore());
    },
  };
}
