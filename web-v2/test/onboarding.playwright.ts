import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

const baseURL = `http://127.0.0.1:${Number(process.env.ONBOARDING_TEST_PORT || 43179)}`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: '../test-results/onboarding',
  reporter: [['list']],
  use: {baseURL, browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, colorScheme: 'dark', reducedMotion: 'reduce', trace: 'retain-on-failure'},
  webServer: {command: 'node --import tsx test/onboarding-browser-server.ts', cwd: fileURLToPath(new URL('..', import.meta.url)), url: `${baseURL}/onboarding`, reuseExistingServer: false, timeout: 30_000},
});
