import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/electron',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../work/playwright-output',
});
