// Shared HTTP plumbing for the session-gated mutating handlers (write-API + the org-management API,
// slice 5a). Extracted so the CSRF double-submit — a security primitive — has ONE implementation
// both handlers use, rather than a copy in each.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CSRF_COOKIE = 'tasca_csrf';
const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Read a cookie value from the request header (no external dep). */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Read a small JSON body, capped. Returns {} for an empty body; throws on oversize/invalid JSON. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Issue a CSRF double-submit token: set the cookie + return the token for the JSON body. */
export function issueCsrfToken(res: ServerResponse, opts: { secure: boolean }): string {
  const token = randomBytes(32).toString('hex');
  const secure = opts.secure ? '; Secure' : '';
  // HttpOnly is safe: the client echoes the token from THIS response's body, never by reading the
  // cookie — the browser sends the cookie automatically and the server compares the two.
  res.setHeader('set-cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly${secure}`);
  return token;
}

/** Verify the CSRF double-submit: the `tasca_csrf` cookie must equal the `x-csrf-token` header. */
export function verifyCsrf(req: IncomingMessage): boolean {
  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.headers['x-csrf-token'];
  const headerToken = Array.isArray(header) ? header[0] : header;
  return Boolean(cookie && headerToken && safeEqual(cookie, headerToken));
}
