import { describe, it, expect } from 'vitest';
import {
  parseTokens,
  resolve,
  parseColor,
  luminance,
  contrastRatio,
  compositeMix,
  evaluate,
  PAIRINGS,
} from './check-contrast';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('WCAG contrast math — known reference values', () => {
  it('black on white = 21:1, white on white = 1:1, black on black = 1:1', () => {
    const black = parseColor('#000000')!;
    const white = parseColor('#FFFFFF')!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(contrastRatio(black, black)).toBeCloseTo(1, 5);
  });

  it('luminance: white = 1, black = 0', () => {
    expect(luminance(parseColor('#FFFFFF')!)).toBeCloseTo(1, 5);
    expect(luminance(parseColor('#000000')!)).toBeCloseTo(0, 5);
  });

  it('contrast is symmetric (order of fg/bg does not matter)', () => {
    const a = parseColor('#5C6779')!;
    const b = parseColor('#FFFFFF')!;
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 6);
  });
});

describe('parseColor — hex + rgb forms', () => {
  it('parses #rgb shorthand by doubling each nibble', () => {
    expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });
  it('parses #rrggbb', () => {
    expect(parseColor('#34D399')).toEqual({ r: 0x34, g: 0xd3, b: 0x99 });
  });
  it('drops the alpha channel on #rrggbbaa', () => {
    expect(parseColor('#0F1622FF')).toEqual({ r: 0x0f, g: 0x16, b: 0x22 });
  });
  it('parses rgb() and rgba() (alpha ignored)', () => {
    expect(parseColor('rgb(9,13,20)')).toEqual({ r: 9, g: 13, b: 20 });
    expect(parseColor('rgba(255,255,255,0.78)')).toEqual({ r: 255, g: 255, b: 255 });
  });
  it('returns null for a non-color value', () => {
    expect(parseColor('sans-serif')).toBeNull();
  });
});

describe('parseTokens — scope split + multi-declaration lines + var() resolution', () => {
  // A miniature tokens file: dark `:root`, a light override scope, a primitive palette
  // line packing TWO declarations (the regression the parser must not miss), and a
  // var() chain to resolve.
  const css = `
    :root {
      --p-green-400: #34D399;  --p-green-700: #15803D;
      --surface: #0F1622;
      --green: var(--p-green-400);
    }
    :root[data-theme="light"], [data-theme="light"] {
      --surface: #FFFFFF;
      --green: var(--p-green-700);
    }
  `;

  it('reads BOTH declarations packed on one line (split on ;, not per-line)', () => {
    const scopes = parseTokens(css);
    expect(scopes.root.get('--p-green-400')).toBe('#34D399');
    expect(scopes.root.get('--p-green-700')).toBe('#15803D');
  });

  it('resolves a var() chain to its terminal hex, per theme', () => {
    const scopes = parseTokens(css);
    expect(resolve('--green', 'dark', scopes)).toBe('#34D399');
    expect(resolve('--green', 'light', scopes)).toBe('#15803D');
  });

  it('light theme falls back to the root scope for tokens it does not override', () => {
    const css2 = `:root { --fg: #F3F6FB; } :root[data-theme="light"] { --surface: #FFFFFF; }`;
    const scopes = parseTokens(css2);
    expect(resolve('--fg', 'light', scopes)).toBe('#F3F6FB');
  });

  it('uses the var() fallback when the referenced token is undefined', () => {
    const scopes = parseTokens(`:root { --x: var(--missing, #123456); }`);
    expect(resolve('--x', 'dark', scopes)).toBe('#123456');
  });

  it('does not read a #hex that lives inside a comment', () => {
    const scopes = parseTokens(`:root { /* note: was #FF0000 */ --fg: #FFFFFF; }`);
    expect(resolve('--fg', 'dark', scopes)).toBe('#FFFFFF');
  });
});

describe('compositeMix — color-mix(in srgb, color P%, transparent) over an opaque base', () => {
  it('50% of a color over white is the per-channel midpoint (transparent shows the base)', () => {
    // color-mix(in srgb, #000000 50%, transparent) painted over #FFFFFF renders #808080.
    const mid = compositeMix(parseColor('#000000')!, 50, parseColor('#FFFFFF')!);
    expect(mid).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });

  it('0% is the base untouched; 100% is the color untouched', () => {
    const base = parseColor('#123456')!;
    const color = parseColor('#ABCDEF')!;
    expect(compositeMix(color, 0, base)).toEqual(base);
    expect(compositeMix(color, 100, base)).toEqual(color);
  });

  it('a 10% green tint over white matches the hand-computed composite', () => {
    // (0.1)*#15803D + (0.9)*#FFFFFF, per channel.
    const c = compositeMix(parseColor('#15803D')!, 10, parseColor('#FFFFFF')!);
    expect(c.r).toBeCloseTo(0.1 * 0x15 + 0.9 * 255, 4);
    expect(c.g).toBeCloseTo(0.1 * 0x80 + 0.9 * 255, 4);
    expect(c.b).toBeCloseTo(0.1 * 0x3d + 0.9 * 255, 4);
  });
});

describe('the PAIRINGS list asserts tinted (color-mix) backgrounds, not just flat surfaces', () => {
  it('includes at least one MixBg pairing — the case a flat-token check cannot model', () => {
    const tinted = PAIRINGS.filter((p) => typeof p.bg === 'object');
    expect(tinted.length).toBeGreaterThan(0);
    // The signal-2-on-signal-tint case (the primary-control regression the panel caught).
    expect(
      tinted.some(
        (p) =>
          p.fg === '--signal-2' &&
          typeof p.bg === 'object' &&
          p.bg.mix === '--signal'
      )
    ).toBe(true);
  });

  it('every below-AA pairing carries a documented rationale note (no silent exemption)', () => {
    for (const p of PAIRINGS.filter((p) => p.min < 4.5)) {
      expect(p.note, `${p.label} is below AA without a note`).toBeTruthy();
    }
  });
});

describe('the REAL tokens.css passes AA on every maintained pairing, both themes', () => {
  it('every pairing clears its minimum ratio', () => {
    const tokensPath = path.resolve(__dirname, '..', 'app', 'src', 'styles', 'tokens.css');
    const results = evaluate(parseTokens(readFileSync(tokensPath, 'utf8')));
    const failures = results.filter((r) => !r.pass);
    expect(
      failures,
      failures.map((f) => `${f.theme} ${f.label}=${f.ratio?.toFixed(2)}`).join(', ')
    ).toEqual([]);
  });
});
