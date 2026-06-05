import { defineConfig } from 'astro/config';

// The Tasca application shell (app.tasca.dev). Currently the sign-in surface;
// the full application lands here as Stage 1 ships. Static output.
export default defineConfig({
  site: 'https://app.tasca.dev',
  build: { inlineStylesheets: 'auto' },
});
