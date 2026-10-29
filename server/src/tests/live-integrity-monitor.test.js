import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import mongoose from 'mongoose';
import FDR from '../models/FDR.js';
import Notification from '../models/Notification.js';
import AuditLog from '../models/AuditLog.js';
import {
  getFdrIntegrityHistory,
  investigateIntegrityAlert,
  listIntegrityRecords,
  runBulkIntegrityCheck,
  verifyStoredDocumentIntegrity,
} from '../services/document-integrity.service.js';

const queryFor = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  session() {
    return this;
  },
  lean() {
    return Promise.resolve(typeof value === 'function' ? value() : value);
  },
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

test('Feature: Live FDR Integrity Monitor', async (context) => {
  const institutionId = new mongoose.Types.ObjectId();
  const instUser = {
    _id: new mongoose.Types.ObjectId(),
    role: 'institution_admin',
    institution: institutionId,
  };
  const officialUser = {
    _id: new mongoose.Types.ObjectId(),
    role: 'aicte_admin',
    institution: null,
  };

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'live-integrity-test-'));
  process.env.FDR_STORAGE_DIR = tempDir;

  const originalDocBytes = Buffer.from('OFFICIAL AICTE SECURITY DEPOSIT RECEIPT 2026');
  const trustedChecksum = crypto.createHash('sha256').update(originalDocBytes).digest('hex');
  const storageRef = `${crypto.randomUUID()}.pdf`;
  await writeFile(path.join(tempDir, storageRef), originalDocBytes);

  let inMemoryFdr = {
    _id: new mongoose.Types.ObjectId(),
    institution: {
      _id: institutionId,
      name: 'Delhi Institute of Engineering & Technology',
      institutionCode: '1-3329184711',
    },
    fdrNumber: 'SBIN-2026-FDR-98124',
    bankName: 'State Bank of India',
    branch: 'Parliament Street, New Delhi',
    amount: 12500000,
    documentMetadata: {
      storageRef,
      fileName: 'security_fdr.pdf',
      mimeType: 'application/pdf',
      fileSize: originalDocBytes.length,
      checksum: trustedChecksum,
      version: 1,
      uploadedAt: new Date(),
    },
    documentVersions: [
      {
        version: 1,
        storageRef,
        fileName: 'security_fdr.pdf',
        mimeType: 'application/pdf',
        fileSize: originalDocBytes.length,
        checksum: trustedChecksum,
        uploadedAt: new Date(),
      },
    ],
    integrityStatus: {
      status: 'not_checked',
      lastCheckedAt: null,
      version: 1,
      recordedChecksum: trustedChecksum,
      calculatedChecksum: null,
      history: [],
      alerts: [],
    },
    workflowStatus: 'submitted',
    financialStatus: 'active',
  };

  inMemoryFdr.save = async function mockSave() {
    return this;
  };

  context.mock.method(FDR, 'findById', (id) => {
    if (String(id) === String(inMemoryFdr._id)) {
      return queryFor(inMemoryFdr);
    }
    return queryFor(null);
  });

  context.mock.method(Notification, 'create', async () => ({ _id: new mongoose.Types.ObjectId() }));
  context.mock.method(AuditLog.prototype, 'save', async function () {
    return this;
  });

  await context.test('1. Verified status on unchanged stored document', async () => {
    const result = await verifyStoredDocumentIntegrity({
      fdrId: inMemoryFdr._id,
      user: officialUser,
    });

    assert.equal(result.status, 'verified');
    assert.equal(result.match, true);
    assert.equal(result.recordedChecksum, trustedChecksum);
    assert.equal(result.calculatedChecksum, trustedChecksum);
    assert.equal(inMemoryFdr.integrityStatus.status, 'verified');
    assert.ok(inMemoryFdr.integrityStatus.lastCheckedAt);
    assert.equal(inMemoryFdr.integrityStatus.history.length, 1);
  });

  await context.test('2. Mismatch status, alert creation, and notification on modified file', async () => {
    // Maliciously tamper with the stored file on disk
    const tamperedBytes = Buffer.from('TAMPERED / CORRUPTED AICTE RECEIPT 2026');
    await writeFile(path.join(tempDir, storageRef), tamperedBytes);

    const result = await verifyStoredDocumentIntegrity({
      fdrId: inMemoryFdr._id,
      user: officialUser,
    });

    assert.equal(result.status, 'mismatch');
    assert.equal(result.match, false);
    assert.notEqual(result.calculatedChecksum, trustedChecksum);
    assert.ok(result.alert);
    assert.equal(inMemoryFdr.integrityStatus.status, 'mismatch');
    assert.equal(inMemoryFdr.integrityStatus.alerts.length, 1);
    assert.equal(inMemoryFdr.integrityStatus.alerts[0].status, 'active');
    assert.equal(inMemoryFdr.integrityStatus.alerts[0].expectedChecksum, trustedChecksum);
  });

  await context.test('3. Reviewer investigates and acknowledges mismatch alert', async () => {
    const alertId = inMemoryFdr.integrityStatus.alerts[0].alertId;
    const updateResult = await investigateIntegrityAlert({
      fdrId: inMemoryFdr._id,
      alertId,
      user: officialUser,
      payload: {
        status: 'acknowledged',
        investigationOutcome: 'Verified disk backup discrepancy. Bank inquiry dispatched.',
        notes: 'Review in progress with lead branch manager.',
      },
    });

    assert.equal(updateResult.success, true);
    assert.equal(updateResult.alert.status, 'acknowledged');
    assert.equal(
      updateResult.alert.investigationOutcome,
      'Verified disk backup discrepancy. Bank inquiry dispatched.',
    );
    assert.equal(String(updateResult.alert.investigatedBy), String(officialUser._id));
  });

  await context.test('4. Unavailable status when stored file is deleted/missing', async () => {
    await rm(path.join(tempDir, storageRef), { force: true });

    const result = await verifyStoredDocumentIntegrity({
      fdrId: inMemoryFdr._id,
      user: officialUser,
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.match, null);
    assert.ok(
      result.reason.includes('empty or unreadable') || result.reason.includes('could not be retrieved'),
    );
  });

  await context.test('5. Tenant scoping prevents cross-institution check', async () => {
    const unauthorizedInstitutionUser = {
      _id: new mongoose.Types.ObjectId(),
      role: 'institution_admin',
      institution: new mongoose.Types.ObjectId(), // Different institution
    };

    await assert.rejects(
      verifyStoredDocumentIntegrity({
        fdrId: inMemoryFdr._id,
        user: unauthorizedInstitutionUser,
      }),
      (err) => err.status === 403,
    );
  });

  await context.test('6. Non-official user denied alert investigation', async () => {
    await assert.rejects(
      investigateIntegrityAlert({
        fdrId: inMemoryFdr._id,
        alertId: 'test-alert-id',
        user: instUser,
        payload: { status: 'acknowledged' },
      }),
      (err) => err.status === 403,
    );
  });

  await context.test('7. Detailed integrity history retrieval', async () => {
    const historyData = await getFdrIntegrityHistory({
      fdrId: inMemoryFdr._id,
      user: officialUser,
    });

    assert.equal(historyData.fdrNumber, 'SBIN-2026-FDR-98124');
    assert.ok(Array.isArray(historyData.history));
    assert.ok(historyData.history.length >= 2);
    assert.ok(Array.isArray(historyData.alerts));
  });
});
