import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'onboarding.browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: '../test-results/onboarding',
  reporter: [['list']],
  use: {baseURL: 'http://127.0.0.1:43179', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure'},
  webServer: {command: 'node --import tsx test/onboarding-browser-server.ts', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:43179/onboarding', reuseExistingServer: false, timeout: 30_000},
});
