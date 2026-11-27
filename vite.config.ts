import { defineConfig } from 'vitest/config';

// On GitHub Pages the site is served from /sigdrift/.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/sigdrift/' : '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
