import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import mongoose from 'mongoose';

dotenv.config({
  path: path.resolve(process.cwd(), '.env.test'),
  override: true,
  quiet: true,
});

const testUri = process.env.MONGODB_TEST_URI;
const databaseMatch = testUri?.match(/@[^/]+\/([^/?]+)(?:\?|$)/);

if (!databaseMatch || decodeURIComponent(databaseMatch[1]) !== 'aicte_fdr_portal_test') {
  throw new Error('Test server requires MONGODB_TEST_URI targeting aicte_fdr_portal_test in server/.env.test.');
}
if (!process.env.JWT_TEST_SECRET || process.env.JWT_TEST_SECRET.length < 32) {
  throw new Error('Test server requires a test-only JWT_TEST_SECRET of at least 32 characters.');
}

process.env.MONGODB_URI = testUri;
process.env.JWT_SECRET = process.env.JWT_TEST_SECRET;
process.env.NODE_ENV = 'test';
process.env.SARVAM_TEST_MODE = 'true';
process.env.MATURITY_REMINDERS_ENABLED = 'false';
delete process.env.SARVAM_API_KEY;

const storagePath = await mkdtemp(path.join(os.tmpdir(), 'aicte-phase11-server-'));
process.env.FDR_STORAGE_DIR = storagePath;

let stopping = false;
const stopServer = async () => {
  if (stopping) return;
  stopping = true;
  await mongoose.disconnect();
  await rm(storagePath, { recursive: true, force: true });
  process.exit(0);
};

process.once('SIGINT', stopServer);
process.once('SIGTERM', stopServer);

await import('../server.js');
