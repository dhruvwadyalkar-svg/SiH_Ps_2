import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app.js';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import Notification from '../models/Notification.js';
import ReleaseRequest from '../models/ReleaseRequest.js';
import User from '../models/User.js';
import {
  getNextReminderRun,
  getReminderStage,
  runMaturityReminderJob,
} from '../jobs/maturity-reminder.job.js';
import {
  exportAdminFdrReport,
  getAdminDashboardSummary,
  getInstitutionDashboardSummary,
  listAdminFdrReport,
} from '../services/phase9-dashboard.service.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NotificationServiceError,
} from '../services/notification.service.js';
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
} from '../utils/date-only.js';

const jwtSecret = 'synthetic-phase-nine-jwt-secret-with-32-characters';

const queryFor = (value) => ({
  select() { return this; },
  populate() { return this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

const createServer = async (context) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const authenticateAs = (context, user) => {
  process.env.JWT_SECRET = jwtSecret;
  context.mock.method(User, 'findById', () => queryFor(user));
  const token = jwt.sign({}, jwtSecret, {
    algorithm: 'HS256',
    subject: String(user._id),
    expiresIn: '10m',
  });
  return { authorization: `Bearer ${token}` };
};

const makeUser = (role, institution = null) => ({
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Synthetic Phase Nine User',
  email: 'phase-nine@example.test',
  role,
  isActive: true,
  institution: institution?._id || institution,
});

const makeInstitution = () => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'Synthetic Phase Nine Institution',
});

test('date-only maturity calculations use Asia/Kolkata calendar days', async (context) => {
  const now = new Date('2026-03-01T19:00:00.000Z');
  assert.equal(dateKeyInTimeZone(now, 'Asia/Kolkata'), '2026-03-02');
  assert.equal(addDaysToDateKey('2026-03-02', 30), '2026-04-01');
  assert.deepEqual(getReminderStage({
    maturityDate: new Date('2026-04-01T00:00:00.000Z'),
    now,
    timezone: 'Asia/Kolkata',
    reminderDays: [30, 15, 7],
    overdueEnabled: true,
    overdueMaxDays: 90,
  }), {
    type: 'maturity_reminder',
    stage: '30d',
    daysUntilMaturity: 30,
    maturityKey: '2026-04-01',
  });
  assert.equal(getReminderStage({
    maturityDate: 'invalid',
    now,
    timezone: 'Asia/Kolkata',
    reminderDays: [30, 15, 7],
    overdueEnabled: true,
    overdueMaxDays: 90,
  }), null);
  assert.equal(getReminderStage({
    maturityDate: null,
    now,
    timezone: 'Asia/Kolkata',
    reminderDays: [30, 15, 7],
    overdueEnabled: true,
    overdueMaxDays: 90,
  }), null);
  assert.equal(getNextReminderRun(new Date('2026-03-01T01:00:00.000Z'), {
    hour: 9,
    minute: 0,
    timezone: 'Asia/Kolkata',
  }).toISOString(), '2026-03-01T03:30:00.000Z');
});

test('maturity reminders include configured intervals and one bounded overdue stage', async (context) => {
  const now = new Date('2026-03-01T17:00:00.000Z');
  const institution = makeInstitution();
  const recipients = [
    makeUser('institution_admin', institution),
    makeUser('institution_user', institution),
  ];
  const records = [
    { _id: new mongoose.Types.ObjectId(), institution: institution._id, reviewer: null, fdrNumber: 'SYN-30D', maturityDate: new Date('2026-03-31T00:00:00.000Z'), workflowStatus: 'review_completed', financialStatus: 'active' },
    { _id: new mongoose.Types.ObjectId(), institution: institution._id, reviewer: null, fdrNumber: 'SYN-OVERDUE', maturityDate: new Date('2026-02-27T00:00:00.000Z'), workflowStatus: 'approved', financialStatus: 'matured' },
    { _id: new mongoose.Types.ObjectId(), institution: institution._id, reviewer: null, fdrNumber: 'SYN-OLD', maturityDate: new Date('2025-11-01T00:00:00.000Z'), workflowStatus: 'review_completed', financialStatus: 'active' },
    { _id: new mongoose.Types.ObjectId(), institution: institution._id, reviewer: null, fdrNumber: 'SYN-RELEASED', maturityDate: new Date('2026-03-31T00:00:00.000Z'), workflowStatus: 'released', financialStatus: 'released' },
  ];
  const inserted = new Set();
  const logs = [];
  context.mock.method(FDR, 'find', (filter) =>
    queryFor(filter.replacesFdr ? [] : records));
  context.mock.method(User, 'find', (filter) => {
    assert.ok(filter.$or.some((clause) => clause.role?.$in?.includes('institution_admin')));
    return queryFor(recipients);
  });
  context.mock.method(Notification, 'updateOne', async (filter) => {
    if (inserted.has(filter.deduplicationKey)) return { upsertedCount: 0 };
    inserted.add(filter.deduplicationKey);
    return { upsertedCount: 1 };
  });

  const config = {
    enabled: true,
    timezone: 'Asia/Kolkata',
    reminderDays: [30, 15, 7],
    overdueEnabled: true,
    overdueMaxDays: 90,
    configuredOfficialUserIds: [],
  };
  const logger = { info: (...args) => logs.push(args), error: (...args) => logs.push(args) };
  const first = await runMaturityReminderJob({ now, config, logger });
  const second = await runMaturityReminderJob({ now, config, logger });

  assert.deepEqual(first, { processed: 4, created: 4, skipped: 2, failed: 0 });
  assert.deepEqual(second, { processed: 4, created: 0, skipped: 2, failed: 0 });
  assert.equal(inserted.size, 4);
  assert.equal(logs.some(([message]) => String(message).includes('password')), false);
});

test('reminder eligibility honors only the configured due stages', () => {
  const common = {
    now: new Date('2026-03-01T17:00:00.000Z'),
    timezone: 'Asia/Kolkata',
    reminderDays: [30, 15, 7],
    overdueEnabled: true,
    overdueMaxDays: 90,
  };
  assert.equal(getReminderStage({ ...common, maturityDate: new Date('2026-03-16T00:00:00Z') }).stage, '15d');
  assert.equal(getReminderStage({ ...common, maturityDate: new Date('2026-03-08T00:00:00Z') }).stage, '7d');
  assert.equal(getReminderStage({ ...common, maturityDate: new Date('2026-03-21T00:00:00Z') }), null);
  assert.equal(getReminderStage({ ...common, maturityDate: new Date('2026-02-28T00:00:00Z') }).stage, 'overdue');
  assert.equal(getReminderStage({
    ...common,
    overdueEnabled: false,
    maturityDate: new Date('2026-02-28T00:00:00Z'),
  }), null);
});

test('notification read operations remain recipient-scoped', async (context) => {
  const userId = new mongoose.Types.ObjectId();
  const notificationId = new mongoose.Types.ObjectId();
  let markFilter;
  let allFilter;
  let matchedCount = 1;
  context.mock.method(Notification, 'updateOne', async (filter) => {
    markFilter = filter;
    return { matchedCount };
  });
  context.mock.method(Notification, 'updateMany', async (filter) => {
    allFilter = filter;
    return { modifiedCount: 2 };
  });
  const readResult = await markNotificationRead({ userId, notificationId });
  const allResult = await markAllNotificationsRead({ userId });
  assert.equal(String(markFilter.recipient), String(userId));
  assert.equal(String(markFilter._id), String(notificationId));
  assert.equal(String(allFilter.recipient), String(userId));
  assert.equal(allResult.modifiedCount, 2);
  assert.equal(readResult.id, String(notificationId));
  matchedCount = 0;
  context.mock.method(Notification, 'findOne', () => ({
    select: async () => null,
  }));
  await assert.rejects(
    markNotificationRead({ userId, notificationId }),
    (error) => error instanceof NotificationServiceError && error.status === 404,
  );
});

test('notification serialization exposes only safe metadata fields', async (context) => {
  const userId = new mongoose.Types.ObjectId();
  context.mock.method(Notification, 'countDocuments', async () => 1);
  context.mock.method(Notification, 'find', () => queryFor([{
    _id: new mongoose.Types.ObjectId(),
    type: 'maturity_reminder',
    title: 'FDR maturity reminder',
    message: 'A synthetic record matures soon.',
    metadata: {
      fdrNumber: 'SYN-001',
      maturityDate: '2026-04-01',
      reminderStage: '30d',
      password: 'should-not-be-returned',
      ocrPayload: { secret: true },
    },
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    readAt: null,
  }]));
  const result = await listNotifications({
    userId,
    query: { page: 1, limit: 20, unreadOnly: false },
  });
  assert.deepEqual(result.notifications[0].metadata, {
    fdrNumber: 'SYN-001',
    maturityDate: '2026-04-01',
    reminderStage: '30d',
  });
  assert.equal(JSON.stringify(result).includes('should-not-be-returned'), false);
  assert.equal(JSON.stringify(result).includes('ocrPayload'), false);
});

test('notification HTTP endpoints require auth and never accept another recipient', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  context.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const baseUrl = await createServer(context);
  assert.equal((await fetch(`${baseUrl}/api/notifications`)).status, 401);

  const user = makeUser('institution_user');
  const headers = authenticateAs(context, user);
  let listFilter;
  context.mock.method(Notification, 'countDocuments', async (filter) => {
    if (filter.readAt === null) return 3;
    return 3;
  });
  context.mock.method(Notification, 'find', (filter) => {
    listFilter = filter;
    return queryFor([]);
  });
  const response = await fetch(`${baseUrl}/api/notifications?unreadOnly=true`, { headers });
  assert.equal(response.status, 200);
  assert.equal(String(listFilter.recipient), String(user._id));
  assert.equal(listFilter.readAt, null);
  assert.equal((await response.json()).unreadCount, 3);
});

test('notification HTTP read and read-all operations stay scoped to the current user', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  context.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const baseUrl = await createServer(context);
  const institution = makeInstitution();
  const user = makeUser('institution_user', institution);
  const headers = authenticateAs(context, user);
  const notificationId = new mongoose.Types.ObjectId();
  let updateOneFilter;
  let updateManyFilter;
  context.mock.method(Notification, 'updateOne', async (filter) => {
    updateOneFilter = filter;
    return { matchedCount: 1 };
  });
  context.mock.method(Notification, 'updateMany', async (filter) => {
    updateManyFilter = filter;
    return { modifiedCount: 2 };
  });

  const readResponse = await fetch(`${baseUrl}/api/notifications/${notificationId}/read`, {
    method: 'PATCH',
    headers,
  });
  assert.equal(readResponse.status, 200);
  assert.equal(String(updateOneFilter.recipient), String(user._id));
  assert.equal(String(updateOneFilter._id), String(notificationId));

  const readAllResponse = await fetch(`${baseUrl}/api/notifications/read-all`, {
    method: 'PATCH',
    headers,
  });
  assert.equal(readAllResponse.status, 200);
  assert.equal(String(updateManyFilter.recipient), String(user._id));
  assert.equal((await readAllResponse.json()).modifiedCount, 2);
});

test('institution and official dashboards enforce roles and exclude replacement history', async (context) => {
  const institution = makeInstitution();
  const institutionUser = makeUser('institution_admin', institution);
  let capturedPipeline;
  context.mock.method(FDR, 'aggregate', async (pipeline) => {
    capturedPipeline = pipeline;
    return [{
      total: [{ count: 2 }],
      byWorkflowStatus: [{ _id: 'submitted', count: 1 }, { _id: 'review_completed', count: 1 }],
      approachingMaturity: [{ count: 1 }],
      maturedAwaitingAction: [],
      pendingReview: [{ count: 1 }],
      correctionRequests: [],
      renewalReplacementWorkload: [],
    }];
  });
  context.mock.method(ReleaseRequest, 'countDocuments', async () => 1);
  context.mock.method(Notification, 'countDocuments', async () => 4);
  const institutionSummary = await getInstitutionDashboardSummary({
    user: institutionUser,
    now: new Date('2026-03-01T00:00:00.000Z'),
  });
  const matchStage = capturedPipeline.find((stage) => stage.$match?.institution);
  assert.equal(String(matchStage.$match.institution), String(institution._id));
  assert.ok(capturedPipeline.some((stage) => stage.$lookup?.foreignField === 'replacesFdr'));
  assert.equal(institutionSummary.totalFdrs, 2);
  assert.equal(institutionSummary.activeReleaseRequests, 1);
  assert.equal(institutionSummary.unreadNotifications, 4);
  await assert.rejects(
    getInstitutionDashboardSummary({ user: makeUser('reviewer') }),
    (error) => error.status === 403,
  );

  context.mock.method(Institution, 'countDocuments', async () => 2);
  context.mock.method(AuditLog, 'aggregate', async () => [{ _id: 'fdr_review_completed', count: 1 }]);
  const adminSummary = await getAdminDashboardSummary({ user: makeUser('aicte_admin') });
  assert.equal(adminSummary.totalInstitutions, 2);
  assert.deepEqual(adminSummary.recentAdministrativeWorkload, { fdr_review_completed: 1 });
  await assert.rejects(
    getAdminDashboardSummary({ user: institutionUser }),
    (error) => error.status === 403,
  );
});

test('admin report filters paginate and export formula-safe CSV with an audit event', async (context) => {
  const user = makeUser('reviewer');
  const institution = { _id: new mongoose.Types.ObjectId(), name: '=2+2', institutionCode: '@FORMULA' };
  const record = {
    _id: new mongoose.Types.ObjectId(),
    institution,
    fdrNumber: '+CMD',
    bankName: 'Synthetic Bank',
    branch: 'Synthetic Branch',
    amount: 100,
    currency: 'INR',
    issueDate: new Date('2026-01-01T00:00:00.000Z'),
    maturityDate: new Date('2026-04-01T00:00:00.000Z'),
    workflowStatus: 'submitted',
    financialStatus: 'active',
    replacesFdr: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
  };
  let reportFilter;
  context.mock.method(Institution, 'find', (filter) => {
    assert.ok(filter.$or);
    return queryFor([{ _id: institution._id }]);
  });
  context.mock.method(FDR, 'countDocuments', async (filter) => {
    reportFilter = filter;
    return 1;
  });
  context.mock.method(FDR, 'find', (filter) => {
    reportFilter = filter;
    return queryFor([record]);
  });
  let auditSaved = false;
  context.mock.method(AuditLog.prototype, 'save', async function () {
    await this.validate();
    auditSaved = true;
    return this;
  });

  const query = {
    page: 2,
    limit: 10,
    search: 'SYN',
    workflowStatus: 'submitted',
    maturityFrom: '2026-03-01',
    maturityTo: '2026-05-01',
  };
  const listed = await listAdminFdrReport({ user, query });
  assert.equal(listed.pagination.total, 1);
  assert.ok(reportFilter.$or);
  assert.equal(reportFilter.workflowStatus, 'submitted');
  const exported = await exportAdminFdrReport({ user, query });
  assert.match(exported.csv, /"'=2\+2"/);
  assert.match(exported.csv, /"'@FORMULA"/);
  assert.match(exported.csv, /"'\+CMD"/);
  assert.equal(exported.rowCount, 1);
  assert.equal(auditSaved, true);
});

test('admin report and CSV export deny institution users', async () => {
  const user = makeUser('institution_admin', makeInstitution());
  const query = { page: 1, limit: 20 };
  await assert.rejects(
    listAdminFdrReport({ user, query }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    exportAdminFdrReport({ user, query }),
    (error) => error.status === 403,
  );
});
