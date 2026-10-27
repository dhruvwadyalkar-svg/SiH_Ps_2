import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import test from 'node:test';

dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: true, quiet: true });

const testUri = process.env.MONGODB_TEST_URI;
if (!testUri) {
  throw new Error('MONGODB_TEST_URI is required in server/.env.test; no database was accessed.');
}

const databaseMatch = testUri.match(/@[^/]+\/([^/?]+)(?:\?|$)/);
if (!databaseMatch || decodeURIComponent(databaseMatch[1]) !== 'aicte_fdr_portal_test') {
  throw new Error('MONGODB_TEST_URI must target the dedicated aicte_fdr_portal_test database.');
}
if (!process.env.JWT_TEST_SECRET || process.env.JWT_TEST_SECRET.length < 32) {
  throw new Error('JWT_TEST_SECRET must be set to a test-only value of at least 32 characters.');
}

process.env.MONGODB_URI = testUri;
process.env.JWT_SECRET = process.env.JWT_TEST_SECRET;
process.env.NODE_ENV = 'test';
process.env.SARVAM_TEST_MODE = 'true';
process.env.MATURITY_REMINDERS_ENABLED = 'false';
process.env.FDR_MAX_UPLOAD_BYTES = process.env.FDR_MAX_UPLOAD_BYTES || '1048576';
delete process.env.SARVAM_API_KEY;

const storagePath = await mkdtemp(path.join(os.tmpdir(), 'aicte-phase11-e2e-'));
process.env.FDR_STORAGE_DIR = storagePath;

const [{ default: mongoose }, { default: bcrypt }, { PDFDocument }, { default: app }, models, { getMaturityReminderConfig }, { deleteStoredDocument }] =
  await Promise.all([
    import('mongoose'),
    import('bcryptjs'),
    import('pdf-lib'),
    import('../src/app.js'),
    Promise.all([
      import('../src/models/AuditLog.js'),
      import('../src/models/FDR.js'),
      import('../src/models/ForensicAnalysis.js'),
      import('../src/models/Institution.js'),
      import('../src/models/Notification.js'),
      import('../src/models/ReleaseRequest.js'),
      import('../src/models/User.js'),
    ]),
    import('../src/jobs/maturity-reminder.job.js'),
    import('../src/services/document-storage.service.js'),
  ]);

const [AuditLog, FDR, ForensicAnalysis, Institution, Notification, ReleaseRequest, User] = models.map(({ default: model }) => model);

const request = async (baseUrl, route, { token, method = 'GET', body, form } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, data };
};

const login = async (baseUrl, email, password) => {
  const result = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.tokenType, 'Bearer');
  return result.data.accessToken;
};

const makePdf = async () => {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  return Buffer.from(await document.save());
};

const makeFdrForm = ({ fdrNumber, document }) => {
  const form = new FormData();
  Object.entries({
    fdrNumber,
    bankName: 'Synthetic Test Bank',
    branch: 'Synthetic Test Branch',
    amount: '250000',
    currency: 'INR',
    issueDate: '2026-01-01',
    maturityDate: '2027-01-01',
  }).forEach(([key, value]) => form.append(key, value));
  form.append('document', new Blob([document], { type: 'application/pdf' }), 'synthetic-e2e.pdf');
  return form;
};

test('Phase 11 real HTTP integration against isolated MongoDB', { timeout: 120_000 }, async (context) => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
  const password = 'Synthetic-E2E-Password-2026!';
  const institutionIds = [];
  const userIds = [];
  const fdrIds = [];
  const releaseRequestIds = [];
  const notificationIds = [];
  let server;
  let connected = false;
  const emails = [
    `institution-a-${runId.toLowerCase()}@example.test`,
    `institution-b-${runId.toLowerCase()}@example.test`,
    `reviewer-${runId.toLowerCase()}@example.test`,
    `administrator-${runId.toLowerCase()}@example.test`,
  ];
  const institutionCodes = [`SYN-E2E-${runId}`, `SYN-B-${runId}`];

  context.after(async () => {
    try {
      if (connected) {
        const [taggedUsers, taggedInstitutions] = await Promise.all([
          User.find({ email: { $in: emails } }).select('_id').lean(),
          Institution.find({ institutionCode: { $in: institutionCodes } }).select('_id').lean(),
        ]);
        userIds.push(...taggedUsers.map(({ _id }) => _id));
        institutionIds.push(...taggedInstitutions.map(({ _id }) => _id));
        const records = institutionIds.length
          ? await FDR.find({
            institution: { $in: institutionIds },
            fdrNumber: { $in: ['SYNTHETIC-E2E-FDR', `SYNTHETIC-REPLACEMENT-${runId}`] },
          }).select('_id documentMetadata.storageRef').lean()
          : [];
        fdrIds.push(...records.map(({ _id }) => _id));
        for (const record of records) {
          if (record.documentMetadata?.storageRef) {
            await deleteStoredDocument(record.documentMetadata.storageRef);
          }
        }
        const fdrIdSet = [...new Set(fdrIds.map(String))];
        const releaseIds = new Set(releaseRequestIds.map(String));
        if (fdrIdSet.length) {
          const releaseRequests = await ReleaseRequest.find({ fdrId: { $in: fdrIds } }).select('_id').lean();
          releaseRequests.forEach(({ _id }) => releaseIds.add(String(_id)));
          await ForensicAnalysis.deleteMany({ fdrId: { $in: fdrIds } });
          await ReleaseRequest.deleteMany({ _id: { $in: [...releaseIds] } });
          await Notification.deleteMany({
            $or: [
              { _id: { $in: notificationIds } },
              { recipient: { $in: userIds }, deduplicationKey: { $regex: `^phase11:${runId}:` } },
            ],
          });
          await AuditLog.deleteMany({
            $or: [
              { entityId: { $in: fdrIds } },
              { actor: { $in: userIds } },
            ],
          });
          await FDR.deleteMany({ _id: { $in: fdrIds } });
        } else if (notificationIds.length) {
          await Notification.deleteMany({ _id: { $in: notificationIds } });
        }
        if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
        if (institutionIds.length) await Institution.deleteMany({ _id: { $in: institutionIds } });
      }
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await mongoose.disconnect();
      await rm(storagePath, { recursive: true, force: true });
    }
  });

  await mongoose.connect(testUri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 5,
    autoIndex: false,
  });
  connected = true;
  assert.equal(mongoose.connection.name, 'aicte_fdr_portal_test');
  assert.equal(getMaturityReminderConfig().enabled, false);

  const modelsToInitialize = [AuditLog, FDR, ForensicAnalysis, Institution, Notification, ReleaseRequest, User];
  await Promise.all(modelsToInitialize.map((model) => model.init()));

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const pdf = await makePdf();

  const unauthenticated = await request(baseUrl, '/api/fdrs');
  assert.equal(unauthenticated.response.status, 401);
  const invalidLogin = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'missing@example.test', password },
  });
  assert.equal(invalidLogin.response.status, 401);

  const registration = await request(baseUrl, '/api/auth/register-institution', {
    method: 'POST',
    body: {
      institution: {
        name: 'Synthetic Test Institution',
        institutionCode: `SYN-E2E-${runId}`,
        contactEmail: `contact-${runId.toLowerCase()}@example.test`,
        contactPhone: '+91-9000000000',
        address: 'Synthetic test address',
      },
      user: {
        fullName: 'Synthetic Institution A User',
        email: emails[0],
        password,
      },
    },
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.data.user.role, 'institution_user');
  assert.equal(Object.hasOwn(registration.data.user, 'passwordHash'), false);
  assert.equal(registration.data.institution.status, 'pending');

  const institutionAId = registration.data.institution.id;
  const userAId = registration.data.user.id;
  institutionIds.push(institutionAId);
  userIds.push(userAId);

  const institutionB = await Institution.create({
    name: `Synthetic Institution B ${runId}`,
    institutionCode: `SYN-B-${runId}`,
    contactEmail: `institution-b-${runId.toLowerCase()}@example.test`,
    contactPhone: '+91-9000000001',
    address: 'Synthetic institution B address',
    status: 'active',
  });
  institutionIds.push(institutionB._id);
  const passwordHash = await bcrypt.hash(password, 10);
  const userB = await User.create({
    fullName: 'Synthetic Institution B User',
    email: emails[1],
    passwordHash,
    role: 'institution_user',
    institution: institutionB._id,
    isActive: true,
  });
  userIds.push(userB._id);
  const reviewer = await User.create({
    fullName: 'Synthetic Reviewer',
    email: emails[2],
    passwordHash,
    role: 'reviewer',
    isActive: true,
  });
  userIds.push(reviewer._id);
  const administrator = await User.create({
    fullName: 'Synthetic AICTE Administrator',
    email: emails[3],
    passwordHash,
    role: 'aicte_admin',
    isActive: true,
  });
  userIds.push(administrator._id);

  const tokenA = await login(baseUrl, registration.data.user.email, password);
  const tokenB = await login(baseUrl, userB.email, password);
  const reviewerToken = await login(baseUrl, reviewer.email, password);
  const adminToken = await login(baseUrl, administrator.email, password);

  const currentUser = await request(baseUrl, '/api/auth/me', { token: tokenA });
  assert.equal(currentUser.response.status, 200);
  assert.equal(currentUser.data.user.id, userAId);
  assert.equal(currentUser.data.user.institution.id, institutionAId);

  const badSignatureForm = makeFdrForm({ fdrNumber: `BAD-${runId}`, document: Buffer.from('not a PDF') });
  const badSignature = await request(baseUrl, '/api/fdrs', { token: tokenA, method: 'POST', form: badSignatureForm });
  assert.equal(badSignature.response.status, 400);

  const oversizedForm = makeFdrForm({
    fdrNumber: `BIG-${runId}`,
    document: Buffer.alloc(Number(process.env.FDR_MAX_UPLOAD_BYTES) + 1),
  });
  const oversized = await request(baseUrl, '/api/fdrs', { token: tokenA, method: 'POST', form: oversizedForm });
  assert.equal(oversized.response.status, 413);

  const created = await request(baseUrl, '/api/fdrs', {
    token: tokenA,
    method: 'POST',
    form: makeFdrForm({ fdrNumber: 'SYNTHETIC-E2E-FDR', document: pdf }),
  });
  assert.equal(created.response.status, 201);
  const fdrId = created.data.fdr.id;
  fdrIds.push(fdrId);
  assert.equal(created.data.fdr.institution, institutionAId);
  assert.equal(created.data.fdr.fdrNumber, 'SYNTHETIC-E2E-FDR');
  assert.equal(JSON.stringify(created.data).includes(storagePath), false);
  assert.equal(Object.hasOwn(created.data.fdr.documentMetadata, 'storageRef'), false);

  const page = await request(baseUrl, '/api/fdrs?page=1&limit=1&search=SYNTHETIC-E2E-FDR&workflowStatus=submitted', { token: tokenA });
  assert.equal(page.response.status, 200);
  assert.equal(page.data.pagination.total, 1);
  assert.equal(page.data.fdrs[0].id, fdrId);

  const updated = await request(baseUrl, `/api/fdrs/${fdrId}`, {
    token: tokenA,
    method: 'PATCH',
    body: { branch: 'Synthetic Updated Branch' },
  });
  assert.equal(updated.response.status, 409);

  const downloaded = await request(baseUrl, `/api/fdrs/${fdrId}/document`, { token: tokenA });
  assert.equal(downloaded.response.status, 200);
  assert.deepEqual(downloaded.data, pdf);
  assert.equal(downloaded.response.headers.get('content-type'), 'application/pdf');

  const otherInstitutionRecord = await request(baseUrl, `/api/fdrs/${fdrId}`, { token: tokenB });
  const otherInstitutionDocument = await request(baseUrl, `/api/fdrs/${fdrId}/document`, { token: tokenB });
  assert.ok([403, 404].includes(otherInstitutionRecord.response.status));
  assert.ok([403, 404].includes(otherInstitutionDocument.response.status));

  const forensics = await request(baseUrl, `/api/fdrs/${fdrId}/forensics`, {
    token: tokenA,
    method: 'POST',
  });
  assert.equal(forensics.response.status, 200);
  assert.ok(['no_signals_detected', 'review_recommended', 'analysis_inconclusive'].includes(forensics.data.analysis.status));
  assert.ok(!['REAL', 'FAKE'].includes(forensics.data.analysis.status));
  assert.ok(forensics.data.analysis.limitations.length > 0);
  const forensicHistory = await request(baseUrl, `/api/fdrs/${fdrId}/forensics`, { token: tokenA });
  assert.equal(forensicHistory.response.status, 200);
  const persistedAnalysis = await ForensicAnalysis.findOne({ fdrId });
  assert.ok(persistedAnalysis);

  const extractionRequest = await request(baseUrl, `/api/fdrs/${fdrId}/extract`, {
    token: tokenA,
    method: 'POST',
  });
  assert.equal(extractionRequest.response.status, 202);
  assert.equal(extractionRequest.data.status, 'queued');
  const extraction = await request(baseUrl, `/api/fdrs/${fdrId}/extraction`, { token: tokenA });
  assert.equal(extraction.response.status, 200);
  assert.equal(extraction.data.status, 'completed');
  assert.equal(extraction.data.extractedFields.fdr_number, 'SYNTHETIC-E2E-FDR');
  const persistedFdr = await FDR.findById(fdrId);
  assert.equal(persistedFdr.fdrNumber, 'SYNTHETIC-E2E-FDR');
  assert.equal(persistedFdr.ocrResult.extractedData.fdr_number, 'SYNTHETIC-E2E-FDR');
  assert.equal(extraction.data.comparisons.fdr_number.status, 'match');

  const adminDenied = await request(baseUrl, '/api/admin/fdrs/review-queue', { token: tokenA });
  assert.equal(adminDenied.response.status, 403);
  const reviewQueue = await request(baseUrl, '/api/admin/fdrs/review-queue?search=SYNTHETIC-E2E-FDR', { token: reviewerToken });
  assert.equal(reviewQueue.response.status, 200);
  assert.ok(reviewQueue.data.records.some(({ id }) => id === fdrId));

  const forbiddenDecision = await request(baseUrl, `/api/admin/fdrs/${fdrId}/review`, {
    token: tokenA,
    method: 'POST',
    body: { decision: 'complete_review', reason: 'Must be denied.' },
  });
  assert.equal(forbiddenDecision.response.status, 403);

  const correction = await request(baseUrl, `/api/admin/fdrs/${fdrId}/review`, {
    token: reviewerToken,
    method: 'POST',
    body: { decision: 'request_correction', reason: 'Synthetic correction requested.' },
  });
  assert.equal(correction.response.status, 200);
  assert.equal(correction.data.fdr.workflowStatus, 'correction_requested');

  const resubmission = await request(baseUrl, `/api/fdrs/${fdrId}`, {
    token: tokenA,
    method: 'PATCH',
    body: { branch: 'Synthetic Corrected Branch', workflowStatus: 'submitted' },
  });
  assert.equal(resubmission.response.status, 200);

  const completedReview = await request(baseUrl, `/api/admin/fdrs/${fdrId}/review`, {
    token: reviewerToken,
    method: 'POST',
    body: { decision: 'complete_review', reason: 'Synthetic review completed.' },
  });
  assert.equal(completedReview.response.status, 200);
  assert.equal(completedReview.data.fdr.workflowStatus, 'review_completed');
  const completedReviewDetails = await request(baseUrl, `/api/admin/fdrs/${fdrId}/review`, { token: reviewerToken });
  assert.equal(completedReviewDetails.response.status, 200);
  assert.equal(completedReviewDetails.data.fdr.reviewHistory.length, 3);

  const replacement = await request(baseUrl, `/api/fdrs/${fdrId}/renewal`, {
    token: tokenA,
    method: 'POST',
    form: makeFdrForm({ fdrNumber: `SYNTHETIC-REPLACEMENT-${runId}`, document: pdf }),
  });
  assert.equal(replacement.response.status, 201);
  const replacementId = replacement.data.replacement.id;
  fdrIds.push(replacementId);
  assert.equal(String((await FDR.findById(replacementId)).replacesFdr), fdrId);
  assert.equal((await FDR.findById(fdrId)).fdrNumber, 'SYNTHETIC-E2E-FDR');

  const releaseSubmitted = await request(baseUrl, `/api/fdrs/${fdrId}/release-requests`, {
    token: tokenA,
    method: 'POST',
    body: { reason: 'Synthetic release request for workflow integration testing.' },
  });
  assert.equal(releaseSubmitted.response.status, 201);
  const releaseRequestId = releaseSubmitted.data.request.id;
  releaseRequestIds.push(releaseRequestId);
  const releaseDecision = await request(baseUrl, `/api/admin/release-requests/${releaseRequestId}/decision`, {
    token: adminToken,
    method: 'POST',
    body: { decision: 'approve_request', reason: 'Synthetic request approved for workflow testing only.' },
  });
  assert.equal(releaseDecision.response.status, 200);
  assert.equal(releaseDecision.data.request.status, 'approved');
  assert.equal((await FDR.findById(fdrId)).financialStatus, 'active');
  assert.equal(Object.hasOwn(releaseDecision.data.request, 'transferredAt'), false);

  const notification = await Notification.create({
    recipient: userAId,
    institution: institutionAId,
    fdr: fdrId,
    type: 'maturity_reminder',
    title: 'Synthetic test reminder',
    message: 'A synthetic test FDR is approaching maturity.',
    metadata: { fdrNumber: 'SYNTHETIC-E2E-FDR', reminderStage: '30d' },
    deduplicationKey: `phase11:${runId}:reminder`,
  });
  notificationIds.push(notification._id);
  const unreadCount = await request(baseUrl, '/api/notifications/unread-count', { token: tokenA });
  assert.equal(unreadCount.response.status, 200);
  assert.equal(unreadCount.data.unreadCount, 1);
  const markedRead = await request(baseUrl, `/api/notifications/${notification._id}/read`, {
    token: tokenA,
    method: 'PATCH',
  });
  assert.equal(markedRead.response.status, 200);
  const readCount = await request(baseUrl, '/api/notifications/unread-count', { token: tokenA });
  assert.equal(readCount.data.unreadCount, 0);

  const institutionDashboard = await request(baseUrl, '/api/dashboard/summary', { token: tokenA });
  const officialDashboard = await request(baseUrl, '/api/admin/dashboard/summary', { token: adminToken });
  assert.equal(institutionDashboard.response.status, 200);
  assert.equal(officialDashboard.response.status, 200);
  const report = await request(baseUrl, '/api/admin/reports/fdrs?page=1&limit=10', { token: adminToken });
  assert.equal(report.response.status, 200);
  const csv = await request(baseUrl, '/api/admin/reports/fdrs/export', { token: adminToken });
  assert.equal(csv.response.status, 200);
  assert.match(csv.response.headers.get('content-type'), /text\/csv/);
  assert.equal(csv.data.toString('utf8').includes(storagePath), false);

  const storedAuditCount = await AuditLog.countDocuments({ entityId: { $in: fdrIds } });
  assert.ok(storedAuditCount >= 7);
});
