import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../app.js';
import Institution from '../models/Institution.js';
import User from '../models/User.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';
import { provisionInitialAdmin } from '../services/adminBootstrap.service.js';
import { isValidUserId, serializeUser, verifyAccessToken } from '../utils/auth.js';
import { bootstrapAdminSchema, loginSchema, registerInstitutionSchema } from '../utils/auth.validation.js';

const validRegistration = () => ({
  institution: {
    name: 'Example Institution',
    institutionCode: `TEST-${Math.random().toString(36).slice(2, 8)}`,
    contactEmail: 'contact@example.edu',
    contactPhone: '+91-1234567890',
    address: '123 Example Road, Pune',
  },
  user: {
    fullName: 'Sample User',
    email: '  SAMPLE.USER@example.com ',
    password: 'synthetic-test-password-2026',
  },
});

const createServer = async (context) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

const postJson = (baseUrl, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const queryFor = (value) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  },
});

test('Phase 3 authentication behavior', async (context) => {
  const previousSecret = process.env.JWT_SECRET;
  const previousExpiry = process.env.JWT_EXPIRES_IN;
  process.env.JWT_SECRET = 'synthetic-test-jwt-secret-with-32-characters';
  process.env.JWT_EXPIRES_IN = '15m';
  context.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousExpiry === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = previousExpiry;
  });

  await context.test('normalizes and validates request fields', () => {
    const parsedLogin = loginSchema.parse({
      email: '  TEST@EXAMPLE.COM ',
      password: 'synthetic-test-password',
    });
    assert.equal(parsedLogin.email, 'test@example.com');
    assert.equal(loginSchema.safeParse({ email: 'invalid', password: '' }).success, false);
    assert.equal(
      registerInstitutionSchema.safeParse({
        ...validRegistration(),
        role: 'aicte_admin',
      }).success,
      false,
    );
    assert.equal(
      bootstrapAdminSchema.safeParse({
        fullName: 'Test Admin',
        email: 'admin@example.com',
        password: 'synthetic-test-password-2026',
      }).success,
      true,
    );
  });

  await context.test('provisions an administrator without resetting an existing account', async (subtest) => {
    const baseProfile = {
      fullName: 'Synthetic Administrator',
      email: 'synthetic.admin@example.gov',
      password: 'synthetic-admin-password-2026',
    };
    const existingAdmin = new User({
      ...baseProfile,
      passwordHash: 'existing-hash',
      role: 'aicte_admin',
    });
    subtest.mock.method(User, 'findOne', async () => existingAdmin);
    const existingResult = await provisionInitialAdmin(baseProfile);
    assert.equal(existingResult, 'already-exists');

    subtest.mock.restoreAll();
    subtest.mock.method(User, 'findOne', async () => null);
    let createdAdmin;
    subtest.mock.method(User.prototype, 'save', async function () {
      await this.validate();
      createdAdmin = this;
      return this;
    });
    const result = await provisionInitialAdmin(baseProfile);
    assert.equal(result, 'created');
    assert.equal(createdAdmin.role, 'aicte_admin');
    assert.equal(createdAdmin.institution, undefined);
    assert.equal(await bcrypt.compare(baseProfile.password, createdAdmin.passwordHash), true);
  });

  await context.test('registration enforces the institution-user role and safe response', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const startSession = subtest.mock.method(mongoose, 'startSession', async () => ({
      withTransaction: async (callback) => callback(),
      endSession: async () => {},
    }));

    const rejectedRole = await postJson(baseUrl, '/api/auth/register-institution', {
      ...validRegistration(),
      user: { ...validRegistration().user, role: 'aicte_admin' },
    });
    assert.equal(rejectedRole.status, 400);

    let savedUser;
    subtest.mock.method(Institution.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    subtest.mock.method(User.prototype, 'save', async function () {
      await this.validate();
      savedUser = this;
      return this;
    });

    const response = await postJson(baseUrl, '/api/auth/register-institution', validRegistration());
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.institution.status, 'pending');
    assert.equal(body.user.role, 'institution_user');
    assert.equal(body.user.email, 'sample.user@example.com');
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
    assert.equal(Object.hasOwn(body.user, 'password'), false);
    assert.notEqual(savedUser.passwordHash, 'synthetic-test-password-2026');
    assert.equal(await bcrypt.compare('synthetic-test-password-2026', savedUser.passwordHash), true);
    assert.equal(startSession.mock.callCount(), 1);
  });

  await context.test('registration rejects invalid fields and duplicate institution/email records', async (subtest) => {
    const baseUrl = await createServer(subtest);
    subtest.mock.method(mongoose, 'startSession', async () => ({
      withTransaction: async (callback) => callback(),
      endSession: async () => {},
    }));

    const invalid = await postJson(baseUrl, '/api/auth/register-institution', {
      ...validRegistration(),
      user: { ...validRegistration().user, email: 'not-an-email' },
    });
    assert.equal(invalid.status, 400);

    subtest.mock.method(Institution.prototype, 'save', async () => {
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    });
    const duplicateInstitution = await postJson(
      baseUrl,
      '/api/auth/register-institution',
      validRegistration(),
    );
    assert.equal(duplicateInstitution.status, 409);

    subtest.mock.restoreAll();
    subtest.mock.method(mongoose, 'startSession', async () => ({
      withTransaction: async (callback) => callback(),
      endSession: async () => {},
    }));
    subtest.mock.method(Institution.prototype, 'save', async function () {
      await this.validate();
      return this;
    });
    subtest.mock.method(User.prototype, 'save', async () => {
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    });
    const duplicateEmail = await postJson(baseUrl, '/api/auth/register-institution', validRegistration());
    assert.equal(duplicateEmail.status, 409);
  });

  await context.test('login verifies hashed passwords and issues a signed JWT', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const userId = new mongoose.Types.ObjectId();
    const passwordHash = await bcrypt.hash('synthetic-test-password-2026', 4);
    const user = {
      _id: userId,
      fullName: 'Synthetic User',
      email: 'synthetic@example.com',
      passwordHash,
      role: 'institution_user',
      isActive: true,
      institution: {
        _id: new mongoose.Types.ObjectId(),
        name: 'Synthetic Institution',
        institutionCode: 'SYNTH-01',
        status: 'pending',
      },
    };
    subtest.mock.method(User, 'findOne', () => queryFor(user));

    const validResponse = await postJson(baseUrl, '/api/auth/login', {
      email: ' SYNTHETIC@example.com ',
      password: 'synthetic-test-password-2026',
    });
    const validBody = await validResponse.json();
    assert.equal(validResponse.status, 200);
    assert.equal(validBody.tokenType, 'Bearer');
    assert.equal(validBody.user.email, user.email);
    assert.equal(Object.hasOwn(validBody.user, 'passwordHash'), false);
    assert.equal(Object.hasOwn(validBody, 'password'), false);
    const claims = verifyAccessToken(validBody.accessToken);
    assert.equal(claims.sub, String(userId));
    assert.equal(claims.role, 'institution_user');

    const invalidResponse = await postJson(baseUrl, '/api/auth/login', {
      email: user.email,
      password: 'incorrect-synthetic-password',
    });
    assert.equal(invalidResponse.status, 401);
    assert.deepEqual(await invalidResponse.json(), { error: 'Invalid email or password.' });
  });

  await context.test('rejects inactive users and missing, malformed, or expired Bearer tokens', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const userId = new mongoose.Types.ObjectId();
    const token = jwt.sign(
      { role: 'aicte_admin' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', subject: String(userId), expiresIn: 60 },
    );

    for (const headers of [{}, { authorization: 'Bearer malformed.token' }]) {
      const response = await fetch(`${baseUrl}/api/auth/me`, { headers });
      assert.equal(response.status, 401);
    }

    const expiredToken = jwt.sign(
      { role: 'aicte_admin' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', subject: String(userId), expiresIn: -1 },
    );
    const expiredResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(expiredResponse.status, 401);

    subtest.mock.method(User, 'findById', () => queryFor({
      _id: userId,
      fullName: 'Inactive User',
      email: 'inactive@example.com',
      role: 'aicte_admin',
      isActive: false,
      institution: null,
    }));
    const inactiveResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(inactiveResponse.status, 401);
  });

  await context.test('loads current user safely and enforces roles from the loaded user', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const userId = new mongoose.Types.ObjectId();
    const institution = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Synthetic Institution',
      institutionCode: 'SYNTH-02',
      status: 'pending',
    };
    const user = {
      _id: userId,
      fullName: 'Current User',
      email: 'current@example.com',
      role: 'institution_user',
      isActive: true,
      institution,
      passwordHash: 'must-not-be-serialized',
    };
    subtest.mock.method(User, 'findById', () => queryFor(user));
    const token = jwt.sign(
      { role: 'aicte_admin' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', subject: String(userId), expiresIn: 60 },
    );
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.user.role, 'institution_user');
    assert.equal(body.user.institution.institutionCode, 'SYNTH-02');
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);

    const denied = { status: (status) => ({ json: (payload) => ({ status, payload }) }) };
    let advanced = false;
    authorizeRoles('aicte_admin')(
      { user },
      denied,
      () => {
        advanced = true;
      },
    );
    assert.equal(advanced, false);
    assert.equal(authorizeRoles('institution_user')(
      { user },
      denied,
      () => {
        advanced = true;
      },
    ), undefined);
    assert.equal(advanced, true);
    assert.equal(isValidUserId(String(userId)), true);
  });

  await context.test('serializes only the public user profile', () => {
    const safe = serializeUser({
      _id: new mongoose.Types.ObjectId(),
      fullName: 'Safe User',
      email: 'safe@example.com',
      role: 'reviewer',
      passwordHash: 'hidden',
      institution: null,
    });
    assert.deepEqual(Object.keys(safe), ['id', 'fullName', 'email', 'role', 'institution']);
    assert.equal(safe.institution, null);
    assert.throws(() => verifyAccessToken('not-a-jwt'));
  });

  await context.test('preserves the health endpoint', async (subtest) => {
    const baseUrl = await createServer(subtest);
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
  });
});
