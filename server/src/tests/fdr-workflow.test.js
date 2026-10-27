import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
import Institution from '../models/Institution.js';
import ReleaseRequest from '../models/ReleaseRequest.js';
import User from '../models/User.js';
import { storeUploadedDocument } from '../services/document-storage.service.js';

const jwtSecret = 'synthetic-phase-eight-jwt-secret-with-32-characters';

const createServer = async (context) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const queryFor = (value) => ({
  select() { return this; },
  populate() { return this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  session() { return this; },
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

const makeInstitution = () => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'Synthetic Review University',
  institutionCode: 'SYN-REV-8',
  status: 'active',
});

const makeUser = (role, institution) => ({
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Synthetic Phase Eight User',
  email: 'phase-eight@example.test',
  role,
  isActive: true,
  institution: institution?._id || null,
});

const makeFdr = (institution, overrides = {}) => new FDR({
  _id: new mongoose.Types.ObjectId(),
  institution: institution._id,
  fdrNumber: `SYN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  bankName: 'Synthetic Bank',
  branch: 'Synthetic Branch',
  amount: 125000,
  currency: 'INR',
  issueDate: new Date('2026-01-01T00:00:00Z'),
  maturityDate: new Date('2027-01-01T00:00:00Z'),
  workflowStatus: 'submitted',
  financialStatus: 'active',
  submittedAt: new Date('2026-01-02T00:00:00Z'),
  documentMetadata: {
    storageRef: null,
    fileName: 'synthetic.pdf',
    mimeType: 'application/pdf',
    fileSize: 10,
    checksum: 'a'.repeat(64),
    uploadedAt: new Date('2026-01-02T00:00:00Z'),
  },
  ...overrides,
});

const authHeaders = (context, user) => {
  process.env.JWT_SECRET = jwtSecret;
  context.mock.method(User, 'findById', () => queryFor(user));
  const token = jwt.sign({}, jwtSecret, {
    algorithm: 'HS256',
    subject: String(user._id),
    expiresIn: '10m',
  });
  return { authorization: `Bearer ${token}` };
};

const mockSession = (context) => context.mock.method(mongoose, 'startSession', async () => ({
  withTransaction: async (callback) => callback(),
  endSession: async () => {},
}));

const captureAudit = (context) => {
  const events = [];
  context.mock.method(AuditLog.prototype, 'save', async function () {
    await this.validate();
    events.push(this);
    return this;
  });
  return events;
};

const makePdf = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
};

const storePdf = async () => {
  const buffer = await makePdf();
  return storeUploadedDocument({
    buffer,
    originalname: 'replacement.pdf',
    mimetype: 'application/pdf',
  });
};

test('Phase 8 review, renewal, and release workflows', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  const previousStorage = process.env.FDR_STORAGE_DIR;
  const storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'synthetic-fdr-phase-eight-'));
  process.env.FDR_STORAGE_DIR = storageDirectory;
  context.after(async () => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousStorage === undefined) delete process.env.FDR_STORAGE_DIR;
    else process.env.FDR_STORAGE_DIR = previousStorage;
    await rm(storageDirectory, { recursive: true, force: true });
  });

  const baseUrl = await createServer(context);
  const institution = makeInstitution();

  await context.test('admin review queue validates filters and searches safe institution/FDR summaries', async (subtest) => {
    const reviewer = makeUser('reviewer');
    const fdr = makeFdr(institution);
    const record = {
      ...fdr.toObject(),
      institution: { _id: institution._id, name: institution.name, institutionCode: institution.institutionCode },
    };
    subtest.mock.method(Institution, 'find', () => queryFor([institution]));
    subtest.mock.method(FDR, 'countDocuments', async (filter) => {
      assert.equal(filter.workflowStatus, 'submitted');
      assert.equal(filter.$or[0].fdrNumber instanceof RegExp, true);
      return 1;
    });
    subtest.mock.method(FDR, 'find', () => queryFor([record]));
    const response = await fetch(`${baseUrl}/api/admin/fdrs/review-queue?page=1&limit=10&workflowStatus=submitted&search=SYN`, {
      headers: authHeaders(subtest, reviewer),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].institution.institutionCode, institution.institutionCode);
    assert.equal(Object.hasOwn(body.records[0], 'documentMetadata'), false);
    assert.equal(Object.hasOwn(body.records[0], 'storageRef'), false);

    const invalid = await fetch(`${baseUrl}/api/admin/fdrs/review-queue?limit=500`, {
      headers: authHeaders(subtest, reviewer),
    });
    assert.equal(invalid.status, 400);
  });

  await context.test('review details consolidate OCR, forensics, history, replacement and release summaries', async (subtest) => {
    const admin = makeUser('aicte_admin');
    const fdr = makeFdr(institution, {
      documentMetadata: { storageRef: 'synthetic-private-key.pdf' },
      ocrResult: {
        status: 'completed',
        extractedData: { fdr_number: 'SYNTH' },
        comparisonResults: { fdr_number: { status: 'match' } },
      },
      reviewHistory: [{
        _id: new mongoose.Types.ObjectId(),
        actor: new mongoose.Types.ObjectId(),
        actorRole: 'reviewer',
        decision: 'request_correction',
        reason: 'Correct the branch details.',
        previousStatus: 'submitted',
        nextStatus: 'correction_requested',
        timestamp: new Date(),
      }],
    });
    const forensic = {
      _id: new mongoose.Types.ObjectId(),
      checksum: 'b'.repeat(64),
      engine: 'local-document-forensics',
      analysisVersion: '1.0.0',
      status: 'review_recommended',
      findings: [{ code: 'metadata_weak', severity: 'low' }],
      analyzedAt: new Date(),
    };
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    subtest.mock.method(ForensicAnalysis, 'findOne', () => queryFor(forensic));
    subtest.mock.method(FDR, 'find', () => queryFor([]));
    subtest.mock.method(ReleaseRequest, 'find', () => queryFor([]));
    subtest.mock.method(User, 'find', () => queryFor([{ _id: fdr.reviewHistory[0].actor, fullName: 'Synthetic Reviewer', role: 'reviewer' }]));

    const response = await fetch(`${baseUrl}/api/admin/fdrs/${fdr._id}/review`, {
      headers: authHeaders(subtest, admin),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.fdr.ocr.extractedFields.fdr_number, 'SYNTH');
    assert.equal(body.fdr.ocr.comparisons.fdr_number.status, 'match');
    assert.equal(body.fdr.forensic.status, 'review_recommended');
    assert.equal(body.fdr.document.downloadEndpoint, `/api/fdrs/${fdr._id}/document`);
    assert.equal(body.fdr.reviewHistory[0].actor.fullName, 'Synthetic Reviewer');
    assert.equal(Object.hasOwn(body.fdr.document, 'storageRef'), false);
    assert.equal(JSON.stringify(body).includes('synthetic-private-key.pdf'), false);
  });

  await context.test('institution users are denied administrative review reads and decisions', async (subtest) => {
    const institutionUser = makeUser('institution_user', institution);
    const fdr = makeFdr(institution);
    const headers = authHeaders(subtest, institutionUser);
    assert.equal((await fetch(`${baseUrl}/api/admin/fdrs/review-queue`, { headers })).status, 403);
    const response = await fetch(`${baseUrl}/api/admin/fdrs/${fdr._id}/review`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject_submission', reason: 'No' }),
    });
    assert.equal(response.status, 403);
  });

  await context.test('review decisions preserve history and audit, and correction resubmission transitions correctly', async (subtest) => {
    const reviewer = makeUser('reviewer');
    const fdr = makeFdr(institution, { workflowStatus: 'under_review' });
    mockSession(subtest);
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    subtest.mock.method(FDR.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    const events = captureAudit(subtest);
    const response = await fetch(`${baseUrl}/api/admin/fdrs/${fdr._id}/review`, {
      method: 'POST',
      headers: { ...authHeaders(subtest, reviewer), 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'request_correction', reason: 'Please correct the branch information.' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.fdr.workflowStatus, 'correction_requested');
    assert.equal(fdr.reviewHistory.length, 1);
    assert.equal(events[0].action, 'fdr_review_decided');
    assert.equal(events[0].metadata.previousStatus, 'under_review');
    assert.equal(events[0].metadata.nextStatus, 'correction_requested');

    subtest.mock.restoreAll();
    const institutionUser = makeUser('institution_user', institution);
    const resubmitted = makeFdr(institution, {
      workflowStatus: 'correction_requested',
      reviewHistory: fdr.reviewHistory,
    });
    mockSession(subtest);
    subtest.mock.method(FDR, 'findById', () => queryFor(resubmitted));
    subtest.mock.method(FDR.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    captureAudit(subtest);
    const invalidResubmit = await fetch(`${baseUrl}/api/fdrs/${resubmitted._id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(subtest, institutionUser), 'content-type': 'application/json' },
      body: JSON.stringify({ bankName: 'Updated Synthetic Bank' }),
    });
    assert.equal(invalidResubmit.status, 409);

    const validResubmit = await fetch(`${baseUrl}/api/fdrs/${resubmitted._id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(subtest, institutionUser), 'content-type': 'application/json' },
      body: JSON.stringify({ bankName: 'Updated Synthetic Bank', workflowStatus: 'submitted' }),
    });
    assert.equal(validResubmit.status, 200);
    assert.equal(resubmitted.workflowStatus, 'submitted');
    assert.equal(resubmitted.reviewHistory.at(-1).decision, 'resubmit');
  });

  await context.test('rejects invalid review decisions and conflicting workflow transitions', async (subtest) => {
    const admin = makeUser('aicte_admin');
    const fdr = makeFdr(institution, { workflowStatus: 'released' });
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    mockSession(subtest);
    const headers = authHeaders(subtest, admin);
    const invalidDecision = await fetch(`${baseUrl}/api/admin/fdrs/${fdr._id}/review`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reason: 'Invalid decision.' }),
    });
    assert.equal(invalidDecision.status, 400);
    const conflict = await fetch(`${baseUrl}/api/admin/fdrs/${fdr._id}/review`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'complete_review', reason: 'Complete review.' }),
    });
    assert.equal(conflict.status, 409);

    subtest.mock.restoreAll();
    const reviewableFdr = makeFdr(institution, { workflowStatus: 'under_review' });
    mockSession(subtest);
    subtest.mock.method(FDR, 'findById', () => queryFor(reviewableFdr));
    subtest.mock.method(FDR.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    captureAudit(subtest);
    const completed = await fetch(`${baseUrl}/api/admin/fdrs/${reviewableFdr._id}/review`, {
      method: 'POST',
      headers: { ...authHeaders(subtest, admin), 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'complete_review', reason: 'Administrative scrutiny completed.' }),
    });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).fdr.workflowStatus, 'review_completed');
    assert.equal(reviewableFdr.reviewerConfirmedDetails && Object.keys(reviewableFdr.reviewerConfirmedDetails).length, 0);
  });

  await context.test('renewal creates a linked instrument with a private document without overwriting the original', async (subtest) => {
    const institutionUser = makeUser('institution_admin', institution);
    const original = makeFdr(institution, { workflowStatus: 'approved' });
    const document = await storePdf();
    subtest.mock.method(FDR, 'findById', () => queryFor(original));
    subtest.mock.method(FDR, 'findOne', () => queryFor(null));
    mockSession(subtest);
    let created;
    subtest.mock.method(FDR.prototype, 'save', async function () {
      await this.validate();
      created = this;
      return this;
    });
    const events = captureAudit(subtest);
    const form = new FormData();
    for (const [field, value] of Object.entries({
      fdrNumber: 'SYN-REPLACEMENT-88',
      bankName: 'Synthetic Replacement Bank',
      branch: 'Replacement Branch',
      amount: '130000',
      currency: 'INR',
      issueDate: '2026-02-01',
      maturityDate: '2027-02-01',
    })) form.append(field, value);
    const pdfBytes = await import('node:fs/promises').then(({ readFile }) => readFile(path.join(storageDirectory, document.storageKey)));
    form.append('document', new Blob([pdfBytes], { type: 'application/pdf' }), 'replacement.pdf');

    const response = await fetch(`${baseUrl}/api/fdrs/${original._id}/renewal`, {
      method: 'POST',
      headers: authHeaders(subtest, institutionUser),
      body: form,
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.replacement.fdrNumber, 'SYN-REPLACEMENT-88');
    assert.equal(body.replacement.workflowStatus, 'submitted');
    assert.equal(created.replacesFdr.toString(), original._id.toString());
    assert.equal(created.documentMetadata.checksum.length, 64);
    assert.equal(original.fdrNumber, body.original.fdrNumber);
    assert.equal(original.workflowStatus, 'approved');
    assert.equal(events[0].action, 'fdr_replacement_submitted');

    subtest.mock.restoreAll();
    mockSession(subtest);
    subtest.mock.method(FDR, 'findById', () => queryFor(original));
    subtest.mock.method(FDR, 'findOne', () => queryFor(created));
    subtest.mock.method(FDR.prototype, 'save', async () => assert.fail('Duplicate replacement must not be saved.'));
    const duplicateForm = new FormData();
    for (const [field, value] of Object.entries({
      fdrNumber: 'SYN-REPLACEMENT-89',
      bankName: 'Synthetic Replacement Bank',
      branch: 'Replacement Branch',
      amount: '130000',
      currency: 'INR',
      issueDate: '2026-02-01',
      maturityDate: '2027-02-01',
    })) duplicateForm.append(field, value);
    const existingBytes = await import('node:fs/promises').then(({ readFile }) =>
      readFile(path.join(storageDirectory, created.documentMetadata.storageRef)));
    duplicateForm.append('document', new Blob([existingBytes], { type: 'application/pdf' }), 'replacement.pdf');
    const duplicate = await fetch(`${baseUrl}/api/fdrs/${original._id}/renewal`, {
      method: 'POST',
      headers: authHeaders(subtest, institutionUser),
      body: duplicateForm,
    });
    assert.equal(duplicate.status, 409);
  });

  await context.test('rejects unauthorized and invalid replacement submissions', async (subtest) => {
    const reviewer = makeUser('reviewer');
    const original = makeFdr(institution);
    subtest.mock.method(FDR, 'findById', () => queryFor(original));
    const denied = await fetch(`${baseUrl}/api/fdrs/${original._id}/renewal`, {
      method: 'POST',
      headers: authHeaders(subtest, reviewer),
    });
    assert.equal(denied.status, 403);

    subtest.mock.restoreAll();
    const otherInstitution = makeInstitution();
    const user = makeUser('institution_user', institution);
    const foreign = makeFdr(otherInstitution);
    subtest.mock.method(FDR, 'findById', () => queryFor(foreign));
    const validForm = new FormData();
    for (const [field, value] of Object.entries({
      fdrNumber: 'SYN-CROSS-RENEWAL',
      bankName: 'Synthetic Bank',
      branch: 'Synthetic Branch',
      amount: '10000',
      issueDate: '2026-01-01',
      maturityDate: '2027-01-01',
    })) validForm.append(field, value);
    validForm.append('document', new Blob([await makePdf()], { type: 'application/pdf' }), 'renewal.pdf');
    const crossInstitution = await fetch(`${baseUrl}/api/fdrs/${foreign._id}/renewal`, {
      method: 'POST',
      headers: authHeaders(subtest, user),
      body: validForm,
    });
    assert.equal(crossInstitution.status, 403);

    subtest.mock.restoreAll();
    subtest.mock.method(FDR, 'findById', () => queryFor(original));
    const invalidFields = new FormData();
    invalidFields.append('fdrNumber', 'x');
    invalidFields.append('bankName', 'b');
    invalidFields.append('branch', 'b');
    invalidFields.append('amount', '0');
    invalidFields.append('issueDate', '2026-01-01');
    invalidFields.append('maturityDate', '2025-01-01');
    invalidFields.append('document', new Blob(['not a PDF'], { type: 'text/plain' }), 'invalid.txt');
    const invalid = await fetch(`${baseUrl}/api/fdrs/${original._id}/renewal`, {
      method: 'POST',
      headers: authHeaders(subtest, user),
      body: invalidFields,
    });
    assert.equal(invalid.status, 400);

    const validFields = new FormData();
    for (const [field, value] of Object.entries({
      fdrNumber: 'SYN-INVALID-DOCUMENT',
      bankName: 'Synthetic Bank',
      branch: 'Synthetic Branch',
      amount: '10000',
      issueDate: '2026-01-01',
      maturityDate: '2027-01-01',
    })) validFields.append(field, value);
    validFields.append('document', new Blob(['not a supported document'], { type: 'text/plain' }), 'invalid.txt');
    const invalidDocument = await fetch(`${baseUrl}/api/fdrs/${original._id}/renewal`, {
      method: 'POST',
      headers: authHeaders(subtest, user),
      body: validFields,
    });
    assert.equal(invalidDocument.status, 400);
  });

  await context.test('submits release requests, prevents duplicates, preserves resubmission and decisions', async (subtest) => {
    const institutionUser = makeUser('institution_user', institution);
    const fdr = makeFdr(institution, { workflowStatus: 'review_completed' });
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    subtest.mock.method(ReleaseRequest, 'findOne', () => queryFor(null));
    mockSession(subtest);
    subtest.mock.method(ReleaseRequest.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    const events = captureAudit(subtest);
    const submitted = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/release-requests`, {
      method: 'POST',
      headers: { ...authHeaders(subtest, institutionUser), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'The security deposit has reached its eligible end date.' }),
    });
    assert.equal(submitted.status, 201);
    assert.equal(events[0].action, 'fdr_release_request_submitted');

    subtest.mock.restoreAll();
    const request = new ReleaseRequest({
      _id: new mongoose.Types.ObjectId(),
      fdrId: fdr._id,
      institution: institution._id,
      requestedBy: institutionUser._id,
      reason: 'Initial synthetic release request.',
      status: 'submitted',
      active: true,
      history: [],
    });
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    subtest.mock.method(ReleaseRequest, 'findOne', () => queryFor(request));
    mockSession(subtest);
    const duplicate = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/release-requests`, {
      method: 'POST',
      headers: { ...authHeaders(subtest, institutionUser), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'A second competing release request is not allowed.' }),
    });
    assert.equal(duplicate.status, 409);

    subtest.mock.restoreAll();
    request.status = 'information_requested';
    request.active = true;
    request.history.push({
      actor: new mongoose.Types.ObjectId(),
      actorRole: 'reviewer',
      decision: 'request_information',
      reason: 'Please provide additional details.',
      previousStatus: 'submitted',
      nextStatus: 'information_requested',
      timestamp: new Date(),
    });
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    subtest.mock.method(ReleaseRequest, 'findOne', () => queryFor(request));
    mockSession(subtest);
    subtest.mock.method(ReleaseRequest.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    captureAudit(subtest);
    const resubmitted = await fetch(`${baseUrl}/api/fdrs/${fdr._id}/release-requests`, {
      method: 'POST',
      headers: { ...authHeaders(subtest, institutionUser), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'The requested additional information is attached to this resubmission.' }),
    });
    const resubmittedBody = await resubmitted.json();
    assert.equal(resubmitted.status, 201);
    assert.equal(resubmittedBody.request.history.at(-1).decision, 'resubmit_request');
    assert.equal(request.history.length, 2);

    subtest.mock.restoreAll();
    const admin = makeUser('aicte_admin');
    const headers = authHeaders(subtest, admin);
    subtest.mock.method(ReleaseRequest, 'findById', () => queryFor(request));
    mockSession(subtest);
    const noReason = await fetch(`${baseUrl}/api/admin/release-requests/${request._id}/decision`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve_request', reason: 'x' }),
    });
    assert.equal(noReason.status, 400);

    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    subtest.mock.method(ReleaseRequest.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    const finalEvents = captureAudit(subtest);
    const decision = await fetch(`${baseUrl}/api/admin/release-requests/${request._id}/decision`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve_request', reason: 'Administrative review is complete.' }),
    });
    const decisionBody = await decision.json();
    assert.equal(decision.status, 200);
    assert.equal(decisionBody.request.status, 'approved');
    assert.equal(decisionBody.request.history.length, 3);
    assert.equal(request.active, false);
    assert.equal(finalEvents.at(-1).action, 'fdr_release_request_decided');
    assert.equal(fdr.workflowStatus, 'review_completed');
    assert.equal(fdr.financialStatus, 'active');
  });

  await context.test('blocks approval while FDR administrative review remains incomplete', async (subtest) => {
    const admin = makeUser('reviewer');
    const fdr = makeFdr(institution, { workflowStatus: 'submitted', financialStatus: 'active' });
    const request = new ReleaseRequest({
      fdrId: fdr._id,
      institution: institution._id,
      requestedBy: new mongoose.Types.ObjectId(),
      reason: 'Synthetic release request reason.',
      status: 'submitted',
      active: true,
    });
    subtest.mock.method(ReleaseRequest, 'findById', () => queryFor(request));
    subtest.mock.method(FDR, 'findById', () => queryFor(fdr));
    mockSession(subtest);
    const response = await fetch(`${baseUrl}/api/admin/release-requests/${request._id}/decision`, {
      method: 'POST',
      headers: { ...authHeaders(subtest, admin), 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve_request', reason: 'Administrative release review.' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'release_not_eligible');
  });
});
