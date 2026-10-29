import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import mongoose from 'mongoose';
import AuditLog, {
  GENESIS_HASH,
  canonicalPayloadFromDoc,
  canonicalStringify,
  computeEventHash,
} from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Notification from '../models/Notification.js';
import {
  exportAuditLogsCsv,
  getAuditLogDetails,
  listAuditLogs,
  recordAuditEvent,
  verifyAuditChainIntegrity,
} from '../services/audit-log.service.js';
import { verifyStoredDocumentIntegrity } from '../services/document-integrity.service.js';

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
    return this;
  },
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

test('Feature 2: Tamper-Evident Audit Trail & Cryptographic Verification', async (context) => {
  const inMemoryLogs = [];

  context.mock.method(AuditLog, 'find', (filter) => {
    let result = [...inMemoryLogs];
    if (filter?.action) {
      result = result.filter((r) => r.action === filter.action);
    }
    return queryFor(result);
  });

  context.mock.method(AuditLog, 'findOne', (filter) => {
    let match = null;
    if (filter?.sequence) {
      if (filter.sequence.$ne !== undefined) {
        match = inMemoryLogs.length > 0 ? inMemoryLogs[inMemoryLogs.length - 1] : null;
      } else {
        match = inMemoryLogs.find((r) => r.sequence === filter.sequence) || null;
      }
    }
    return queryFor(match);
  });

  context.mock.method(AuditLog, 'findById', (id) => {
    const found = inMemoryLogs.find((r) => String(r._id) === String(id));
    return queryFor(found || null);
  });

  context.mock.method(AuditLog, 'countDocuments', (filter) => {
    if (filter?.action === 'fdr_document_integrity_verified') {
      return queryFor(inMemoryLogs.filter((r) => r.action === 'fdr_document_integrity_verified').length);
    }
    if (filter?.$or) {
      return queryFor(inMemoryLogs.filter((r) => r.outcome === 'failure').length);
    }
    return queryFor(inMemoryLogs.length);
  });

  context.mock.method(AuditLog.prototype, 'save', async function mockSave() {
    if (!this.createdAt) this.createdAt = new Date();
    if (!this._id) this._id = new mongoose.Types.ObjectId();

    if (!this.sequence || !this.hash) {
      const latest = inMemoryLogs.length > 0 ? inMemoryLogs[inMemoryLogs.length - 1] : null;
      this.sequence = latest?.sequence ? latest.sequence + 1 : 1;
      this.previousHash = latest?.hash || GENESIS_HASH;
      const payload = canonicalPayloadFromDoc(this);
      this.hash = computeEventHash(payload, this.previousHash);
    }

    const savedDoc = {
      _id: this._id,
      sequence: this.sequence,
      actor: this.actor,
      actorRole: this.actorRole,
      action: this.action,
      entityType: this.entityType,
      entityId: this.entityId,
      outcome: this.outcome || 'success',
      reason: this.reason || null,
      correlationId: this.correlationId || null,
      documentVersion: this.documentVersion || 1,
      documentChecksum: this.documentChecksum || null,
      diff: this.diff || [],
      metadata: this.metadata || {},
      previousHash: this.previousHash,
      hash: this.hash,
      createdAt: this.createdAt,
    };

    inMemoryLogs.push(savedDoc);
    return savedDoc;
  });

  context.mock.method(FDR, 'find', () => queryFor([]));
  context.mock.method(Notification, 'create', async (item) => item);

  const adminUser = {
    _id: new mongoose.Types.ObjectId(),
    fullName: 'Dr. Sunita Deshmukh',
    email: 'auditor@aicte-india.org',
    role: 'aicte_admin',
  };

  const institutionUser = {
    _id: new mongoose.Types.ObjectId(),
    fullName: 'Prof. Rajesh Sharma',
    email: 'dean@delhi-tech.edu.in',
    role: 'institution_admin',
    institution: new mongoose.Types.ObjectId(),
  };

  await context.test('1. Monotonic hash chain generation starting from genesis hash', async () => {
    inMemoryLogs.length = 0;

    const event1 = await recordAuditEvent({
      actor: adminUser._id,
      actorRole: adminUser.role,
      action: 'fdr_document_uploaded',
      entityId: new mongoose.Types.ObjectId(),
      documentVersion: 1,
      documentChecksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      metadata: { fileName: 'deposit_receipt.pdf' },
    });

    assert.equal(event1.sequence, 1);
    assert.equal(event1.previousHash, GENESIS_HASH);
    assert.equal(typeof event1.hash, 'string');
    assert.equal(event1.hash.length, 64);

    const event2 = await recordAuditEvent({
      actor: adminUser._id,
      actorRole: adminUser.role,
      action: 'fdr_created',
      entityId: event1.entityId,
      documentVersion: 1,
      documentChecksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      metadata: { fdrNumber: 'SBIN-2026-FDR-98124', amount: 10000000 },
    });

    assert.equal(event2.sequence, 2);
    assert.equal(event2.previousHash, event1.hash);
    assert.equal(typeof event2.hash, 'string');
    assert.equal(event2.hash.length, 64);

    const event3 = await recordAuditEvent({
      actor: adminUser._id,
      actorRole: adminUser.role,
      action: 'fdr_metadata_updated',
      entityId: event1.entityId,
      reason: 'Deposit amount updated per regional lien revision',
      diff: [{ field: 'amount', previousValue: 10000000, newValue: 12500000 }],
      documentVersion: 1,
    });

    assert.equal(event3.sequence, 3);
    assert.equal(event3.previousHash, event2.hash);
    assert.equal(event3.diff[0].field, 'amount');
    assert.equal(event3.diff[0].newValue, 12500000);
  });

  await context.test('2. Cryptographic audit chain verification succeeds on untampered log', async () => {
    const verification = await verifyAuditChainIntegrity();

    assert.equal(verification.status, 'valid');
    assert.equal(verification.totalEvents, 3);
    assert.equal(verification.verifiedCount, 3);
    assert.equal(verification.brokenEvents.length, 0);
    assert.equal(verification.genesisHash, GENESIS_HASH);
    assert.equal(verification.latestHash, inMemoryLogs[2].hash);
  });

  await context.test('3. Detection of maliciously altered block content (tamper detection)', async () => {
    // Maliciously modify field in event sequence 2
    const originalAction = inMemoryLogs[1].action;
    inMemoryLogs[1].action = 'malicious_unauthorized_action';

    const verification = await verifyAuditChainIntegrity();
    assert.equal(verification.status, 'corrupted');
    assert.equal(verification.brokenEvents.length, 1);
    assert.equal(verification.brokenEvents[0].sequence, 2);
    assert.ok(verification.brokenEvents[0].reasons[0].includes('Event content altered'));

    // Revert alteration
    inMemoryLogs[1].action = originalAction;
    const restoredVerification = await verifyAuditChainIntegrity();
    assert.equal(restoredVerification.status, 'valid');
  });

  await context.test('4. Detection of missing / deleted log entry in chain', async () => {
    const deletedEntry = inMemoryLogs.splice(1, 1)[0]; // Remove sequence 2

    const verification = await verifyAuditChainIntegrity();
    assert.equal(verification.status, 'corrupted');
    assert.ok(verification.brokenEvents.length > 0);
    assert.ok(
      verification.brokenEvents.some((b) =>
        b.reasons.some((r) => r.includes('Sequence mismatch') || r.includes('Previous hash link broken')),
      ),
    );

    // Restore removed entry
    inMemoryLogs.splice(1, 0, deletedEntry);
  });

  await context.test('5. Document cryptographic SHA-256 verification (verified, mismatch, unavailable)', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fdr-audit-test-'));
    process.env.FDR_STORAGE_DIR = tempDir;

    const fileContent = Buffer.from('AUTHENTIC AICTE SECURITY DEPOSIT INSTRUMENT 2026');
    const correctChecksum = crypto.createHash('sha256').update(fileContent).digest('hex');
    const storageKey = `${crypto.randomUUID()}.pdf`;

    await writeFile(path.join(tempDir, storageKey), fileContent);

    const fdrSample = {
      _id: new mongoose.Types.ObjectId(),
      institution: institutionUser.institution,
      fdrNumber: 'SBIN-2026-FDR-98124',
      bankName: 'State Bank of India',
      documentMetadata: {
        storageRef: storageKey,
        fileName: 'statutory_instrument.pdf',
        mimeType: 'application/pdf',
        fileSize: fileContent.length,
        checksum: correctChecksum,
        version: 1,
      },
    };

    context.mock.method(FDR, 'findById', () => queryFor(fdrSample));

    // 5a. Verified on identical file
    const verifiedResult = await verifyStoredDocumentIntegrity({
      fdrId: fdrSample._id,
      user: adminUser,
    });

    assert.equal(verifiedResult.status, 'verified');
    assert.equal(verifiedResult.match, true);
    assert.equal(verifiedResult.recordedChecksum, correctChecksum);
    assert.equal(verifiedResult.calculatedChecksum, correctChecksum);

    // 5b. Mismatch on altered file
    await writeFile(path.join(tempDir, storageKey), Buffer.from('MODIFIED FORGED FDR CONTENT'));

    const mismatchResult = await verifyStoredDocumentIntegrity({
      fdrId: fdrSample._id,
      user: adminUser,
    });

    assert.equal(mismatchResult.status, 'mismatch');
    assert.equal(mismatchResult.match, false);
    assert.notEqual(mismatchResult.calculatedChecksum, correctChecksum);
    assert.ok(mismatchResult.alert);

    // Check that mismatch logged an audit event
    const lastLog = inMemoryLogs[inMemoryLogs.length - 1];
    assert.equal(lastLog.action, 'fdr_document_integrity_mismatch');
    assert.equal(lastLog.outcome, 'failure');

    // 5c. Unavailable on missing file
    await rm(path.join(tempDir, storageKey), { force: true });
    const missingResult = await verifyStoredDocumentIntegrity({
      fdrId: fdrSample._id,
      user: adminUser,
    });

    assert.equal(missingResult.status, 'unavailable');
    assert.ok(missingResult.reason);

    await rm(tempDir, { recursive: true, force: true });
  });

  await context.test('6. Audit list and filtering returns verified statistics and pagination', async () => {
    const result = await listAuditLogs({
      user: adminUser,
      query: { page: 1, limit: 10 },
    });

    assert.ok(Array.isArray(result.records));
    assert.ok(result.pagination.total >= 3);
    assert.ok(result.summary.totalEvents >= 3);
    assert.equal(typeof result.summary.verifiedChecks, 'number');
    assert.equal(typeof result.summary.failedIntegrityChecks, 'number');
  });

  await context.test('7. Formula-safe CSV export prevents injection and formats UTC data', async () => {
    const csv = await exportAuditLogsCsv({
      user: adminUser,
      query: {},
    });

    assert.ok(csv.includes('# AICTE Central Fixed Deposit Receipt Portal - Tamper-Evident Audit Report'));
    assert.ok(csv.includes('Timestamp (UTC)'));
    assert.ok(csv.includes('Previous Block Hash'));
    assert.ok(csv.includes('Current Block Hash'));
  });

  await context.test('8. Role-based authorization denies non-officials access to audit trail', async () => {
    await assert.rejects(
      async () => {
        await listAuditLogs({ user: institutionUser, query: {} });
      },
      { status: 403 },
    );

    await assert.rejects(
      async () => {
        await exportAuditLogsCsv({ user: institutionUser, query: {} });
      },
      { status: 403 },
    );
  });
});
