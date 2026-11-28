import { defineConfig, devices } from '@playwright/test';

/**
 * Browser flows (e2e/*.spec.ts) against the dev server, in the Chrome installed on this machine: nothing to
 * download. Run with `npm run e2e`. WebGL comes from Chrome's software renderer when there is no GPU (CI).
 */
const PORT = 5190;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    {
      name: 'phone',
      use: { ...devices['Pixel 7 landscape'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort --bypass-lock`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
  },
});
