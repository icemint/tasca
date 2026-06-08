import { defineConfig } from 'vitest/config';

// The view/api code branches on `import.meta.env.DEV` to serve dev-fixtures instead
// of the network. Tests exercise the PRODUCTION path (the real fetch client), so we
// pin DEV=false — the fixtures branch is then dead and the client always fetches,
// letting tests stub `fetch` to drive each honest state.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./src/lib/test-setup.ts'],
  },
});
