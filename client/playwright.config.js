import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const clientDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(clientDirectory, '../server');
const serverRequire = createRequire(path.join(serverDirectory, 'package.json'));
const dotenv = serverRequire('dotenv');
dotenv.config({ path: path.join(serverDirectory, '.env.test'), quiet: true });

const testUri = process.env.MONGODB_TEST_URI;
const database = testUri?.match(/@[^/]+\/([^/?]+)(?:\?|$)/)?.[1];
if (database !== 'aicte_fdr_portal_test') {
  throw new Error('Browser E2E requires server/.env.test targeting aicte_fdr_portal_test.');
}

export default defineConfig({
  testDir: './browser-e2e',
  testMatch: '**/*.browser.js',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run start:test',
      cwd: serverDirectory,
      url: 'http://127.0.0.1:3011/api/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --host 0.0.0.0',
      cwd: clientDirectory,
      url: 'http://localhost:5173',
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...process.env, VITE_API_BASE_URL: 'http://localhost:3011/api' },
    },
  ],
});
