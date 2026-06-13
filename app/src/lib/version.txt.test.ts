// Lives in src/lib/ (NOT src/pages/): Astro routes every module under src/pages/, so a *.test.ts
// there is built as an endpoint and its vitest import crashes `astro build`. vitest's
// include: src/**/*.test.ts still picks it up here.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GET } from '../pages/version.txt';

describe('GET /version.txt — deploy SHA stamp', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the baked PUBLIC_GIT_SHA (what the CD deploy gate verifies the live app against)', async () => {
    vi.stubEnv('PUBLIC_GIT_SHA', 'abc1234');
    const res = await GET({} as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc1234');
  });

  it('returns "unknown" when no PUBLIC_GIT_SHA is baked in (a local/dev build)', async () => {
    // Leave it UNSET (afterEach reset the prior stub): an unset PUBLIC_ var is undefined, so the
    // `?? 'unknown'` fallback fires. (?? catches only null/undefined — Vite leaves it undefined.)
    const res = await GET({} as never);
    expect(await res.text()).toBe('unknown');
  });
});
