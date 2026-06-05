import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Marketing site for tasca.dev. Static output; CTAs hand off to app.tasca.dev.
export default defineConfig({
  site: 'https://tasca.dev',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'auto' },
});
