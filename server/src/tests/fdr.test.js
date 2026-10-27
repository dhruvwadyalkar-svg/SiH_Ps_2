import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app.js';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import User from '../models/User.js';

const jwtSecret = 'synthetic-phase-five-jwt-secret-with-32-characters';
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>\nendobj\n%%EOF');

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
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  session() {
    return this;
  },
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

const makeInstitution = () => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'Synthetic FDR Institution',
  institutionCode: `FDR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  status: 'pending',
});

const makeUser = (role, institution) => ({
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Synthetic FDR User',
  email: 'fdr.user@example.test',
  role,
  isActive: true,
  institution: institution?._id || null,
});

const authHeaders = (context, user) => {
  process.env.JWT_SECRET = jwtSecret;
  context.mock.method(User, 'findById', () => queryFor(user));
  const token = jwt.sign(
    { role: 'aicte_admin' },
    jwtSecret,
    { algorithm: 'HS256', subject: String(user._id), expiresIn: '10m' },
  );
  return { authorization: `Bearer ${token}` };
};

const makeForm = (fields, file = pdfBytes, fileName = 'synthetic-statement.pdf', mimeType = 'application/pdf') => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  if (file) {
    form.append('document', new Blob([file], { type: mimeType }), fileName);
  }
  return form;
};

const validFields = () => ({
  fdrNumber: `SYN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  bankName: 'Synthetic Bank',
  branch: 'Synthetic Branch',
  amount: '250000',
  currency: 'inr',
  issueDate: '2026-01-01',
  maturityDate: '2027-01-01',
});

const makeFdr = ({ institutionId, workflowStatus = 'submitted', storageRef = null } = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  institution: institutionId || new mongoose.Types.ObjectId(),
  fdrNumber: 'SYN-FDR-001',
  bankName: 'Synthetic Bank',
  branch: 'Synthetic Branch',
  amount: 250000,
  currency: 'INR',
  issueDate: new Date('2026-01-01T00:00:00.000Z'),
  maturityDate: new Date('2027-01-01T00:00:00.000Z'),
  workflowStatus,
  financialStatus: 'active',
  documentMetadata: {
    storageRef,
    fileName: 'synthetic-statement.pdf',
    mimeType: 'application/pdf',
    fileSize: pdfBytes.length,
    checksum: 'a'.repeat(64),
    uploadedAt: new Date('2026-01-02T00:00:00.000Z'),
  },
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  async save() {
    return this;
  },
});

const makeSession = (context) => {
  context.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }));
};

test('Phase 5 FDR routes and private documents', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  const previousStorage = process.env.FDR_STORAGE_DIR;
  const previousMaxBytes = process.env.FDR_MAX_UPLOAD_BYTES;
  const storagePath = await mkdtemp(path.join(os.tmpdir(), 'synthetic-fdr-'));
  process.env.FDR_STORAGE_DIR = storagePath;
  delete process.env.FDR_MAX_UPLOAD_BYTES;
  context.after(async () => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousStorage === undefined) delete process.env.FDR_STORAGE_DIR;
    else process.env.FDR_STORAGE_DIR = previousStorage;
    if (previousMaxBytes === undefined) delete process.env.FDR_MAX_UPLOAD_BYTES;
    else process.env.FDR_MAX_UPLOAD_BYTES = previousMaxBytes;
    await rm(storagePath, { recursive: true, force: true });
  });

  await context.test('mounts the plural collection route and requires authentication', async (subtest) => {
    const baseUrl = await createServer(subtest);
    assert.equal((await fetch(`${baseUrl}/api/fdrs`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/fdr`)).status, 404);
  });

  await context.test('creates an owned FDR, stores only file metadata, and audits creation plus upload', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const auditEvents = [];
    let createdRecord;
    makeSession(subtest);
    subtest.mock.method(Institution, 'findById', async (id) => {
      assert.equal(String(id), String(institution._id));
      return institution;
    });
    subtest.mock.method(FDR.prototype, 'save', async function () {
      await this.validate();
      this.createdAt = new Date();
      this.updatedAt = this.createdAt;
      createdRecord = this;
      return this;
    });
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      auditEvents.push(this);
      return this;
    });

    const response = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers: authHeaders(subtest, user),
      body: makeForm(validFields()),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.fdr.institution, String(institution._id));
    assert.equal(body.fdr.workflowStatus, 'submitted');
    assert.equal(body.fdr.currency, 'INR');
    assert.equal(body.fdr.documentMetadata.checksum.length, 64);
    assert.equal(Object.hasOwn(body.fdr.documentMetadata, 'storageRef'), false);
    assert.equal(JSON.stringify(body).includes(storagePath), false);
    assert.equal(String(createdRecord.institution), String(institution._id));
    assert.equal(createdRecord.documentMetadata.storageRef.includes(path.sep), false);
    assert.deepEqual(auditEvents.map(({ action }) => action), ['fdr_created', 'fdr_document_uploaded']);
    assert.equal(auditEvents.every(({ actor }) => String(actor) === String(user._id)), true);
  });

  await context.test('rejects spoofed institution fields, invalid amounts, and invalid maturity dates', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const findInstitution = subtest.mock.method(Institution, 'findById', async () => institution);
    const fields = validFields();

    const spoofed = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers: authHeaders(subtest, user),
      body: makeForm({ ...fields, institution: new mongoose.Types.ObjectId() }),
    });
    assert.equal(spoofed.status, 400);
    assert.equal(findInstitution.mock.callCount(), 0);

    for (const invalidFields of [
      { ...fields, amount: '0' },
      { ...fields, amount: 'Infinity' },
      { ...fields, maturityDate: fields.issueDate },
      { ...fields, maturityDate: '2026-02-31' },
      { ...fields, maturityDate: 'not-a-date' },
    ]) {
      const response = await fetch(`${baseUrl}/api/fdrs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt.sign({}, jwtSecret, { subject: String(user._id), expiresIn: '10m' })}` },
        body: makeForm(invalidFields),
      });
      assert.equal(response.status, 400);
    }
  });

  await context.test('rejects bad signatures, unsupported types, and oversized uploads', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_admin', institution);
    subtest.mock.method(Institution, 'findById', async () => institution);
    const headers = authHeaders(subtest, user);
    const fields = validFields();

    const badSignature = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers,
      body: makeForm(fields, Buffer.from('not a PDF'), 'fake.pdf'),
    });
    assert.equal(badSignature.status, 400);

    const unsupported = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers,
      body: makeForm(fields, Buffer.from('text file'), 'document.txt', 'text/plain'),
    });
    assert.equal(unsupported.status, 400);

    const oversized = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers,
      body: makeForm(fields, Buffer.alloc(10 * 1024 * 1024 + 1, 0), 'large.pdf'),
    });
    assert.equal(oversized.status, 413);
  });

  await context.test('lists with tenant scoping, pagination, search, and status filters', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const fdr = makeFdr({ institutionId: institution._id });
    subtest.mock.method(FDR, 'countDocuments', async () => 1);
    const find = subtest.mock.method(FDR, 'find', () => queryFor([fdr]));

    const response = await fetch(
      `${baseUrl}/api/fdrs?page=2&limit=5&search=SYN&workflowStatus=submitted&fromDate=2026-01-01&toDate=2027-01-01`,
      { headers: authHeaders(subtest, user) },
    );
    const body = await response.json();
    const filter = find.mock.calls[0].arguments[0];
    assert.equal(response.status, 200);
    assert.equal(filter.institution, String(institution._id));
    assert.equal(filter.workflowStatus, 'submitted');
    assert.equal(filter.$or[0].fdrNumber.test('SYN-FDR-001'), true);
    assert.equal(body.pagination.page, 2);
    assert.equal(body.pagination.limit, 5);
    assert.equal(body.fdrs.length, 1);

    const invalidRange = await fetch(`${baseUrl}/api/fdrs?fromDate=2027-01-01&toDate=2026-01-01`, {
      headers: { authorization: `Bearer ${jwt.sign({}, jwtSecret, { subject: String(user._id), expiresIn: '10m' })}` },
    });
    assert.equal(invalidRange.status, 400);
  });

  await context.test('lets officials list across institutions and denies cross-institution record access', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const official = makeUser('reviewer');
    const record = makeFdr();
    const find = subtest.mock.method(FDR, 'find', () => queryFor([record]));
    subtest.mock.method(FDR, 'countDocuments', async () => 1);
    const headers = authHeaders(subtest, official);
    const listed = await fetch(`${baseUrl}/api/fdrs`, { headers });
    assert.equal(listed.status, 200);
    assert.equal(find.mock.calls[0].arguments[0].institution, undefined);
    const forbiddenUpdate = await fetch(`${baseUrl}/api/fdrs/${record._id}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ bankName: 'Unauthorized Update' }),
    });
    assert.equal(forbiddenUpdate.status, 403);

    subtest.mock.restoreAll();
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    subtest.mock.method(FDR, 'findById', () => queryFor(record));
    const denied = await fetch(`${baseUrl}/api/fdrs/${record._id}`, {
      headers: authHeaders(subtest, user),
    });
    assert.equal(denied.status, 403);
  });

  await context.test('rejects invalid IDs and removes a stored file when database persistence fails', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const headers = authHeaders(subtest, user);
    subtest.mock.method(FDR, 'findById', () => queryFor(null));
    const invalidId = await fetch(`${baseUrl}/api/fdrs/not-an-object-id`, { headers });
    assert.equal(invalidId.status, 400);

    const before = await readdir(storagePath);
    makeSession(subtest);
    subtest.mock.method(Institution, 'findById', async () => institution);
    subtest.mock.method(FDR.prototype, 'save', async () => {
      throw new Error('Synthetic database persistence failure.');
    });
    const failedCreate = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers,
      body: makeForm(validFields()),
    });
    assert.equal(failedCreate.status, 500);
    assert.deepEqual(await failedCreate.json(), { error: 'Internal server error.' });
    assert.deepEqual(await readdir(storagePath), before);

    subtest.mock.restoreAll();
    authHeaders(subtest, user);
    makeSession(subtest);
    subtest.mock.method(Institution, 'findById', async () => institution);
    subtest.mock.method(FDR.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    subtest.mock.method(AuditLog.prototype, 'save', async () => {
      throw new Error('Synthetic audit persistence failure.');
    });
    const failedAudit = await fetch(`${baseUrl}/api/fdrs`, {
      method: 'POST',
      headers,
      body: makeForm(validFields()),
    });
    assert.equal(failedAudit.status, 500);
    assert.deepEqual(await failedAudit.json(), { error: 'Internal server error.' });
    assert.deepEqual(await readdir(storagePath), before);
  });

  await context.test('retrieves an owned record and restricts updates to editable workflow states and fields', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_admin', institution);
    const record = makeFdr({ institutionId: institution._id, workflowStatus: 'draft' });
    const auditEvents = [];
    subtest.mock.method(FDR, 'findById', () => queryFor(record));
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      auditEvents.push(this);
      return this;
    });

    const headers = authHeaders(subtest, user);
    const retrieved = await fetch(`${baseUrl}/api/fdrs/${record._id}`, { headers });
    assert.equal(retrieved.status, 200);
    assert.equal((await retrieved.json()).fdr.fdrNumber, record.fdrNumber);

    makeSession(subtest);
    const updated = await fetch(`${baseUrl}/api/fdrs/${record._id}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ bankName: 'Updated Synthetic Bank', workflowStatus: 'submitted' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(record.bankName, 'Updated Synthetic Bank');
    assert.equal(record.workflowStatus, 'submitted');
    assert.equal(auditEvents[0].action, 'fdr_metadata_updated');

    const locked = await fetch(`${baseUrl}/api/fdrs/${record._id}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ bankName: 'Another Synthetic Bank' }),
    });
    assert.equal(locked.status, 409);

    const forbidden = await fetch(`${baseUrl}/api/fdrs/${record._id}`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ financialStatus: 'released' }),
    });
    assert.equal(forbidden.status, 400);
  });

  await context.test('downloads only authorized existing documents and persists download audit events', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const { storeUploadedDocument } = await import('../services/document-storage.service.js');
    const stored = await storeUploadedDocument({
      buffer: pdfBytes,
      originalname: 'synthetic-statement.pdf',
      mimetype: 'application/pdf',
    });
    const record = makeFdr({
      institutionId: institution._id,
      storageRef: stored.storageKey,
    });
    const auditEvents = [];
    subtest.mock.method(FDR, 'findById', () => queryFor(record));
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      auditEvents.push(this);
      return this;
    });

    const response = await fetch(`${baseUrl}/api/fdrs/${record._id}/document`, {
      headers: authHeaders(subtest, user),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);
    assert.equal(auditEvents[0].action, 'fdr_document_downloaded');

    const missingRecord = makeFdr({
      institutionId: institution._id,
      storageRef: '3d6fd79c-dcb7-4e31-9a7d-16a0fcbec65a.pdf',
    });
    subtest.mock.restoreAll();
    subtest.mock.method(FDR, 'findById', () => queryFor(missingRecord));
    const missing = await fetch(`${baseUrl}/api/fdrs/${missingRecord._id}/document`, {
      headers: authHeaders(subtest, user),
    });
    assert.equal(missing.status, 404);

    const unauthorizedUser = makeUser('institution_user', makeInstitution());
    const unauthorized = await fetch(`${baseUrl}/api/fdrs/${record._id}/document`, {
      headers: authHeaders(subtest, unauthorizedUser),
    });
    assert.equal(unauthorized.status, 403);
  });
});
