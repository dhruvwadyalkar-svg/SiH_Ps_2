import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app.js';
import AuditLog from '../models/AuditLog.js';
import Institution from '../models/Institution.js';
import User from '../models/User.js';

const secret = 'synthetic-phase-four-jwt-secret-with-32-characters';

const createServer = async (context) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const makeUser = (role, institutionId = new mongoose.Types.ObjectId()) => ({
  _id: new mongoose.Types.ObjectId(),
  fullName: 'Synthetic Test User',
  email: 'synthetic.user@example.test',
  role,
  isActive: true,
  institution: institutionId,
});

const makeInstitution = (status = 'pending') => ({
  _id: new mongoose.Types.ObjectId(),
  name: 'Synthetic Test Institution',
  institutionCode: `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  contactEmail: 'contact@example.test',
  contactPhone: '+91-1234567890',
  address: '123 Synthetic Test Road',
  status,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  async save() {
    this.updatedAt = new Date();
    return this;
  },
});

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

const makeToken = (user) =>
  jwt.sign(
    { role: user.role },
    secret,
    { algorithm: 'HS256', subject: String(user._id), expiresIn: 60 },
  );

const setAuthUser = (context, user) => {
  process.env.JWT_SECRET = secret;
  context.mock.method(User, 'findById', () => queryFor(user));
  return { authorization: `Bearer ${makeToken(user)}` };
};

const makeSession = (context) => {
  context.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (callback) => callback(),
    endSession: async () => {},
  }));
};

test('Phase 4 institution profile and access control', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  context.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  await context.test('institution user reads only the institution attached to the authenticated user', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution._id);
    const findById = subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    const response = await fetch(
      `${baseUrl}/api/institutions/me?institutionId=${new mongoose.Types.ObjectId()}`,
      {
        headers: setAuthUser(subtest, user),
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.institution.id, String(institution._id));
    assert.equal(findById.mock.calls[0].arguments[0], institution._id);
    assert.equal(Object.hasOwn(body.institution, '__v'), false);
    assert.equal(Object.hasOwn(body.institution, 'internalVerification'), false);
  });

  await context.test('institution user updates allowlisted fields and writes an audit event', async (subtest) => {
    const baseUrl = await createServer(subtest);
    makeSession(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_admin', institution._id);
    let auditEvent;
    subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      auditEvent = this;
      return this;
    });

    const response = await fetch(`${baseUrl}/api/institutions/me`, {
      method: 'PATCH',
      headers: { ...setAuthUser(subtest, user), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Synthetic Institution',
        contactEmail: '  UPDATED@EXAMPLE.TEST ',
        contactPhone: '+91-9999999999',
        address: '456 Updated Synthetic Road',
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.institution.name, 'Updated Synthetic Institution');
    assert.equal(body.institution.contactEmail, 'updated@example.test');
    assert.equal(body.institution.status, 'pending');
    assert.equal(auditEvent.actor, user._id);
    assert.equal(auditEvent.action, 'institution_profile_updated');
    assert.equal(auditEvent.entityId, institution._id);
    assert.deepEqual(auditEvent.metadata.changedFields, ['name', 'contactEmail', 'contactPhone', 'address']);
  });

  await context.test('institution user cannot mass-assign forbidden fields or another association', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const institution = makeInstitution();
    const user = makeUser('institution_user', institution._id);
    const findById = subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    const response = await fetch(`${baseUrl}/api/institutions/me`, {
      method: 'PATCH',
      headers: { ...setAuthUser(subtest, user), 'content-type': 'application/json' },
      body: JSON.stringify({
        institutionId: new mongoose.Types.ObjectId(),
        status: 'active',
        institutionCode: 'FORGED',
        name: 'Attempted Change',
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(findById.mock.callCount(), 0);
    assert.equal(institution.status, 'pending');
  });

  await context.test('unauthenticated requests are rejected and missing institution associations are safe', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const unauthenticated = await fetch(`${baseUrl}/api/institutions/me`);
    assert.equal(unauthenticated.status, 401);

    const user = makeUser('institution_user', null);
    const response = await fetch(`${baseUrl}/api/institutions/me`, {
      headers: setAuthUser(subtest, user),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'No institution is associated with this user.' });
  });

  await context.test('institution users and institution admins cannot use official listing/review routes', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const user = makeUser('institution_user');
    const headers = setAuthUser(subtest, user);
    const listResponse = await fetch(`${baseUrl}/api/admin/institutions`, { headers });
    const reviewResponse = await fetch(`${baseUrl}/api/admin/institutions/${new mongoose.Types.ObjectId()}/status`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', reason: 'Synthetic approval review' }),
    });
    assert.equal(listResponse.status, 403);
    assert.equal(reviewResponse.status, 403);
  });

  await context.test('official listing supports validated pagination, search, status filter, and safe output', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const user = makeUser('reviewer', null);
    const institution = makeInstitution('pending');
    const countDocuments = subtest.mock.method(Institution, 'countDocuments', async () => 21);
    const find = subtest.mock.method(Institution, 'find', () => queryFor([institution]));
    const response = await fetch(
      `${baseUrl}/api/admin/institutions?page=2&limit=10&search=Test.&status=pending`,
      { headers: setAuthUser(subtest, user) },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.pagination.page, 2);
    assert.equal(body.pagination.limit, 10);
    assert.equal(body.pagination.total, 21);
    assert.equal(body.pagination.pages, 3);
    assert.equal(body.institutions.length, 1);
    assert.equal(Object.hasOwn(body.institutions[0], 'internalVerification'), false);
    const filter = find.mock.calls[0].arguments[0];
    assert.equal(filter.status, 'pending');
    assert.equal(filter.$or[0].name.test('TestX'), false);
    assert.equal(filter.$or[0].name.test('Test.'), true);
    assert.deepEqual(countDocuments.mock.calls[0].arguments[0], filter);
  });

  await context.test('official listing validates page size and status values', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const user = makeUser('aicte_admin', null);
    const headers = setAuthUser(subtest, user);

    const oversized = await fetch(`${baseUrl}/api/admin/institutions?limit=101`, { headers });
    const invalidStatus = await fetch(`${baseUrl}/api/admin/institutions?status=approved`, { headers });
    assert.equal(oversized.status, 400);
    assert.equal(invalidStatus.status, 400);
  });

  await context.test('authorized officials can view review history without exposing arbitrary audit metadata', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const user = makeUser('reviewer', null);
    const institution = makeInstitution();
    const auditRecords = [{
      actor: { _id: new mongoose.Types.ObjectId(), fullName: 'Synthetic Reviewer', role: 'reviewer' },
      metadata: {
        previousStatus: 'pending',
        newStatus: 'active',
        reason: 'Synthetic approval',
        secret: 'must-not-leak',
      },
      createdAt: new Date(),
    }];
    subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    subtest.mock.method(AuditLog, 'find', () => queryFor(auditRecords));

    const response = await fetch(`${baseUrl}/api/admin/institutions/${institution._id}`, {
      headers: setAuthUser(subtest, user),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.institution.id, String(institution._id));
    assert.equal(body.reviewHistory[0].newStatus, 'active');
    assert.equal(body.reviewHistory[0].actor.role, 'reviewer');
    assert.equal(Object.hasOwn(body.reviewHistory[0], 'secret'), false);
  });

  await context.test('invalid and nonexistent institution IDs return safe client errors', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const headers = setAuthUser(subtest, makeUser('aicte_admin', null));
    const invalidId = await fetch(`${baseUrl}/api/admin/institutions/not-an-object-id`, { headers });
    assert.equal(invalidId.status, 400);

    subtest.mock.method(Institution, 'findById', () => queryFor(null));
    const missing = await fetch(`${baseUrl}/api/admin/institutions/${new mongoose.Types.ObjectId()}`, {
      headers,
    });
    assert.equal(missing.status, 404);
  });

  await context.test('reviewers may decide pending institutions and audit the actor, transition, reason, and time', async (subtest) => {
    const baseUrl = await createServer(subtest);
    makeSession(subtest);
    const institution = makeInstitution('pending');
    const reviewer = makeUser('reviewer', null);
    let auditEvent;
    subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      this.createdAt = new Date();
      auditEvent = this;
      return this;
    });

    const response = await fetch(`${baseUrl}/api/admin/institutions/${institution._id}/status`, {
      method: 'PATCH',
      headers: { ...setAuthUser(subtest, reviewer), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', reason: 'Synthetic profile review passed' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.institution.status, 'active');
    assert.equal(auditEvent.actor, reviewer._id);
    assert.equal(auditEvent.action, 'institution_status_reviewed');
    assert.equal(auditEvent.entityType, 'Institution');
    assert.equal(auditEvent.entityId, institution._id);
    assert.deepEqual(auditEvent.metadata, {
      previousStatus: 'pending',
      newStatus: 'active',
      reason: 'Synthetic profile review passed',
    });
    assert.ok(auditEvent.createdAt instanceof Date);
  });

  await context.test('reviewers cannot suspend active records; admins may suspend and reactivate', async (subtest) => {
    const baseUrl = await createServer(subtest);
    makeSession(subtest);
    const institution = makeInstitution('active');
    const reviewer = makeUser('reviewer', null);
    subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    const forbidden = await fetch(`${baseUrl}/api/admin/institutions/${institution._id}/status`, {
      method: 'PATCH',
      headers: { ...setAuthUser(subtest, reviewer), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reason: 'Synthetic suspension attempt' }),
    });
    assert.equal(forbidden.status, 409);
    assert.equal(institution.status, 'active');

    subtest.mock.restoreAll();
    makeSession(subtest);
    const adminInstitution = makeInstitution('active');
    const admin = makeUser('aicte_admin', null);
    subtest.mock.method(User, 'findById', () => queryFor(admin));
    subtest.mock.method(Institution, 'findById', () => queryFor(adminInstitution));
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    const suspended = await fetch(
      `${baseUrl}/api/admin/institutions/${adminInstitution._id}/status`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${makeToken(admin)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'suspended', reason: 'Synthetic risk review' }),
      },
    );
    assert.equal(suspended.status, 200);
    assert.equal(adminInstitution.status, 'suspended');

    subtest.mock.restoreAll();
    makeSession(subtest);
    const suspendedInstitution = makeInstitution('suspended');
    const reactivatingAdmin = makeUser('aicte_admin', null);
    subtest.mock.method(User, 'findById', () => queryFor(reactivatingAdmin));
    subtest.mock.method(Institution, 'findById', () => queryFor(suspendedInstitution));
    subtest.mock.method(AuditLog.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    const reactivated = await fetch(
      `${baseUrl}/api/admin/institutions/${suspendedInstitution._id}/status`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${makeToken(reactivatingAdmin)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'active', reason: 'Synthetic follow-up review' }),
      },
    );
    assert.equal(reactivated.status, 200);
    assert.equal(suspendedInstitution.status, 'active');
  });

  await context.test('rejects invalid status, invalid IDs, and terminal inactive transitions', async (subtest) => {
    const baseUrl = await createServer(subtest);
    makeSession(subtest);
    const admin = makeUser('aicte_admin', null);
    const headers = setAuthUser(subtest, admin);
    const invalidStatus = await fetch(`${baseUrl}/api/admin/institutions/${new mongoose.Types.ObjectId()}/status`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved', reason: 'Invalid synthetic status' }),
    });
    const invalidId = await fetch(`${baseUrl}/api/admin/institutions/bad-id/status`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', reason: 'Synthetic status review' }),
    });
    assert.equal(invalidStatus.status, 400);
    assert.equal(invalidId.status, 400);

    const institution = makeInstitution('inactive');
    subtest.mock.method(Institution, 'findById', () => queryFor(institution));
    const terminal = await fetch(`${baseUrl}/api/admin/institutions/${institution._id}/status`, {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active', reason: 'Attempted synthetic reactivation' }),
    });
    assert.equal(terminal.status, 409);
    assert.equal(institution.status, 'inactive');
  });
});
