import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveFlags, DEFAULT_FLAGS } from './flags';

describe('resolveFlags', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults every flag off', () => {
    const f = resolveFlags();
    expect(f).toEqual(DEFAULT_FLAGS);
    expect(Object.values(f).every((v) => v === false)).toBe(true);
  });

  it('honors an org flag turned on', () => {
    expect(resolveFlags({ tiers: true }).tiers).toBe(true);
  });

  it('honors an explicit org false', () => {
    expect(resolveFlags({ tiers: false }).tiers).toBe(false);
  });

  it('env override wins over org (env off beats org on)', () => {
    vi.stubEnv('VITE_FLAG_TIERS', '0');
    expect(resolveFlags({ tiers: true }).tiers).toBe(false);
  });

  it('env override wins over org (env on beats org absent)', () => {
    vi.stubEnv('VITE_FLAG_RUN_VIEW', 'true');
    expect(resolveFlags().run_view).toBe(true);
  });

  it('ignores an unrecognized env value and falls through to org', () => {
    vi.stubEnv('VITE_FLAG_TIERS', 'yes');
    expect(resolveFlags({ tiers: true }).tiers).toBe(true);
  });
});
