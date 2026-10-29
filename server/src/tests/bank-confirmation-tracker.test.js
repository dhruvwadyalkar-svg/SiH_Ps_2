import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import BankConfirmationRequest from '../models/BankConfirmationRequest.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import {
  ALLOWED_TRANSITIONS,
  calculateDeadlineDates,
  enrichRequestWithDeadline,
  generateConfirmationReference,
  createBankConfirmationRequest,
  listBankConfirmationRequests,
  getBankConfirmationSummary,
  getBankConfirmationRequestById,
  updateConfirmationStatus,
  recordBankSubmission,
  recordBankResponse,
  uploadConfirmationEvidence,
  checkDeadlinesAndEscalate,
} from '../services/bank-confirmation.service.js';

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
    return Promise.resolve(typeof value === 'function' ? value() : value);
  },
  then(resolve, reject) {
    return Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject);
  },
});

test('Feature 3: Smart Bank Confirmation Tracker', async (suite) => {
  const institutionId = new mongoose.Types.ObjectId();
  const otherInstitutionId = new mongoose.Types.ObjectId();

  const instUser = {
    _id: new mongoose.Types.ObjectId(),
    fullName: 'Prof. Rajesh Sharma',
    email: 'rajesh@diet.edu.in',
    role: 'institution_admin',
    institution: institutionId,
  };

  const officialUser = {
    _id: new mongoose.Types.ObjectId(),
    fullName: 'Dr. Sunita Deshmukh',
    email: 'sunita.deshmukh@aicte-india.org',
    role: 'aicte_admin',
    institution: null,
  };

  const reviewerUser = {
    _id: new mongoose.Types.ObjectId(),
    fullName: 'Reviewer Vikram',
    email: 'vikram@aicte-india.org',
    role: 'reviewer',
    institution: null,
  };

  await suite.test('1. Reference generation and deadline calculations', () => {
    const ref = generateConfirmationReference();
    assert.match(ref, /^BCR-\d{4}-[A-Z0-9]{6}$/);

    const { submissionDate, deadlineDays, responseDeadline } = calculateDeadlineDates(new Date('2026-11-01T00:00:00Z'), 15);
    assert.equal(deadlineDays, 15);
    assert.equal(responseDeadline.toISOString(), '2026-11-16T00:00:00.000Z');
  });

  await suite.test('2. Dynamic deadline enrichment (normal, warning, overdue, critical_overdue)', () => {
    const now = new Date('2026-11-10T12:00:00Z');

    // Case A: normal (10 days left)
    const normalReq = {
      status: 'submitted_to_bank',
      deadlineDetails: { responseDeadline: new Date('2026-11-20T12:00:00Z') },
    };
    const enrichedNormal = enrichRequestWithDeadline(normalReq, now);
    assert.equal(enrichedNormal.isOverdue, false);
    assert.equal(enrichedNormal.escalationLevel, 'normal');
    assert.equal(enrichedNormal.daysRemaining, 10);

    // Case B: warning (2 days left)
    const warningReq = {
      status: 'awaiting_bank_response',
      deadlineDetails: { responseDeadline: new Date('2026-11-12T12:00:00Z') },
    };
    const enrichedWarning = enrichRequestWithDeadline(warningReq, now);
    assert.equal(enrichedWarning.isOverdue, false);
    assert.equal(enrichedWarning.escalationLevel, 'warning');
    assert.equal(enrichedWarning.daysRemaining, 2);

    // Case C: overdue (3 days past deadline)
    const overdueReq = {
      status: 'submitted_to_bank',
      deadlineDetails: { responseDeadline: new Date('2026-11-07T12:00:00Z') },
    };
    const enrichedOverdue = enrichRequestWithDeadline(overdueReq, now);
    assert.equal(enrichedOverdue.isOverdue, true);
    assert.equal(enrichedOverdue.escalationLevel, 'overdue');
    assert.equal(enrichedOverdue.daysOverdue, 3);

    // Case D: critical overdue (10 days past deadline)
    const criticalReq = {
      status: 'submitted_to_bank',
      deadlineDetails: { responseDeadline: new Date('2026-10-31T12:00:00Z') },
    };
    const enrichedCritical = enrichRequestWithDeadline(criticalReq, now);
    assert.equal(enrichedCritical.isOverdue, true);
    assert.equal(enrichedCritical.escalationLevel, 'critical_overdue');
    assert.equal(enrichedCritical.daysOverdue, 10);
  });

  await suite.test('3. Create Bank Confirmation Request with tenant isolation', async () => {
    const fdrId = new mongoose.Types.ObjectId();
    const mockFdr = {
      _id: fdrId,
      fdrNumber: 'SBIN-2026-FDR-98124',
      institution: institutionId,
      bankName: 'State Bank of India',
      branch: 'Parliament Street, New Delhi',
      amount: 12500000,
    };

    const originalFindById = FDR.findById;
    const originalInstFindById = Institution.findById;
    const originalCreate = BankConfirmationRequest.create;

    try {
      FDR.findById = () => Promise.resolve(mockFdr);
      Institution.findById = () => Promise.resolve({ _id: institutionId, name: 'Delhi Institute of Tech' });

      let createdPayload = null;
      BankConfirmationRequest.create = async (doc) => {
        createdPayload = doc;
        return {
          ...doc,
          _id: new mongoose.Types.ObjectId(),
          toObject: () => doc,
        };
      };

      // Institution admin creating for owned FDR succeeds
      const result = await createBankConfirmationRequest({
        fdrId,
        user: instUser,
        payload: {
          deadlineDays: 20,
          remarks: 'Verification required for APH compliance',
        },
      });

      assert.equal(result.fdrNumber, 'SBIN-2026-FDR-98124');
      assert.equal(result.status, 'pending_submission');
      assert.match(result.requestReference, /^BCR-/);
      assert.equal(createdPayload.history.length, 1);
      assert.equal(createdPayload.history[0].toStatus, 'pending_submission');

      // Cross-institution user denied
      const crossUser = {
        _id: new mongoose.Types.ObjectId(),
        role: 'institution_admin',
        institution: otherInstitutionId,
      };

      await assert.rejects(
        () => createBankConfirmationRequest({ fdrId, user: crossUser }),
        /You may only initiate confirmation requests for your institution FDRs/,
      );
    } finally {
      FDR.findById = originalFindById;
      Institution.findById = originalInstFindById;
      BankConfirmationRequest.create = originalCreate;
    }
  });

  await suite.test('4. Status transition validation and mandatory evidence rule', async () => {
    const reqId = new mongoose.Types.ObjectId();
    const mockRequest = {
      _id: reqId,
      fdr: new mongoose.Types.ObjectId(),
      fdrNumber: 'SBIN-2026-FDR-98124',
      institution: institutionId,
      bankName: 'State Bank of India',
      branch: 'Parliament Street',
      requestReference: 'BCR-2026-TEST01',
      status: 'awaiting_bank_response',
      evidenceDocuments: [],
      history: [],
      deadlineDetails: { responseDeadline: new Date('2026-11-20') },
      save: async () => mockRequest,
      toObject: () => mockRequest,
    };

    const originalReqFindById = BankConfirmationRequest.findById;
    try {
      BankConfirmationRequest.findById = () => Promise.resolve(mockRequest);

      // A. Illegal transition (awaiting_bank_response -> draft is illegal)
      await assert.rejects(
        () => updateConfirmationStatus({
          id: reqId,
          user: officialUser,
          payload: { status: 'draft' },
        }),
        /Cannot transition confirmation status from 'awaiting_bank_response' to 'draft'/,
      );

      // B. Mandatory evidence rule: Transition to 'confirmed' without evidence document MUST fail
      await assert.rejects(
        () => updateConfirmationStatus({
          id: reqId,
          user: officialUser,
          payload: { status: 'confirmed' },
        }),
        /Cannot confirm bank verification without supporting written bank correspondence or evidence attached/,
      );

      // C. Transition succeeds when evidence is attached
      mockRequest.evidenceDocuments.push({
        _id: new mongoose.Types.ObjectId(),
        storageRef: 'evidence-1.pdf',
        fileName: 'bank_confirmation_letter.pdf',
        mimeType: 'application/pdf',
        fileSize: 10240,
        documentType: 'bank_letter',
      });

      const updated = await updateConfirmationStatus({
        id: reqId,
        user: officialUser,
        payload: {
          status: 'confirmed',
          reason: 'Verified genuine with SBI Branch Manager letter received',
        },
      });

      assert.equal(updated.status, 'confirmed');
      assert.equal(mockRequest.history.length, 1);
      assert.equal(mockRequest.history[0].toStatus, 'confirmed');
    } finally {
      BankConfirmationRequest.findById = originalReqFindById;
    }
  });

  await suite.test('5. Record Bank Submission updates dispatch details and deadline', async () => {
    const reqId = new mongoose.Types.ObjectId();
    const mockRequest = {
      _id: reqId,
      fdr: new mongoose.Types.ObjectId(),
      fdrNumber: 'SBIN-2026-FDR-98124',
      institution: institutionId,
      bankName: 'State Bank of India',
      branch: 'Parliament Street',
      requestReference: 'BCR-2026-SUBMIT01',
      status: 'pending_submission',
      evidenceDocuments: [],
      history: [],
      submissionDetails: {},
      deadlineDetails: {},
      save: async () => mockRequest,
      toObject: () => mockRequest,
    };

    const originalReqFindById = BankConfirmationRequest.findById;
    const originalNotifCreate = Notification.create;
    const originalUserFindOne = User.findOne;

    try {
      BankConfirmationRequest.findById = () => Promise.resolve(mockRequest);
      User.findOne = () => Promise.resolve({ _id: instUser._id });
      Notification.create = () => Promise.resolve({});

      // Non-officials rejected
      await assert.rejects(
        () => recordBankSubmission({
          id: reqId,
          user: instUser,
          payload: { submissionMethod: 'official_letter' },
        }),
        /Only authorized officials can record bank submissions/,
      );

      // Official records valid submission
      const result = await recordBankSubmission({
        id: reqId,
        user: reviewerUser,
        payload: {
          submissionDate: '2026-11-01T10:00:00.000Z',
          submissionMethod: 'registered_post_courier',
          dispatchReference: 'SP-DEL-89412-IN',
          recipientBranchContact: 'branch.manager@sbi.co.in',
          notes: 'Official speed post dispatched with AICTE inquiry letter',
          deadlineDays: 20,
        },
      });

      assert.equal(result.status, 'submitted_to_bank');
      assert.equal(mockRequest.submissionDetails.dispatchReference, 'SP-DEL-89412-IN');
      assert.equal(mockRequest.submissionDetails.submissionMethod, 'registered_post_courier');
      assert.equal(mockRequest.deadlineDetails.deadlineDays, 20);
      assert.equal(mockRequest.deadlineDetails.responseDeadline.toISOString(), '2026-11-21T10:00:00.000Z');
      assert.equal(mockRequest.history.length, 1);
      assert.equal(mockRequest.history[0].toStatus, 'submitted_to_bank');
    } finally {
      BankConfirmationRequest.findById = originalReqFindById;
      Notification.create = originalNotifCreate;
      User.findOne = originalUserFindOne;
    }
  });

  await suite.test('6. Record Bank Response with Discrepancy Found flags', async () => {
    const reqId = new mongoose.Types.ObjectId();
    const fdrId = new mongoose.Types.ObjectId();

    const mockFdr = {
      _id: fdrId,
      fdrNumber: 'SBIN-2026-FDR-98124',
      bankName: 'State Bank of India',
      bankVerification: { status: 'pending', history: [] },
      save: async () => mockFdr,
    };

    const mockRequest = {
      _id: reqId,
      fdr: fdrId,
      fdrNumber: 'SBIN-2026-FDR-98124',
      institution: institutionId,
      bankName: 'State Bank of India',
      branch: 'Parliament Street',
      requestReference: 'BCR-2026-RESP01',
      status: 'submitted_to_bank',
      evidenceDocuments: [],
      history: [],
      bankResponse: {},
      save: async () => mockRequest,
      toObject: () => mockRequest,
    };

    const originalReqFindById = BankConfirmationRequest.findById;
    const originalFdrFindById = FDR.findById;
    const originalNotifCreate = Notification.create;
    const originalUserFindOne = User.findOne;

    try {
      BankConfirmationRequest.findById = () => Promise.resolve(mockRequest);
      FDR.findById = () => Promise.resolve(mockFdr);
      User.findOne = () => Promise.resolve({ _id: instUser._id });
      Notification.create = () => Promise.resolve({});

      const responsePayload = {
        responseDate: '2026-11-05T14:00:00.000Z',
        responseReference: 'SBI/PARL/CONF/2026/891',
        responderName: 'R. K. Malhotra',
        responderDesignation: 'Assistant General Manager',
        outcome: 'discrepancy_found',
        discrepancies: {
          amountMismatch: true,
          lienNotMarked: true,
          notes: 'Principal recorded as 1.00 Cr in bank vs 1.25 Cr submitted. Lien not marked for AICTE.',
        },
        generalNotes: 'Branch letter received confirming deposit mismatch.',
      };

      const result = await recordBankResponse({
        id: reqId,
        user: officialUser,
        payload: responsePayload,
      });

      assert.equal(result.status, 'discrepancy_found');
      assert.equal(mockRequest.bankResponse.outcome, 'discrepancy_found');
      assert.equal(mockRequest.bankResponse.discrepancies.amountMismatch, true);
      assert.equal(mockRequest.bankResponse.discrepancies.lienNotMarked, true);
      assert.equal(mockFdr.bankVerification.status, 'verification_failed');
    } finally {
      BankConfirmationRequest.findById = originalReqFindById;
      FDR.findById = originalFdrFindById;
      Notification.create = originalNotifCreate;
      User.findOne = originalUserFindOne;
    }
  });

  await suite.test('7. Automated deadline escalation and notification deduplication', async () => {
    const pastDeadline = new Date('2026-10-20T00:00:00.000Z');
    const mockOverdueReq = {
      _id: new mongoose.Types.ObjectId(),
      fdr: new mongoose.Types.ObjectId(),
      fdrNumber: 'SBIN-2026-FDR-98124',
      institution: institutionId,
      bankName: 'State Bank of India',
      requestReference: 'BCR-2026-ESCALATE',
      status: 'submitted_to_bank',
      assignedOfficial: officialUser._id,
      deadlineDetails: {
        responseDeadline: pastDeadline,
        escalationLevel: 'normal',
      },
      notificationsSent: {},
      save: async () => mockOverdueReq,
    };

    const originalReqFind = BankConfirmationRequest.find;
    const notificationsCreated = [];
    const originalNotifCreate = Notification.create;

    try {
      BankConfirmationRequest.find = () => Promise.resolve([mockOverdueReq]);
      Notification.create = async (notif) => {
        notificationsCreated.push(notif);
        return notif;
      };

      const testNow = new Date('2026-11-01T00:00:00.000Z'); // 12 days past deadline (>7 days -> critical)

      // First run: triggers critical overdue escalation and sends notification
      const run1 = await checkDeadlinesAndEscalate({ now: testNow });
      assert.equal(run1.processedCount, 1);
      assert.equal(run1.escalatedOverdue, 1);
      assert.equal(mockOverdueReq.deadlineDetails.escalationLevel, 'critical_overdue');
      assert.equal(notificationsCreated.length, 1);
      assert.match(notificationsCreated[0].title, /CRITICAL: Overdue Bank Confirmation/);

      // Second run: deduplication prevents re-sending duplicate notification
      const run2 = await checkDeadlinesAndEscalate({ now: testNow });
      assert.equal(run2.processedCount, 1);
      assert.equal(run2.escalatedOverdue, 0); // 0 newly escalated
      assert.equal(notificationsCreated.length, 1); // no duplicate notification added
    } finally {
      BankConfirmationRequest.find = originalReqFind;
      Notification.create = originalNotifCreate;
    }
  });

  await suite.test('8. Summary metrics aggregation', async () => {
    const originalCountDocuments = BankConfirmationRequest.countDocuments;
    try {
      BankConfirmationRequest.countDocuments = async (filter) => {
        if (filter.status === 'confirmed') return 8;
        if (filter.status === 'discrepancy_found') return 2;
        if (filter['deadlineDetails.responseDeadline']) return 3; // overdue
        if (filter.status?.$in) return 5; // pending
        return 18; // total
      };

      const summary = await getBankConfirmationSummary({ user: officialUser });
      assert.equal(summary.pending, 5);
      assert.equal(summary.confirmed, 8);
      assert.equal(summary.discrepancy, 2);
      assert.equal(summary.overdue, 3);
      assert.equal(summary.total, 18);
    } finally {
      BankConfirmationRequest.countDocuments = originalCountDocuments;
    }
  });
});

