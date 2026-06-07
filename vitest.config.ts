import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // The vendored execution core (packages/execution/vendor/**) is a soft-fork
    // submodule with its own test suite + toolchain; it is exercised by the
    // dedicated spike-headless-boot workflow, not the platform test run.
    exclude: ['**/node_modules/**', '**/vendor/**'],
  },
});
