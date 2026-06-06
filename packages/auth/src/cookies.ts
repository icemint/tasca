// Minimal cookie parse/serialize over stdlib only (no `cookie` dep). Just enough
// for the host-only session cookie + the short-lived OAuth-state cookie.

export interface CookieOptions {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  /** Seconds. Omit for a session cookie; 0 clears it. */
  maxAge?: number;
}

/** Parse a `Cookie:` request header into a name→value map. Tolerates noise. */
export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw; // a malformed %-sequence shouldn't drop the whole header
    }
  }
  return out;
}

/** Serialize one `Set-Cookie` value. Host-only by design — never sets `Domain=`. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) segments.push('HttpOnly');
  if (opts.secure) segments.push('Secure');
  if (opts.sameSite) segments.push(`SameSite=${opts.sameSite}`);
  return segments.join('; ');
}

/** A `Set-Cookie` that clears `name` (Max-Age=0, empty value). */
export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAge: 0 });
}
