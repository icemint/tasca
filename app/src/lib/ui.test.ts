import { describe, it, expect } from 'vitest';
import { roControl, RO_SOON, RO_GATE_PROVISION, esc, pct, money, statePill, tierRamp } from './ui';

describe('roControl (read-only console controls)', () => {
  it('renders a visible-but-disabled button with the default "arrives with the write API" reason', () => {
    const html = roControl('Reassign');
    expect(html).toContain('disabled');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-ro="soon"');
    expect(html).toContain(RO_SOON);
    expect(html).toContain('ro-ctl');
    // the honest reason reaches assistive tech, not just the title
    expect(html).toContain(`aria-label="Reassign — ${RO_SOON}"`);
    // no stray "Coming soon"
    expect(html).not.toContain('Coming soon');
  });

  it('marks a gated control with its specific honest reason (not the generic one)', () => {
    const html = roControl('Deploy', { gate: RO_GATE_PROVISION });
    expect(html).toContain('data-ro="gated"');
    expect(html).toContain(RO_GATE_PROVISION);
    expect(html).not.toContain(RO_SOON);
  });

  it('preserves the caller class list and prepends an icon', () => {
    const html = roControl('Add agent', { icon: '<svg></svg>', cls: 'btn-add' });
    expect(html).toMatch(/class="btn-add ro-ctl"/);
    expect(html).toContain('<svg></svg> Add agent');
  });

  it('escapes the label', () => {
    expect(roControl('<x>')).toContain('&lt;x&gt;');
  });
});

describe('ui value formatters (honest nulls)', () => {
  it('esc escapes HTML metacharacters', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('pct is "—" for null, rounded otherwise', () => {
    expect(pct(null)).toBe('—');
    expect(pct(1)).toBe('100%');
    expect(pct(0.666)).toBe('67%');
  });
  it('money is honest for null and free for 0', () => {
    expect(money(null)).toBe('—');
    expect(money(0)).toBe('local · no cap');
    expect(money(5)).toBe('$5 / day');
  });
  it('statePill maps awaiting_input to the design-system token', () => {
    expect(statePill('awaiting_input')).toContain('astate-awaiting');
  });
  it('tierRamp is honest "—" when no maxTier', () => {
    const cap = { maxTier: null, tiersCovered: [], languageSpecialties: [], frameworkSpecialties: [], concurrencyLimit: null, costCeiling: null, successRate: null };
    expect(tierRamp(cap)).toContain('<b>—</b>');
  });
});
