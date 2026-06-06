import { describe, it, expect } from 'vitest';
import { parseCookies, serializeCookie, clearCookie } from './cookies';

describe('parseCookies', () => {
  it('parses a multi-pair header', () => {
    expect(parseCookies('a=1; b=2; tasca_session=abc')).toEqual({
      a: '1',
      b: '2',
      tasca_session: 'abc',
    });
  });

  it('returns {} for an undefined / empty header', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('url-decodes values', () => {
    expect(parseCookies('x=a%20b')).toEqual({ x: 'a b' });
  });

  it('tolerates a malformed %-sequence without dropping other cookies', () => {
    expect(parseCookies('bad=%E0%A4%A; good=1')).toEqual({ bad: '%E0%A4%A', good: '1' });
  });

  it('skips segments without an =', () => {
    expect(parseCookies('flag; a=1')).toEqual({ a: '1' });
  });
});

describe('serializeCookie', () => {
  it('serializes the host-only session cookie attributes (no Domain)', () => {
    const out = serializeCookie('tasca_session', 'tok', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 604800,
    });
    expect(out).toBe('tasca_session=tok; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax');
    expect(out).not.toContain('Domain=');
  });

  it('url-encodes the value', () => {
    expect(serializeCookie('k', 'a b')).toBe('k=a%20b; Path=/');
  });

  it('omits Max-Age when not supplied (session cookie)', () => {
    expect(serializeCookie('k', 'v', { httpOnly: true })).toBe('k=v; Path=/; HttpOnly');
  });
});

describe('clearCookie', () => {
  it('emits a Max-Age=0 clearing cookie', () => {
    expect(clearCookie('tasca_session', { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' })).toBe(
      'tasca_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
    );
  });
});
