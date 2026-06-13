import { describe, it, expect } from 'vitest';
import {
  parseTokens,
  resolve,
  parseColor,
  luminance,
  contrastRatio,
  evaluate,
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
