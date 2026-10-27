import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app.js';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import User from '../models/User.js';
import { storeUploadedDocument } from '../services/document-storage.service.js';
import { sarvamOcrService } from '../services/sarvam-ocr.service.js';

const jwtSecret = 'synthetic-phase-six-jwt-secret-with-at-least-32-characters';

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
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

const makePdf = async (pages = 1) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Synthetic test FDR ${index + 1}`, { x: 48, y: 720, font, size: 12 });
  }
  return Buffer.from(await pdf.save());
};

const makeInstitution = () => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'Synthetic Institute',
});

const makeUser = (role = 'institution_user', institution = makeInstitution()) => ({
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Synthetic OCR User',
  email: 'synthetic.ocr@example.test',
  role,
  isActive: true,
  institution: institution?._id || null,
});

const makeFdr = ({
  institution = makeInstitution(),
  workflowStatus = 'submitted',
  status = 'not_started',
  providerJobId = null,
  storageRef = null,
  mimeType = storageRef ? 'application/pdf' : null,
  extractedData = {},
} = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  institution: institution._id,
  fdrNumber: 'SYNTH-FDR-001',
  bankName: 'Example Test Bank',
  branch: 'Central Test Branch',
  amount: 12345,
  currency: 'INR',
  issueDate: new Date('2026-01-01T00:00:00.000Z'),
  maturityDate: new Date('2027-01-01T00:00:00.000Z'),
  workflowStatus,
  financialStatus: 'active',
  documentMetadata: {
    storageRef,
    fileName: 'synthetic-statement.pdf',
    mimeType,
    fileSize: null,
    checksum: null,
    uploadedAt: new Date(),
  },
  ocrResult: {
    status,
    providerJobId,
    submittedAt: status === 'not_started' ? null : new Date('2026-01-02T00:00:00.000Z'),
    completedAt: null,
    processedAt: null,
    extractedData,
    comparisonResults: {},
    providerErrorCode: null,
  },
});

const makeSession = (context) =>
  context.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }));

const authenticateAs = (context, user) => {
  process.env.JWT_SECRET = jwtSecret;
  context.mock.method(User, 'findById', () => queryFor(user));
  const token = jwt.sign(
    { role: 'aicte_admin' },
    jwtSecret,
    { algorithm: 'HS256', subject: String(user._id), expiresIn: '10m' },
  );
  return { authorization: `Bearer ${token}` };
};

const saveStoredPdf = async (document) =>
  storeUploadedDocument({
    buffer: document,
    originalname: 'synthetic-statement.pdf',
    mimetype: 'application/pdf',
  });

const mockFdr = (context, fdr) => {
  context.mock.method(FDR, 'findById', () => queryFor(fdr));
};

const mockUpdate = (context) =>
  context.mock.method(FDR, 'updateOne', async () => ({ matchedCount: 1, modifiedCount: 1 }));

const captureAudits = (context) => {
  const events = [];
  context.mock.method(AuditLog.prototype, 'save', async function () {
    await this.validate();
    events.push(this);
    return this;
  });
  return events;
};

test('Phase 6 Sarvam FDR extraction routes', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.SARVAM_API_KEY;
  const previousStorage = process.env.FDR_STORAGE_DIR;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-fdr-ocr-'));
  context.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousApiKey === undefined) delete process.env.SARVAM_API_KEY;
    else process.env.SARVAM_API_KEY = previousApiKey;
    if (previousStorage === undefined) delete process.env.FDR_STORAGE_DIR;
    else process.env.FDR_STORAGE_DIR = previousStorage;
    return rm(tempDirectory, { recursive: true, force: true });
  });
  process.env.FDR_STORAGE_DIR = tempDirectory;
  delete process.env.SARVAM_API_KEY;

  const syntheticPdf = await makePdf();

  await context.test('requires authentication and denies cross-institution access', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const id = new mongoose.Types.ObjectId();
    assert.equal((await fetch(`${baseUrl}/api/fdrs/${id}/extract`, { method: 'POST' })).status, 401);

    const institution = makeInstitution();
    const otherInstitution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const fdr = makeFdr({ institution: otherInstitution });
    mockFdr(subtest, fdr);
    const denied = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extract`, {
      method: 'POST',
      headers: authenticateAs(subtest, user),
    });
    assert.equal(denied.status, 403);
  });

  await context.test('rejects missing and unsupported documents and invalid workflow states', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const headers = authenticateAs(subtest, user);
    const missing = makeFdr({ institution });
    mockFdr(subtest, missing);
    let response = await fetch(`${baseUrl}/api/fdrs/${missing._id}/extract`, {
      method: 'POST',
      headers,
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'missing_document');

    subtest.mock.restoreAll();
    const unsupported = makeFdr({
      institution,
      storageRef: '3d6fd79c-dcb7-4e31-9a7d-16a0fcbec65a.pdf',
      mimeType: 'application/tiff',
    });
    mockFdr(subtest, unsupported);
    response = await fetch(`${baseUrl}/api/fdrs/${unsupported._id}/extract`, {
      method: 'POST',
      headers: authenticateAs(subtest, user),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'unsupported_document');

    subtest.mock.restoreAll();
    const draft = makeFdr({
      institution,
      workflowStatus: 'draft',
      storageRef: '3d6fd79c-dcb7-4e31-9a7d-16a0fcbec65a.pdf',
    });
    mockFdr(subtest, draft);
    response = await fetch(`${baseUrl}/api/fdrs/${draft._id}/extract`, {
      method: 'POST',
      headers: authenticateAs(subtest, user),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'invalid_workflow_state');
  });

  await context.test('submits the authorized stored document and persists a safe request audit', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_admin', institution);
    const stored = await saveStoredPdf(syntheticPdf);
    const fdr = makeFdr({ institution, storageRef: stored.storageKey });
    mockFdr(subtest, fdr);
    makeSession(subtest);
    mockUpdate(subtest);
    const events = captureAudits(subtest);
    const submit = subtest.mock.method(sarvamOcrService, 'submitExtraction', async (request) => {
      assert.deepEqual(request.document, syntheticPdf);
      assert.equal(request.mimeType, 'application/pdf');
      assert.equal(request.fileName, 'synthetic-statement.pdf');
      return { jobId: 'synthetic-provider-job', status: 'pending' };
    });

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extract`, {
      method: 'POST',
      headers: authenticateAs(subtest, user),
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.deepEqual(body, {
      fdrId: String(fdr._id),
      status: 'queued',
      jobReference: 'synthetic-provider-job',
    });
    assert.equal(fdr.ocrResult.providerJobId, 'synthetic-provider-job');
    assert.equal(fdr.fdrNumber, 'SYNTH-FDR-001');
    assert.equal(events[0].action, 'fdr_ocr_requested');
    assert.equal(events[0].actor, user._id);
    assert.equal(events[0].metadata.provider, 'sarvam');
    assert.equal(JSON.stringify(body).includes(tempDirectory), false);
    assert.equal(submit.mock.callCount(), 1);
  });

  await context.test('rejects duplicate running and completed requests without resubmitting', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    let submitCalls = 0;
    subtest.mock.method(sarvamOcrService, 'submitExtraction', async () => {
      submitCalls += 1;
      return { jobId: 'synthetic-job', status: 'pending' };
    });

    for (const status of ['processing', 'completed']) {
      subtest.mock.restoreAll();
      const fdr = makeFdr({
        institution,
        status,
        providerJobId: status === 'processing' ? 'synthetic-running-job' : null,
        storageRef: '3d6fd79c-dcb7-4e31-9a7d-16a0fcbec65a.pdf',
      });
      mockFdr(subtest, fdr);
      const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extract`, {
        method: 'POST',
        headers: authenticateAs(subtest, user),
      });
      assert.equal(response.status, 409);
    }

    assert.equal(submitCalls, 0);
  });

  await context.test('polls job progress and caches it without returning a provider job ID', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('reviewer', null);
    const fdr = makeFdr({
      institution,
      status: 'queued',
      providerJobId: 'synthetic-poll-job',
    });
    mockFdr(subtest, fdr);
    mockUpdate(subtest);
    const getStatus = subtest.mock.method(sarvamOcrService, 'getJobStatus', async (jobId) => {
      assert.equal(jobId, 'synthetic-poll-job');
      return { status: 'running' };
    });

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extraction`, {
      headers: authenticateAs(subtest, user),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'processing');
    assert.equal(Object.hasOwn(body, 'jobReference'), false);
    assert.equal(body.extractedFields, null);
    assert.equal(getStatus.mock.callCount(), 1);
  });

  await context.test('persists completed fields separately and compares normalized values', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const fdr = makeFdr({
      institution,
      status: 'processing',
      providerJobId: 'synthetic-completed-job',
    });
    mockFdr(subtest, fdr);
    mockUpdate(subtest);
    makeSession(subtest);
    const events = captureAudits(subtest);
    subtest.mock.method(sarvamOcrService, 'getJobStatus', async () => ({ status: 'completed' }));
    subtest.mock.method(sarvamOcrService, 'getJobResults', async () => ({
      fdr_number: ' synth-fdr-001 ',
      bank_name: 'example test bank',
      branch_name: 'Other Branch',
      deposit_amount: 12345,
      currency: 'INR',
      issue_date: '2026-01-01',
      maturity_date: '2027-01-01',
      institution_name: 'Synthetic Institute',
    }));
    subtest.mock.method(Institution, 'findById', () => queryFor({ name: institution.name }));

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extraction`, {
      headers: authenticateAs(subtest, user),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'completed');
    assert.equal(body.extractedFields.fdr_number, 'synth-fdr-001');
    assert.equal(body.comparisons.fdr_number.status, 'match');
    assert.equal(body.comparisons.bank_name.status, 'match');
    assert.equal(body.comparisons.branch_name.status, 'mismatch');
    assert.equal(body.comparisons.deposit_amount.status, 'match');
    assert.equal(body.comparisons.institution_name.status, 'match');
    assert.equal(fdr.fdrNumber, 'SYNTH-FDR-001');
    assert.equal(fdr.bankName, 'Example Test Bank');
    assert.equal(fdr.ocrResult.extractedData.bank_name, 'example test bank');
    assert.equal(events.at(-1).action, 'fdr_ocr_completed');
    assert.equal(events.at(-1).metadata.extractedFieldCount, 8);
  });

  await context.test('returns missing-field comparisons for partial results', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('aicte_admin', null);
    const fdr = makeFdr({
      institution,
      status: 'queued',
      providerJobId: 'synthetic-partial-job',
    });
    mockFdr(subtest, fdr);
    mockUpdate(subtest);
    makeSession(subtest);
    captureAudits(subtest);
    subtest.mock.method(sarvamOcrService, 'getJobStatus', async () => ({ status: 'partially_completed' }));
    subtest.mock.method(sarvamOcrService, 'getJobResults', async () => ({
      fdr_number: null,
      deposit_amount: 12345,
    }));
    subtest.mock.method(Institution, 'findById', () => queryFor({ name: institution.name }));

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extraction`, {
      headers: authenticateAs(subtest, user),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'partially_completed');
    assert.equal(body.comparisons.fdr_number.status, 'missing_or_unreadable');
    assert.equal(body.comparisons.bank_name.status, 'missing_or_unreadable');
    assert.equal(body.comparisons.deposit_amount.status, 'match');
  });

  await context.test('records failed and rejected jobs without changing submitted FDR values', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('reviewer', null);

    for (const status of ['failed', 'rejected']) {
      subtest.mock.restoreAll();
      const fdr = makeFdr({
        institution,
        status: 'processing',
        providerJobId: `synthetic-${status}-job`,
        extractedData: { fdr_number: 'previous OCR value' },
      });
      mockFdr(subtest, fdr);
      makeSession(subtest);
      mockUpdate(subtest);
      const events = captureAudits(subtest);
      subtest.mock.method(sarvamOcrService, 'getJobStatus', async () => ({ status }));

      const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extraction`, {
        headers: authenticateAs(subtest, user),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.status, status);
      assert.equal(body.extractedFields, null);
      assert.equal(fdr.fdrNumber, 'SYNTH-FDR-001');
      assert.equal(fdr.ocrResult.extractedData.fdr_number, 'previous OCR value');
      assert.equal(fdr.ocrResult.providerErrorCode, status === 'failed' ? 'provider_error' : 'document_rejected');
      assert.equal(events.at(-1).action, 'fdr_ocr_failed');
    }
  });

  await context.test('marks malformed provider output failed and does not expose it', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('reviewer', null);
    const fdr = makeFdr({
      institution,
      status: 'processing',
      providerJobId: 'synthetic-malformed-job',
    });
    mockFdr(subtest, fdr);
    mockUpdate(subtest);
    makeSession(subtest);
    captureAudits(subtest);
    subtest.mock.method(sarvamOcrService, 'getJobStatus', async () => ({ status: 'completed' }));
    subtest.mock.method(sarvamOcrService, 'getJobResults', async () => ({
      fdr_number: 'SYNTH-FDR-001',
      deposit_amount: { invalid: 'value' },
    }));

    const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extraction`, {
      headers: authenticateAs(subtest, user),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'failed');
    assert.equal(body.errorCode, 'malformed_response');
    assert.equal(body.extractedFields, null);
    assert.equal(JSON.stringify(body).includes('invalid'), false);
  });

  await context.test('returns safe rate-limit and timeout errors and persists failure audits', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();

    for (const [errorCode, status] of [['rate_limited', 503], ['provider_timeout', 504]]) {
      subtest.mock.restoreAll();
      const events = captureAudits(subtest);
      const user = makeUser('institution_admin', institution);
      const stored = await saveStoredPdf(syntheticPdf);
      const fdr = makeFdr({ institution, storageRef: stored.storageKey });
      mockFdr(subtest, fdr);
      makeSession(subtest);
      mockUpdate(subtest);
      subtest.mock.method(sarvamOcrService, 'submitExtraction', async () => {
        const { SarvamOcrError } = await import('../services/sarvam-ocr.service.js');
        throw new SarvamOcrError(errorCode, status, 'Synthetic safe provider error.');
      });

      const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extract`, {
        method: 'POST',
        headers: authenticateAs(subtest, user),
      });
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(body.code, errorCode);
      assert.equal(JSON.stringify(body).includes('api key'), false);
      assert.equal(fdr.ocrResult.status, 'failed');
      assert.equal(fdr.fdrNumber, 'SYNTH-FDR-001');
      assert.ok(events.some((event) => event.action === 'fdr_ocr_failed'));
    }
  });

  await context.test('rate limits OCR submissions per authenticated user', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const stored = await saveStoredPdf(syntheticPdf);
    const fdr = makeFdr({ institution, storageRef: stored.storageKey });
    mockFdr(subtest, fdr);
    makeSession(subtest);
    mockUpdate(subtest);
    captureAudits(subtest);
    subtest.mock.method(sarvamOcrService, 'submitExtraction', async () => ({
      jobId: 'synthetic-rate-limited-job',
      status: 'pending',
    }));
    const headers = authenticateAs(subtest, user);
    const statuses = [];

    for (let request = 0; request < 11; request += 1) {
      const response = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/extract`, {
        method: 'POST',
        headers,
      });
      statuses.push(response.status);
    }

    assert.equal(statuses.at(-1), 429);
  });
});
