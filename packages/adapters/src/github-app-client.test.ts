import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { GitHubAppClient } from './index';

// Unit tests for the GitHub App client — no live GitHub. A test RSA keypair is
// generated once; the App JWT is verified against the public key (proving the
// RS256 signature), and the installation-token POST shape + in-memory cache
// (re-mint before expiry) are exercised through an injected fetch + clock.

const APP_ID = '123456';

let privateKey: string;
let publicKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

/** base64url-decode to a Buffer. */
function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(b64urlToBuf(h!).toString('utf8')),
    payload: JSON.parse(b64urlToBuf(p!).toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: b64urlToBuf(s!),
  };
}

describe('GitHubAppClient.mintAppJwt (RS256 via node:crypto)', () => {
  it('emits a header/payload that decode and a signature the public key verifies', () => {
    const now = () => 1_700_000_000_000; // fixed clock
    const client = new GitHubAppClient({ appId: APP_ID, privateKey, now });
    const jwt = client.mintAppJwt();
    const { header, payload, signingInput, signature } = decodeJwt(jwt);

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe(APP_ID);
    // exp - iat is exactly the 600s TTL.
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
    // iat is backdated relative to now (clock-skew tolerance).
    expect(payload.iat as number).toBeLessThanOrEqual(Math.floor(now() / 1000));

    const verifier = createVerify('RSA-SHA256').update(signingInput);
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  it('produces a signature that fails verification if the signing input is tampered', () => {
    const client = new GitHubAppClient({ appId: APP_ID, privateKey, now: () => 1_700_000_000_000 });
    const { signature } = decodeJwt(client.mintAppJwt());
    const tampered = createVerify('RSA-SHA256').update('not.the.signing.input');
    expect(tampered.verify(publicKey, signature)).toBe(false);
  });
});

describe('GitHubAppClient.getInstallationToken (POST shape + cache)', () => {
  function tokenResponse(token: string, expiresAtIso: string) {
    return new Response(JSON.stringify({ token, expires_at: expiresAtIso }), { status: 201 });
  }

  it('POSTs to /app/installations/{id}/access_tokens with the App JWT bearer', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return tokenResponse('ghs_inst_token', '2026-01-01T01:00:00Z');
    }) as unknown as typeof fetch;

    const client = new GitHubAppClient({
      appId: APP_ID,
      privateKey,
      apiBase: 'https://api.example.test',
      fetchImpl: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    const t = await client.getInstallationToken('77');

    expect(t.token).toBe('ghs_inst_token');
    expect(t.expiresAt).toBe(new Date('2026-01-01T01:00:00Z').getTime());
    expect(captured?.url).toBe('https://api.example.test/app/installations/77/access_tokens');
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Bearer .+\..+\..+$/); // a JWT
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('reuses the cached token before the refresh margin (fetch called once)', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return tokenResponse(`tok_${calls}`, '2026-01-01T01:00:00Z');
    }) as unknown as typeof fetch;

    let nowMs = new Date('2026-01-01T00:00:00Z').getTime();
    const client = new GitHubAppClient({
      appId: APP_ID,
      privateKey,
      fetchImpl: fakeFetch,
      now: () => nowMs,
    });

    const a = await client.getInstallationToken('77');
    nowMs += 30_000; // +30s, well inside the 1h token life and 5m margin
    const b = await client.getInstallationToken('77');
    expect(calls).toBe(1);
    expect(b.token).toBe(a.token);
  });

  it('re-mints once the cached token is within the refresh margin of expiry', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      // Each token expires 1h after the (advancing) clock at mint time.
      const exp = new Date(nowMs + 60 * 60 * 1000).toISOString();
      return tokenResponse(`tok_${calls}`, exp);
    }) as unknown as typeof fetch;

    let nowMs = new Date('2026-01-01T00:00:00Z').getTime();
    const client = new GitHubAppClient({
      appId: APP_ID,
      privateKey,
      fetchImpl: fakeFetch,
      now: () => nowMs,
    });

    const a = await client.getInstallationToken('77');
    // Advance to within 5m of expiry (1h - 4m = 56m later).
    nowMs += 56 * 60 * 1000;
    const b = await client.getInstallationToken('77');
    expect(calls).toBe(2);
    expect(b.token).not.toBe(a.token);
  });

  it('throws on a non-2xx token response', async () => {
    const fakeFetch = (async () =>
      new Response('forbidden', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: APP_ID, privateKey, fetchImpl: fakeFetch });
    await expect(client.getInstallationToken('77')).rejects.toThrow(/403/);
  });
});

describe('GitHubAppClient — private key normalization + boot decode-check', () => {
  /** Re-sign + verify against the pair's public key to prove the key actually works. */
  function signsAndVerifies(key: string): boolean {
    const client = new GitHubAppClient({ appId: APP_ID, privateKey: key });
    const { signingInput, signature } = decodeJwt(client.mintAppJwt());
    return createVerify('RSA-SHA256').update(signingInput).verify(publicKey, signature);
  }

  it('accepts a PEM whose newlines were escaped to literal \\n (env mangling)', () => {
    const escaped = privateKey.replace(/\n/g, '\\n');
    expect(escaped).toContain('\\n'); // sanity: this is the mangled form
    expect(signsAndVerifies(escaped)).toBe(true);
  });

  it('accepts a base64-encoded PEM (single-line env value)', () => {
    const b64 = Buffer.from(privateKey, 'utf8').toString('base64');
    expect(b64).not.toContain('BEGIN');
    expect(signsAndVerifies(b64)).toBe(true);
  });

  it('accepts a PKCS#1 key as well as PKCS#8 (format-agnostic)', () => {
    const pkcs1 = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    expect(pkcs1.privateKey).toContain('BEGIN RSA PRIVATE KEY');
    const client = new GitHubAppClient({ appId: APP_ID, privateKey: pkcs1.privateKey });
    const { signingInput, signature } = decodeJwt(client.mintAppJwt());
    expect(createVerify('RSA-SHA256').update(signingInput).verify(pkcs1.publicKey, signature)).toBe(true);
  });

  it('validateSigningKey passes for a good key', () => {
    expect(() => new GitHubAppClient({ appId: APP_ID, privateKey }).validateSigningKey()).not.toThrow();
  });

  it('validateSigningKey throws an actionable error for a mangled/garbage key', () => {
    const client = new GitHubAppClient({ appId: APP_ID, privateKey: '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----' });
    expect(() => client.validateSigningKey()).toThrow(/failed to decode\/sign — check GITHUB_APP_PRIVATE_KEY/);
  });
});
