import { describe, it, expect } from 'vitest';
import {
  scanForHardcodedColors,
  findHardcodedColors,
  FILE_ALLOWLIST,
} from './check-hardcoded-colors';
import path from 'node:path';

describe('hardcoded-color guard — it MUST fire on raw color literals', () => {
  it('FLAGS a raw #hex value', () => {
    const hits = scanForHardcodedColors(`.btn { color: #04101F; }`, 'app/src/styles/x.css');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.match).toBe('#04101F');
    expect(hits[0]!.line).toBe(1);
  });

  it('FLAGS rgb()/rgba()/hsl()/hsla() functions and bare named colors', () => {
    expect(scanForHardcodedColors(`a { background: rgba(9,13,20,0.78); }`, 'f.css').map((h) => h.match)).toContain('rgba(');
    expect(scanForHardcodedColors(`a { background: hsl(214 30% 5%); }`, 'f.css').map((h) => h.match)).toContain('hsl(');
    expect(scanForHardcodedColors(`a { color: white; }`, 'f.css').map((h) => h.match.toLowerCase())).toContain('white');
    expect(scanForHardcodedColors(`a { outline: 2px solid black; }`, 'f.css').map((h) => h.match.toLowerCase())).toContain('black');
  });
});

describe('hardcoded-color guard — it MUST allow the token-driven cases', () => {
  it('PASSES a var(--token) reference', () => {
    expect(scanForHardcodedColors(`.btn { color: var(--ink-on-accent); }`, 'f.css')).toEqual([]);
  });

  it('PASSES a var() fallback — the token is the source of truth, fallback is inert', () => {
    expect(scanForHardcodedColors(`:focus { outline: 2px solid var(--signal, #4D9CF6); }`, 'f.css')).toEqual([]);
  });

  it('PASSES keyword values that are not literal colors (transparent / currentColor / inherit)', () => {
    expect(scanForHardcodedColors(`a { background: transparent; color: inherit; fill: currentColor; }`, 'f.css')).toEqual([]);
  });

  it('PASSES a line carrying the inline allow tag', () => {
    expect(
      scanForHardcodedColors(`.brand { background: #fff; } /* allow-hardcoded-color: Google brand */`, 'f.css')
    ).toEqual([]);
  });

  it('PASSES a #hex that appears only inside a comment', () => {
    expect(scanForHardcodedColors(`/* was #FF0000 */\n.x { color: var(--red); }`, 'f.css')).toEqual([]);
    expect(scanForHardcodedColors(`.x { color: var(--red); } /* TODO: was #00FF00 */`, 'f.css')).toEqual([]);
  });

  it('does not false-positive on a non-color hex-like token (e.g. a 2-char hex or a # in a selector context)', () => {
    expect(scanForHardcodedColors(`.x { grid-area: a1; }`, 'f.css')).toEqual([]);
  });
});

describe('hardcoded-color guard — file allowlist + the REAL repo', () => {
  it('tokens.css is exempt (the palette IS the literals)', () => {
    expect(FILE_ALLOWLIST['app/src/styles/tokens.css']).toBeTruthy();
  });

  it('the REAL repo is clean — every raw color is tokenized or allowlisted', () => {
    const root = path.resolve(__dirname, '..');
    const hits = findHardcodedColors(root);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
