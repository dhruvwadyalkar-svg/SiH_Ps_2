import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const clientDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDirectory = path.resolve(clientDirectory, '../server');
const serverRequire = createRequire(path.join(serverDirectory, 'package.json'));
const mongoose = serverRequire('mongoose');
const bcrypt = serverRequire('bcryptjs');
const { PDFDocument } = serverRequire('pdf-lib');
const importServerModule = (file) => import(pathToFileURL(path.join(serverDirectory, file)));

const [{ default: AuditLog }, { default: FDR }, { default: Institution }, { default: Notification }, { default: User }, { deleteStoredDocument }] =
  await Promise.all([
    importServerModule('src/models/AuditLog.js'),
    importServerModule('src/models/FDR.js'),
    importServerModule('src/models/Institution.js'),
    importServerModule('src/models/Notification.js'),
    importServerModule('src/models/User.js'),
    importServerModule('src/services/document-storage.service.js'),
  ]);

const runId = randomUUID().replaceAll('-', '').slice(0, 14).toUpperCase();
const password = 'Synthetic-Browser-Test-Password-2026!';
const adminEmail = `admin-${runId.toLowerCase()}@example.test`;
const reviewerEmail = `reviewer-${runId.toLowerCase()}@example.test`;
const institutionBEmail = `institution-b-${runId.toLowerCase()}@example.test`;
const institutionBCode = `SYN-B-${runId}`;
const institutionACode = `SYN-A-${runId}`;
const fdrNumber = `SYN-FDR-${runId}`;
const userEmails = [adminEmail, reviewerEmail, institutionBEmail];
const institutionCodes = [institutionACode, institutionBCode];
let connected = false;

const signIn = async (page, email) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  return response.json();
};

const navigateWithinApp = async (page, route) => {
  await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
};

test.beforeAll(async () => {
  const uri = process.env.MONGODB_TEST_URI;
  const database = uri?.match(/@[^/]+\/([^/?]+)(?:\?|$)/)?.[1];
  if (database !== 'aicte_fdr_portal_test') {
    throw new Error('Browser E2E refused to connect outside aicte_fdr_portal_test.');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 5 });
  connected = true;
  const passwordHash = await bcrypt.hash(password, 10);
  const institutionB = await Institution.create({
    name: `Synthetic Institution B ${runId}`,
    institutionCode: institutionBCode,
    contactEmail: `contact-b-${runId.toLowerCase()}@example.test`,
    contactPhone: '+91-9000000001',
    address: 'Synthetic browser test address B',
    status: 'active',
  });
  await User.create([
    {
      fullName: 'Synthetic Browser Administrator',
      email: adminEmail,
      passwordHash,
      role: 'aicte_admin',
      isActive: true,
    },
    {
      fullName: 'Synthetic Browser Reviewer',
      email: reviewerEmail,
      passwordHash,
      role: 'reviewer',
      isActive: true,
    },
    {
      fullName: 'Synthetic Institution B User',
      email: institutionBEmail,
      passwordHash,
      role: 'institution_user',
      institution: institutionB._id,
      isActive: true,
    },
  ]);
});

test.afterAll(async () => {
  if (!connected) return;
  try {
    const emails = userEmails.concat(`user-${runId.toLowerCase()}@example.test`);
    const users = await User.find({ email: { $in: emails } }).select('_id').lean();
    const institutions = await Institution.find({ institutionCode: { $in: institutionCodes } })
      .select('_id').lean();
    const institutionIds = institutions.map(({ _id }) => _id);
    const userIds = users.map(({ _id }) => _id);
    const records = institutionIds.length
      ? await FDR.find({ institution: { $in: institutionIds }, fdrNumber }).select('_id documentMetadata.storageRef').lean()
      : [];
    const fdrIds = records.map(({ _id }) => _id);

    for (const record of records) {
      if (record.documentMetadata?.storageRef) {
        await deleteStoredDocument(record.documentMetadata.storageRef);
      }
    }
    if (userIds.length) await Notification.deleteMany({ recipient: { $in: userIds } });
    if (userIds.length || fdrIds.length) {
      await AuditLog.deleteMany({
        $or: [
          ...(userIds.length ? [{ actor: { $in: userIds } }] : []),
          ...(fdrIds.length ? [{ entityId: { $in: fdrIds } }] : []),
        ],
      });
    }
    if (fdrIds.length) await FDR.deleteMany({ _id: { $in: fdrIds } });
    if (userIds.length) await User.deleteMany({ _id: { $in: userIds } });
    if (institutionIds.length) await Institution.deleteMany({ _id: { $in: institutionIds } });

    const [remainingUsers, remainingInstitutions, remainingFdrs, remainingNotifications] = await Promise.all([
      User.countDocuments({ email: { $in: emails } }),
      Institution.countDocuments({ institutionCode: { $in: institutionCodes } }),
      FDR.countDocuments({ fdrNumber }),
      Notification.countDocuments({ deduplicationKey: `phase12-browser:${runId}` }),
    ]);
    if (remainingUsers + remainingInstitutions + remainingFdrs + remainingNotifications !== 0) {
      throw new Error('Synthetic browser E2E fixture cleanup was incomplete.');
    }
  } finally {
    await mongoose.disconnect();
  }
});

test('browser workflows use the live React app and isolated Express backend', async ({ browser }) => {
  const institutionContext = await browser.newContext();
  const institutionPage = await institutionContext.newPage();
  let institutionUserId;
  let institutionId;
  let fdrId;
  try {
    await test.step('register an institution through the rendered application', async () => {
      await institutionPage.goto('/register');
      await institutionPage.getByLabel('Institution name').fill(`Synthetic Institution A ${runId}`);
      await institutionPage.getByLabel('Institution code').fill(institutionACode);
      await institutionPage.getByLabel('Contact email').fill(`contact-a-${runId.toLowerCase()}@example.test`);
      await institutionPage.getByLabel('Contact phone').fill('+91-9000000000');
      await institutionPage.getByLabel('Address').fill('Synthetic browser test address A');
      await institutionPage.getByLabel('Full name').fill('Synthetic Institution A User');
      await institutionPage.getByLabel('Email', { exact: true }).fill(`user-${runId.toLowerCase()}@example.test`);
      await institutionPage.getByLabel('Password (at least 12 characters)').fill(password);
      const registrationPromise = institutionPage.waitForResponse((response) =>
        response.url().endsWith('/api/auth/register-institution') && response.request().method() === 'POST');
      await institutionPage.getByRole('button', { name: 'Submit registration' }).click();
      const registration = await registrationPromise;
      expect(registration.status()).toBe(201);
      const data = await registration.json();
      institutionUserId = data.user.id;
      institutionId = data.institution.id;
      await expect(institutionPage.getByText('Registration submitted. Your institution is pending official review.')).toBeVisible();
    });

    await test.step('admin navigation and institution approval', async () => {
      const adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      try {
        await signIn(adminPage, adminEmail);
        await expect(adminPage.getByRole('link', { name: 'Institutions' })).toBeVisible();
        const institutionsResponse = adminPage.waitForResponse((response) =>
          response.url().includes('/api/admin/institutions?') && response.request().method() === 'GET');
        await adminPage.getByRole('link', { name: 'Institutions' }).click();
        const institutionList = await (await institutionsResponse).json();
        expect(institutionList.institutions.some((item) => item.institutionCode === institutionACode)).toBeTruthy();
        const row = adminPage.getByRole('row').filter({ hasText: institutionACode });
        await expect(row).toBeVisible();
        await expect(row.locator('select')).toBeVisible();
        await row.locator('select').selectOption('active');
        await row.getByPlaceholder('Reason').fill('Synthetic browser E2E approval');
        const approvalPromise = adminPage.waitForResponse((response) =>
          response.url().includes(`/api/admin/institutions/${institutionId}/status`) &&
          response.request().method() === 'PATCH');
        await row.getByRole('button', { name: 'Save' }).click();
        expect((await approvalPromise).ok()).toBeTruthy();
      } finally {
        await adminContext.close();
      }
    });

    await test.step('institution login, FDR upload, list/detail, OCR and forensic results', async () => {
      const userEmail = `user-${runId.toLowerCase()}@example.test`;
      await signIn(institutionPage, userEmail);
      await expect(institutionPage.getByRole('link', { name: 'FDR register' })).toBeVisible();
      await institutionPage.getByRole('link', { name: 'FDR register' }).click();
      await institutionPage.getByRole('link', { name: /Add FDR/ }).click();
      await institutionPage.getByLabel('FDR number').fill(fdrNumber);
      await institutionPage.getByLabel('Issuing bank').fill('Synthetic Test Bank');
      await institutionPage.getByLabel('Branch').fill('Synthetic Test Branch');
      await institutionPage.getByLabel('Deposit amount').fill('250000');
      await institutionPage.getByLabel('Currency').fill('INR');
      await institutionPage.getByLabel('Issue date').fill('2026-01-01');
      await institutionPage.getByLabel('Maturity date').fill('2027-01-01');
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]);
      await institutionPage.getByLabel('Supporting document').setInputFiles({
        name: 'synthetic-browser-fdr.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
      });
      const createPromise = institutionPage.waitForResponse((response) =>
        response.url().endsWith('/api/fdrs') && response.request().method() === 'POST');
      await institutionPage.getByRole('button', { name: 'Submit FDR' }).click();
      const creation = await createPromise;
      expect(creation.status()).toBe(201);
      const result = await creation.json();
      fdrId = result.fdr.id;
      await expect(institutionPage.getByRole('heading', { name: fdrNumber })).toBeVisible();
      await expect(institutionPage.getByRole('button', { name: 'Download supporting document' })).toBeVisible();

      await institutionPage.getByRole('button', { name: 'Request OCR' }).click();
      await expect(institutionPage.locator('.panel-heading').filter({ hasText: 'OCR extraction' }).locator('span'))
        .toContainText(/completed|queued|processing|partially_completed/i, { timeout: 20_000 });
      await expect(institutionPage.getByText('Extracted fields are presented separately from submitted details.')).toBeVisible();

      await institutionPage.getByRole('button', { name: 'Run local analysis' }).click();
      await expect(institutionPage.getByText(/No signals detected by these limited checks|Heuristic \/ inconclusive|Conclusive for this specific check/))
        .toBeVisible({ timeout: 20_000 });
      await institutionPage.getByRole('link', { name: 'FDR register' }).click();
      await expect(institutionPage.getByText(fdrNumber)).toBeVisible();
      await institutionPage.getByRole('link', { name: fdrNumber }).click();
      await expect(institutionPage.getByRole('heading', { name: fdrNumber })).toBeVisible();

      await Notification.create({
        recipient: institutionUserId,
        institution: institutionId,
        fdr: fdrId,
        type: 'maturity_reminder',
        title: `Synthetic browser notification ${runId}`,
        message: 'Synthetic notification for browser verification only.',
        deduplicationKey: `phase12-browser:${runId}`,
      });
      await institutionPage.locator('.side-nav').getByRole('link', { name: 'Notifications' }).click();
      await expect(institutionPage.getByText(`${1} unread`)).toBeVisible();
      await expect(institutionPage.getByText(`Synthetic browser notification ${runId}`)).toBeVisible();
    });

    await test.step('reviewer navigation and permitted decision', async () => {
      const reviewerContext = await browser.newContext();
      const reviewerPage = await reviewerContext.newPage();
      try {
        await signIn(reviewerPage, reviewerEmail);
        await expect(reviewerPage.getByRole('link', { name: 'Review queue' })).toBeVisible();
        await reviewerPage.getByRole('link', { name: 'Review queue' }).click();
        const row = reviewerPage.getByRole('row').filter({ hasText: fdrNumber });
        await expect(row).toBeVisible();
        await row.getByRole('link', { name: 'Review →' }).click();
        await expect(reviewerPage.getByRole('heading', { name: fdrNumber })).toBeVisible();
        await reviewerPage.getByLabel('Reason / observation').fill('Synthetic browser review completed.');
        const decisionPromise = reviewerPage.waitForResponse((response) =>
          response.url().endsWith(`/api/admin/fdrs/${fdrId}/review`) &&
          response.request().method() === 'POST');
        await reviewerPage.getByRole('button', { name: 'Complete review' }).click();
        expect((await decisionPromise).ok()).toBeTruthy();
        await expect(reviewerPage.getByText('complete review', { exact: false })).toBeVisible();
      } finally {
        await reviewerContext.close();
      }
    });

    await test.step('Institution B cannot view or download Institution A document', async () => {
      const tenantContext = await browser.newContext();
      const tenantPage = await tenantContext.newPage();
      try {
        const loginResult = await signIn(tenantPage, institutionBEmail);
        expect(loginResult.user.role).toBe('institution_user');
        await navigateWithinApp(tenantPage, `/fdrs/${fdrId}`);
        await expect(tenantPage.getByRole('heading', { name: 'Unable to open record' })).toBeVisible();
        const download = await tenantPage.request.get(`http://localhost:3011/api/fdrs/${fdrId}/document`, {
          headers: { authorization: `Bearer ${loginResult.accessToken}` },
        });
        expect([403, 404]).toContain(download.status());
        await download.body();
      } finally {
        await tenantContext.close();
      }
    });
  } finally {
    await institutionContext.close();
  }
});
