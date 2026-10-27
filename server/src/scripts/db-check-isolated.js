import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({
  path: path.resolve(process.cwd(), '.env.test'),
  override: true,
  quiet: true,
});

const testUri = process.env.MONGODB_TEST_URI;
const databaseMatch = testUri?.match(/@[^/]+\/([^/?]+)(?:\?|$)/);

if (!databaseMatch || decodeURIComponent(databaseMatch[1]) !== 'aicte_fdr_portal_test') {
  console.error('Test database check requires MONGODB_TEST_URI targeting aicte_fdr_portal_test in server/.env.test.');
  process.exitCode = 1;
} else {
  process.env.MONGODB_URI = testUri;
  await import('./db-check.js');
}
