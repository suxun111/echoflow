import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173',
    channel: 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-upload',
      testMatch: /local-mp4\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'msedge' },
    },
    {
      name: 'mobile-navigation',
      testMatch: /mobile-navigation\.spec\.ts/,
      use: { ...devices['iPhone 13'], browserName: 'chromium', channel: 'msedge' },
    },
  ],
})
