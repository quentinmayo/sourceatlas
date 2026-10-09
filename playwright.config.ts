import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:4000', headless: true },
  webServer: {
    command: 'npm run demo',
    url: 'http://127.0.0.1:4000/healthz',
    reuseExistingServer: !process.env.CI,
  },
  reporter: 'list',
});
