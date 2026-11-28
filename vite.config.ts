import { defineConfig } from 'vitest/config';

// On GitHub Pages the site is served from /sigdrift/.
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/sigdrift/' : '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Timing benchmarks read this: coverage instrumentation slows the code they time several-fold.
    provide: { coverage: process.argv.includes('--coverage') || process.argv.some((arg) => arg.startsWith('--coverage.')) },
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text-summary', 'json-summary', 'html'] },
  },
});
