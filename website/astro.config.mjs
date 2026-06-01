// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Marketing site for tasca.dev. The app lives separately on app.tasca.dev.
// Static output — deployable to any static host; deploy CI is intentionally
// not wired yet.
export default defineConfig({
  site: 'https://tasca.dev',
  vite: {
    plugins: [tailwindcss()],
  },
});
