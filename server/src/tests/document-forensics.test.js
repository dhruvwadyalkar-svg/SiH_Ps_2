import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import app from '../app.js';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import ForensicAnalysis from '../models/ForensicAnalysis.js';
import User from '../models/User.js';
import { storeUploadedDocument } from '../services/document-storage.service.js';

const jwtSecret = 'synthetic-phase-seven-jwt-secret-with-32-characters';

const createServer = async (context) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

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
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

const makePng = (width = 2, height = 3, includeExif = false) => {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'ascii');
    const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    ...(includeExif ? [chunk('eXIf', Buffer.from('synthetic metadata'))] : []),
    chunk('IDAT', Buffer.from([0])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const makeJpeg = (width = 2, height = 3) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const frame = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    1, 1, 0x11, 0,
  ]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, scan, Buffer.from([0x01, 0xff, 0x00, 0x02, 0xff, 0xd9])]);
};

const makePdf = async (pages = 1) => {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
};

const makeUser = (institutionId, role = 'institution_user') => ({
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Synthetic Forensics User',
  email: 'forensics@example.test',
  role,
  isActive: true,
  institution: institutionId,
});

const makeFdr = ({ institutionId, documentMetadata = {} }) => ({
  _id: new mongoose.Types.ObjectId(),
  institution: institutionId,
  fdrNumber: 'SYNTH-FDR-7001',
  workflowStatus: 'submitted',
  documentMetadata: {
    storageRef: null,
    fileName: 'synthetic.pdf',
    mimeType: 'application/pdf',
    fileSize: null,
    checksum: null,
    ...documentMetadata,
  },
});

const authenticate = (context, user) => {
  process.env.JWT_SECRET = jwtSecret;
  context.mock.method(User, 'findById', () => queryFor(user));
  const token = jwt.sign({}, jwtSecret, {
    algorithm: 'HS256',
    subject: String(user._id),
    expiresIn: '10m',
  });
  return { authorization: `Bearer ${token}` };
};

const mockFdr = (context, fdr) => {
  context.mock.method(FDR, 'findById', () => queryFor(fdr));
};

const mockPersistence = (context) => {
  const reports = [];
  const audits = [];
  const fdrUpdates = [];
  context.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }));
  context.mock.method(FDR, 'updateOne', async (...args) => {
    fdrUpdates.push(args[1]);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  context.mock.method(ForensicAnalysis.prototype, 'save', async function () {
    await this.validate();
    reports.push(this);
    return this;
  });
  context.mock.method(AuditLog.prototype, 'save', async function () {
    await this.validate();
    audits.push(this);
    return this;
  });
  return { reports, audits, fdrUpdates };
};

const storeDocument = async (buffer, fileName, mimeType) =>
  storeUploadedDocument({ buffer, originalname: fileName, mimetype: mimeType });

test('Phase 7 document forensics routes and analysis', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  const previousStorage = process.env.FDR_STORAGE_DIR;
  const previousMaxBytes = process.env.FDR_MAX_UPLOAD_BYTES;
  const storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-fdr-forensics-'));
  process.env.FDR_STORAGE_DIR = storageDirectory;
  delete process.env.FDR_MAX_UPLOAD_BYTES;
  context.after(async () => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousStorage === undefined) delete process.env.FDR_STORAGE_DIR;
    else process.env.FDR_STORAGE_DIR = previousStorage;
    if (previousMaxBytes === undefined) delete process.env.FDR_MAX_UPLOAD_BYTES;
    else process.env.FDR_MAX_UPLOAD_BYTES = previousMaxBytes;
    await rm(storageDirectory, { recursive: true, force: true });
  });

  const baseUrl = await createServer(context);
  const institutionId = new mongoose.Types.ObjectId();
  const user = makeUser(institutionId);

  await context.test('requires authentication and denies cross-institution access', async (subtest) => {
    const fdr = makeFdr({ institutionId: new mongoose.Types.ObjectId() });
    mockFdr(subtest, fdr);
    subtest.mock.method(ForensicAnalysis, 'findOne', () => queryFor(null));
    const id = String(fdr._id);
    const headers = authenticate(subtest, user);
    assert.equal((await fetch(`${baseUrl}/api/fdrs/${id}/forensics`, { method: 'POST' })).status, 401);
    const response = await fetch(`${baseUrl}/api/fdrs/${id}/forensics`, {
      method: 'POST',
      headers,
    });
    assert.equal(response.status, 403);
    const readResponse = await fetch(`${baseUrl}/api/fdrs/${id}/forensics`, {
      headers,
    });
    assert.equal(readResponse.status, 403);
  });

  await context.test('returns not-yet-analyzed and rejects unsupported stored document types', async (subtest) => {
    const fdr = makeFdr({ institutionId });
    mockFdr(subtest, fdr);
    subtest.mock.method(ForensicAnalysis, 'findOne', () => queryFor(null));
    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      headers: authenticate(subtest, user),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'analysis_not_found');

    subtest.mock.restoreAll();
    const unsupported = makeFdr({
      institutionId,
      documentMetadata: { storageRef: 'synthetic-key', mimeType: 'text/plain' },
    });
    mockFdr(subtest, unsupported);
    const state = mockPersistence(subtest);
    const rejected = await fetch(`${baseUrl}/api/fdrs/${unsupported._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    assert.equal(rejected.status, 422);
    assert.equal(state.audits[0].action, 'fdr_forensics_requested');
    assert.equal(state.audits.at(-1).action, 'fdr_forensics_failed');
  });

  await context.test('verifies the upload checksum and persists a transparent PDF report and audit history', async (subtest) => {
    const pdf = await makePdf();
    const stored = await storeDocument(pdf, 'synthetic.pdf', 'application/pdf');
    const fdr = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: stored.storageKey,
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        fileSize: stored.fileSize,
        checksum: stored.checksum,
      },
    });
    mockFdr(subtest, fdr);
    const persistence = mockPersistence(subtest);
    const headers = authenticate(subtest, user);

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      method: 'POST',
      headers,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.analysis.fdrId, String(fdr._id));
    assert.equal(body.analysis.checksum, stored.checksum);
    assert.equal(body.analysis.metadata.checksumVerified, true);
    assert.equal(body.analysis.metadata.format, 'pdf');
    assert.equal(body.analysis.metadata.pageCount, 1);
    assert.equal(body.analysis.metadata.digitalSignatureValidationSupported, false);
    assert.equal(body.analysis.status, 'no_signals_detected');
    assert.equal(body.analysis.metadata.title, null);
    assert.equal(body.analysis.metadata.author, null);
    assert.equal(JSON.stringify(body).includes(storageDirectory), false);
    assert.equal(persistence.reports.length, 1);
    assert.deepEqual(persistence.audits.map(({ action }) => action), [
      'fdr_forensics_requested',
      'fdr_forensics_completed',
    ]);
    assert.equal(persistence.audits.every(({ metadata }) => Boolean(metadata.analysisId)), true);

    const nextResponse = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      method: 'POST',
      headers,
    });
    const nextBody = await nextResponse.json();
    assert.equal(nextResponse.status, 200);
    assert.equal(persistence.reports.length, 2);
    assert.notEqual(persistence.reports[0]._id.toString(), persistence.reports[1]._id.toString());
    assert.equal(
      persistence.fdrUpdates.at(-1).$set.latestForensicAnalysis.toString(),
      persistence.reports.at(-1)._id.toString(),
    );

    subtest.mock.method(ForensicAnalysis, 'findOne', () => queryFor(persistence.reports.at(-1)));
    const latestResponse = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      headers,
    });
    const latest = await latestResponse.json();
    assert.equal(latestResponse.status, 200);
    assert.equal(latest.analysis.analysisId, nextBody.analysis.analysisId);
  });

  await context.test('flags changed bytes conclusively without rewriting them', async (subtest) => {
    const pdf = await makePdf();
    const stored = await storeDocument(pdf, 'synthetic.pdf', 'application/pdf');
    const modified = Buffer.from(pdf);
    modified[modified.length - 1] ^= 1;
    await writeFile(path.join(storageDirectory, stored.storageKey), modified);
    const fdr = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: stored.storageKey,
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        checksum: stored.checksum,
      },
    });
    mockFdr(subtest, fdr);
    const persistence = mockPersistence(subtest);

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    const { analysis } = await response.json();

    assert.equal(response.status, 200);
    assert.equal(analysis.status, 'integrity_check_failed');
    const mismatch = analysis.findings.find(({ code }) => code === 'stored_file_integrity_mismatch');
    assert.equal(mismatch.conclusive, true);
    assert.equal(mismatch.heuristic, false);
    assert.match(mismatch.explanation, /since upload/i);
    assert.equal(persistence.audits.at(-1).action, 'fdr_forensics_failed');
    assert.deepEqual(await readFile(path.join(storageDirectory, stored.storageKey)), modified);
  });

  await context.test('detects missing files and malformed supported documents', async (subtest) => {
    const missing = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: 'b6dbd3bc-5ce5-4e31-b46d-148fc4c329a1.pdf',
        checksum: 'a'.repeat(64),
      },
    });
    mockFdr(subtest, missing);
    let persistence = mockPersistence(subtest);
    let response = await fetch(`${baseUrl}/api/fdrs/${missing._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    let body = await response.json();
    assert.equal(body.analysis.status, 'analysis_inconclusive');
    assert.equal(body.analysis.findings[0].code, 'stored_file_unavailable');
    assert.equal(persistence.audits.at(-1).action, 'fdr_forensics_completed');

    subtest.mock.restoreAll();
    const corrupt = await storeDocument(Buffer.from('%PDF-1.4\nnot a valid PDF'), 'broken.pdf', 'application/pdf');
    const malformedPdf = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: corrupt.storageKey,
        fileName: corrupt.fileName,
        mimeType: corrupt.mimeType,
        checksum: corrupt.checksum,
      },
    });
    mockFdr(subtest, malformedPdf);
    mockPersistence(subtest);
    response = await fetch(`${baseUrl}/api/fdrs/${malformedPdf._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.analysis.status, 'analysis_failed');
    assert.equal(body.analysis.findings.some(({ code }) => code === 'malformed_pdf'), true);

    subtest.mock.restoreAll();
    const malformedPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const malformed = await storeDocument(malformedPng, 'broken.png', 'image/png');
    const malformedFdr = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: malformed.storageKey,
        fileName: malformed.fileName,
        mimeType: malformed.mimeType,
        checksum: malformed.checksum,
      },
    });
    mockFdr(subtest, malformedFdr);
    persistence = mockPersistence(subtest);
    response = await fetch(`${baseUrl}/api/fdrs/${malformedFdr._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    body = await response.json();
    assert.equal(body.analysis.status, 'analysis_failed');
    assert.equal(body.analysis.findings.some(({ code }) => code === 'malformed_image'), true);
    assert.equal(persistence.audits.at(-1).action, 'fdr_forensics_failed');
  });

  await context.test('inspects PNG and JPEG metadata and marks missing metadata as heuristic', async (subtest) => {
    for (const [bytes, fileName, mimeType, format] of [
      [makePng(), 'synthetic.png', 'image/png', 'png'],
      [makeJpeg(), 'synthetic.jpg', 'image/jpeg', 'jpeg'],
    ]) {
      subtest.mock.restoreAll();
      const stored = await storeDocument(bytes, fileName, mimeType);
      const fdr = makeFdr({
        institutionId,
        documentMetadata: {
          storageRef: stored.storageKey,
          fileName: stored.fileName,
          mimeType: stored.mimeType,
          checksum: stored.checksum,
        },
      });
      mockFdr(subtest, fdr);
      const persistence = mockPersistence(subtest);
      const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
        method: 'POST',
        headers: authenticate(subtest, user),
      });
      const { analysis } = await response.json();
      assert.equal(response.status, 200);
      assert.equal(analysis.metadata.format, format);
      assert.equal(analysis.metadata.width, 2);
      assert.equal(analysis.metadata.height, 3);
      const metadataFinding = analysis.findings.find(({ code }) => code === 'image_metadata_absent');
      assert.equal(metadataFinding.severity, 'low');
      assert.equal(metadataFinding.heuristic, true);
      assert.equal(analysis.status, 'review_recommended');
      assert.equal(persistence.reports.length, 1);
    }
  });

  await context.test('enforces image resource bounds and records analysis history', async (subtest) => {
    const oversizedImage = makePng(8000, 6000);
    const firstStored = await storeDocument(oversizedImage, 'large.png', 'image/png');
    const fdr = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: firstStored.storageKey,
        fileName: firstStored.fileName,
        mimeType: firstStored.mimeType,
        checksum: firstStored.checksum,
      },
    });
    mockFdr(subtest, fdr);
    const persistence = mockPersistence(subtest);
    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    const { analysis } = await response.json();
    assert.equal(analysis.status, 'analysis_inconclusive');
    assert.equal(analysis.findings.some(({ code }) => code === 'image_pixel_limit_exceeded'), true);

    subtest.mock.restoreAll();
    const existing = new ForensicAnalysis({
      _id: new mongoose.Types.ObjectId(),
      fdrId: fdr._id,
      checksum: firstStored.checksum,
      engine: 'local-document-forensics',
      analysisVersion: '1.0.0',
      status: 'no_signals_detected',
      findings: [],
      limitations: [],
      analyzedAt: new Date(),
    });
    mockFdr(subtest, fdr);
    subtest.mock.method(ForensicAnalysis, 'findOne', () => queryFor(existing));
    const getResponse = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      headers: authenticate(subtest, user),
    });
    const latest = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(latest.analysis.analysisId, String(existing._id));
    assert.equal(persistence.reports.length, 1);

    subtest.mock.restoreAll();
    const largePdf = await makePdf(21);
    const largePdfStored = await storeDocument(largePdf, 'twenty-one-pages.pdf', 'application/pdf');
    const pageLimitedFdr = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: largePdfStored.storageKey,
        fileName: largePdfStored.fileName,
        mimeType: largePdfStored.mimeType,
        checksum: largePdfStored.checksum,
      },
    });
    mockFdr(subtest, pageLimitedFdr);
    mockPersistence(subtest);
    const pageResponse = await fetch(`${baseUrl}/api/fdrs/${pageLimitedFdr._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    const pageBody = await pageResponse.json();
    assert.equal(pageBody.analysis.status, 'analysis_inconclusive');
    assert.equal(pageBody.analysis.findings.some(({ code }) => code === 'pdf_page_limit_exceeded'), true);
  });

  await context.test('does not present a no-signals result as an authenticity determination', async (subtest) => {
    const bytes = makePng(2, 3, true);
    const stored = await storeDocument(bytes, 'synthetic.png', 'image/png');
    const fdr = makeFdr({
      institutionId,
      documentMetadata: {
        storageRef: stored.storageKey,
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
    });
    mockFdr(subtest, fdr);
    mockPersistence(subtest);
    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/forensics`, {
      method: 'POST',
      headers: authenticate(subtest, user),
    });
    const { analysis } = await response.json();
    assert.equal(response.status, 200);
    assert.equal(analysis.status, 'no_signals_detected');
    assert.equal(analysis.limitations.some((explanation) => /not a determination that a document is genuine/i.test(explanation)), true);
    assert.equal(analysis.status === 'REAL' || analysis.status === 'FAKE', false);
  });
});
