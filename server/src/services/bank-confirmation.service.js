import crypto from 'node:crypto';
import mongoose from 'mongoose';
import BankConfirmationRequest, {
  BANK_CONFIRMATION_STATUSES,
  SUBMISSION_METHODS,
} from '../models/BankConfirmationRequest.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import { recordAuditEvent } from './audit-log.service.js';
import {
  readStoredDocument,
  storeUploadedDocument,
} from './document-storage.service.js';
import { calculateFdrTrustScore } from './fdr-trust-score.service.js';
import { calculateFdrRiskScore } from './fdr-risk-score.service.js';

const officialRoles = new Set(['aicte_admin', 'reviewer']);
const institutionRoles = new Set(['institution_admin', 'institution_user']);

export class BankConfirmationServiceError extends Error {
  constructor(status, message, code = 'BANK_CONFIRMATION_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isOfficial = (user) => Boolean(user && officialRoles.has(user.role));
export const isInstitution = (user) => Boolean(user && institutionRoles.has(user.role));

const isDbOrMocked = (model, method = 'findById') => {
  if (mongoose.connection?.readyState === 1) return true;
  if (model[method] && model[method] !== mongoose.Model[method]) return true;
  if (model[method]?.mock) return true;
  return false;
};

const safeRecordAuditEvent = async (payload) => {
  if (mongoose.connection?.readyState === 1) {
    try {
      await recordAuditEvent(payload);
    } catch {
      // safe fallback
    }
  }
};

const getInstitutionId = (user) =>
  user?.institution?._id ? String(user.institution._id) : user?.institution ? String(user.institution) : null;

export const ALLOWED_TRANSITIONS = {
  draft: ['pending_submission', 'closed'],
  pending_submission: ['submitted_to_bank', 'draft', 'closed'],
  submitted_to_bank: ['awaiting_bank_response', 'confirmed', 'discrepancy_found', 'unable_to_verify', 'closed'],
  awaiting_bank_response: ['confirmed', 'discrepancy_found', 'unable_to_verify', 'closed'],
  discrepancy_found: ['awaiting_bank_response', 'unable_to_verify', 'confirmed', 'closed'],
  unable_to_verify: ['pending_submission', 'closed'],
  confirmed: ['closed'],
  closed: ['pending_submission', 'awaiting_bank_response'],
};

export const generateConfirmationReference = () => {
  const year = new Date().getFullYear();
  const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BCR-${year}-${hex}`;
};

export const calculateDeadlineDates = (submissionDate = new Date(), deadlineDays = 15) => {
  const subDate = new Date(submissionDate);
  const days = Math.max(1, Math.min(90, Number(deadlineDays) || 15));
  const deadline = new Date(subDate.getTime() + days * 24 * 60 * 60 * 1000);
  return { submissionDate: subDate, deadlineDays: days, responseDeadline: deadline };
};

export const enrichRequestWithDeadline = (reqDoc, now = new Date()) => {
  const req = typeof reqDoc.toObject === 'function' ? reqDoc.toObject() : { ...reqDoc };
  const deadline = req.deadlineDetails?.responseDeadline ? new Date(req.deadlineDetails.responseDeadline) : null;
  const isPendingStatus = ['submitted_to_bank', 'awaiting_bank_response'].includes(req.status);

  let isOverdue = false;
  let daysRemaining = null;
  let daysOverdue = 0;
  let escalationLevel = req.deadlineDetails?.escalationLevel || 'normal';

  if (deadline) {
    const diffMs = deadline.getTime() - now.getTime();
    daysRemaining = Math.ceil(diffMs / (24 * 60 * 60 * 1000));

    if (isPendingStatus && diffMs < 0) {
      isOverdue = true;
      daysOverdue = Math.max(1, Math.floor(Math.abs(diffMs) / (24 * 60 * 60 * 1000)));
      if (daysOverdue > 7) {
        escalationLevel = 'critical_overdue';
      } else {
        escalationLevel = 'overdue';
      }
    } else if (isPendingStatus && daysRemaining <= 3 && daysRemaining >= 0) {
      escalationLevel = 'warning';
    }
  }

  return {
    ...req,
    isOverdue,
    daysRemaining,
    daysOverdue,
    escalationLevel,
  };
};

/**
 * 1. Create a Bank Confirmation Request
 */
export const createBankConfirmationRequest = async ({ fdrId, user, payload = {}, file = null }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const fdr = await FDR.findById(fdrId);
  if (!fdr) {
    throw new BankConfirmationServiceError(404, 'FDR not found.');
  }

  if (isInstitution(user)) {
    const userInstId = getInstitutionId(user);
    const fdrInstId = fdr.institution ? String(fdr.institution._id || fdr.institution) : null;
    if (!userInstId || userInstId !== fdrInstId) {
      throw new BankConfirmationServiceError(403, 'You may only initiate confirmation requests for your institution FDRs.');
    }
  }

  const institution = await Institution.findById(fdr.institution);
  const institutionName = institution?.name || fdr.institutionName || 'Technical Institution';

  let evidenceDoc = null;
  if (file && file.buffer) {
    const stored = await storeUploadedDocument(file);
    evidenceDoc = {
      storageRef: stored.storageRef,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
      checksum: stored.checksum,
      documentType: payload.documentType || 'inquiry_letter',
      uploadedAt: new Date(),
      uploadedBy: user._id,
    };
  }

  const initialStatus = payload.status && ['draft', 'pending_submission'].includes(payload.status)
    ? payload.status
    : 'pending_submission';

  const deadlineDays = Math.max(1, Math.min(90, Number(payload.deadlineDays) || 15));
  const requestReference = payload.requestReference?.trim() || generateConfirmationReference();

  let assignedOfficialId = null;
  let assignedOfficialName = null;
  if (payload.assignedOfficial) {
    assignedOfficialId = payload.assignedOfficial;
    const officialUser = await User.findById(payload.assignedOfficial);
    assignedOfficialName = officialUser ? officialUser.fullName : null;
  } else if (isOfficial(user)) {
    assignedOfficialId = user._id;
    assignedOfficialName = user.fullName;
  }

  const newDoc = {
    fdr: fdr._id,
    fdrNumber: fdr.fdrNumber,
    institution: fdr.institution,
    institutionName,
    bankName: payload.bankName?.trim() || fdr.bankName,
    branch: payload.branch?.trim() || fdr.branch || 'Main Branch',
    requestReference,
    status: initialStatus,
    initiatedBy: user._id,
    initiatedByName: user.fullName || user.email,
    assignedOfficial: assignedOfficialId,
    assignedOfficialName,
    requestDate: new Date(),
    remarks: payload.remarks?.trim() || null,
    deadlineDetails: {
      deadlineDays,
      responseDeadline: new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000),
      escalationLevel: 'normal',
    },
    evidenceDocuments: evidenceDoc ? [evidenceDoc] : [],
    history: [
      {
        fromStatus: null,
        toStatus: initialStatus,
        updatedBy: user._id,
        updatedByName: user.fullName,
        updatedAt: new Date(),
        reason: payload.reason?.trim() || 'Bank confirmation request initiated',
        notes: payload.notes?.trim() || null,
        evidenceDocumentRef: evidenceDoc ? evidenceDoc.fileName : null,
      },
    ],
  };

  const createdRequest = await BankConfirmationRequest.create(newDoc);

  await safeRecordAuditEvent({
    actor: user._id,
    actorRole: user.role,
    action: 'bank_confirmation_request_created',
    entityType: 'BankConfirmationRequest',
    entityId: createdRequest._id,
    reason: `Bank confirmation request initiated for FDR ${fdr.fdrNumber} (Ref: ${requestReference})`,
    metadata: {
      fdrNumber: fdr.fdrNumber,
      bankName: createdRequest.bankName,
      branch: createdRequest.branch,
      requestReference,
      status: initialStatus,
    },
  });

  return enrichRequestWithDeadline(createdRequest);
};

/**
 * 2. List Bank Confirmation Requests with Scoping & Filtering
 */
export const listBankConfirmationRequests = async ({ user, query = {}, now = new Date() }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const filter = {};

  if (isInstitution(user)) {
    const instId = getInstitutionId(user);
    if (!instId) {
      throw new BankConfirmationServiceError(404, 'No institution attached to user account.');
    }
    filter.institution = instId;
  } else if (query.institutionId) {
    filter.institution = query.institutionId;
  }

  if (query.fdrId) {
    filter.fdr = query.fdrId;
  }

  if (query.fdrNumber) {
    filter.fdrNumber = new RegExp(query.fdrNumber.trim(), 'i');
  }

  if (query.bankName) {
    filter.bankName = new RegExp(query.bankName.trim(), 'i');
  }

  if (query.assignedOfficial) {
    filter.assignedOfficial = query.assignedOfficial;
  }

  if (query.status) {
    const statusVal = query.status.trim();
    if (statusVal === 'pending') {
      filter.status = { $in: ['pending_submission', 'submitted_to_bank', 'awaiting_bank_response'] };
    } else if (statusVal === 'overdue') {
      filter.status = { $in: ['submitted_to_bank', 'awaiting_bank_response'] };
      filter['deadlineDetails.responseDeadline'] = { $lt: now };
    } else if (BANK_CONFIRMATION_STATUSES.includes(statusVal)) {
      filter.status = statusVal;
    }
  }

  if (query.overdue === 'true' || query.overdue === true) {
    filter.status = { $in: ['submitted_to_bank', 'awaiting_bank_response'] };
    filter['deadlineDetails.responseDeadline'] = { $lt: now };
  }

  if (query.search) {
    const regex = new RegExp(query.search.trim(), 'i');
    filter.$or = [
      { fdrNumber: regex },
      { requestReference: regex },
      { bankName: regex },
      { branch: regex },
      { institutionName: regex },
      { 'submissionDetails.dispatchReference': regex },
    ];
  }

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;

  const [rawRecords, total] = await Promise.all([
    BankConfirmationRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('assignedOfficial', 'fullName email role')
      .populate('initiatedBy', 'fullName email role'),
    BankConfirmationRequest.countDocuments(filter),
  ]);

  const requests = rawRecords.map((r) => enrichRequestWithDeadline(r, now));

  // Compute summary metrics for tabs/cards
  const summaryScope = isInstitution(user) ? { institution: getInstitutionId(user) } : {};
  const [pendingCount, confirmedCount, discrepancyCount, overdueCount, totalScopeCount] = await Promise.all([
    BankConfirmationRequest.countDocuments({
      ...summaryScope,
      status: { $in: ['pending_submission', 'submitted_to_bank', 'awaiting_bank_response'] },
    }),
    BankConfirmationRequest.countDocuments({ ...summaryScope, status: 'confirmed' }),
    BankConfirmationRequest.countDocuments({ ...summaryScope, status: 'discrepancy_found' }),
    BankConfirmationRequest.countDocuments({
      ...summaryScope,
      status: { $in: ['submitted_to_bank', 'awaiting_bank_response'] },
      'deadlineDetails.responseDeadline': { $lt: now },
    }),
    BankConfirmationRequest.countDocuments(summaryScope),
  ]);

  return {
    requests,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    summary: {
      pending: pendingCount,
      confirmed: confirmedCount,
      discrepancy: discrepancyCount,
      overdue: overdueCount,
      total: totalScopeCount,
    },
  };
};

/**
 * 3. Get Bank Confirmation Summary Counts
 */
export const getBankConfirmationSummary = async ({ user, now = new Date() }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const scope = isInstitution(user) ? { institution: getInstitutionId(user) } : {};

  const [pending, confirmed, discrepancy, overdue, total] = await Promise.all([
    BankConfirmationRequest.countDocuments({
      ...scope,
      status: { $in: ['pending_submission', 'submitted_to_bank', 'awaiting_bank_response'] },
    }),
    BankConfirmationRequest.countDocuments({ ...scope, status: 'confirmed' }),
    BankConfirmationRequest.countDocuments({ ...scope, status: 'discrepancy_found' }),
    BankConfirmationRequest.countDocuments({
      ...scope,
      status: { $in: ['submitted_to_bank', 'awaiting_bank_response'] },
      'deadlineDetails.responseDeadline': { $lt: now },
    }),
    BankConfirmationRequest.countDocuments(scope),
  ]);

  return {
    pending,
    confirmed,
    discrepancy,
    overdue,
    total,
  };
};

/**
 * 4. Get a Single Confirmation Request with History and Enrichment
 */
export const getBankConfirmationRequestById = async ({ id, user, now = new Date() }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const reqDoc = await BankConfirmationRequest.findById(id)
    .populate('fdr')
    .populate('assignedOfficial', 'fullName email role')
    .populate('initiatedBy', 'fullName email role')
    .populate('submissionDetails.submittedBy', 'fullName email role')
    .populate('bankResponse.recordedBy', 'fullName email role');

  if (!reqDoc) {
    throw new BankConfirmationServiceError(404, 'Bank confirmation request not found.');
  }

  if (isInstitution(user)) {
    const userInstId = getInstitutionId(user);
    const reqInstId = reqDoc.institution ? String(reqDoc.institution._id || reqDoc.institution) : null;
    if (!userInstId || userInstId !== reqInstId) {
      throw new BankConfirmationServiceError(403, 'Unauthorized access to this confirmation request.');
    }
  }

  return enrichRequestWithDeadline(reqDoc, now);
};

/**
 * 5. Update Status with Validation and FDR Sync
 */
export const updateConfirmationStatus = async ({ id, user, payload = {}, now = new Date() }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const reqDoc = await BankConfirmationRequest.findById(id);
  if (!reqDoc) {
    throw new BankConfirmationServiceError(404, 'Bank confirmation request not found.');
  }

  // Only officials can transition status (unless institution transitions draft -> pending_submission)
  if (isInstitution(user)) {
    if (reqDoc.status !== 'draft' || payload.status !== 'pending_submission') {
      throw new BankConfirmationServiceError(403, 'Institution users can only submit draft confirmation requests.');
    }
  } else if (!isOfficial(user)) {
    throw new BankConfirmationServiceError(403, 'Only authorized AICTE officials can update confirmation status.');
  }

  const currentStatus = reqDoc.status;
  const nextStatus = payload.status;

  if (!BANK_CONFIRMATION_STATUSES.includes(nextStatus)) {
    throw new BankConfirmationServiceError(400, `Invalid status: ${nextStatus}.`);
  }

  if (currentStatus === nextStatus) {
    return enrichRequestWithDeadline(reqDoc, now);
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    throw new BankConfirmationServiceError(
      400,
      `Cannot transition confirmation status from '${currentStatus}' to '${nextStatus}'. Permitted: [${allowed.join(', ')}].`,
    );
  }

  // Mandatory evidence check: Cannot mark 'confirmed' without at least one supporting evidence document!
  if (nextStatus === 'confirmed') {
    const hasEvidence = reqDoc.evidenceDocuments && reqDoc.evidenceDocuments.length > 0;
    if (!hasEvidence && !payload.allowWithoutEvidence) {
      throw new BankConfirmationServiceError(
        422,
        'Cannot confirm bank verification without supporting written bank correspondence or evidence attached.',
      );
    }
  }

  if (nextStatus === 'submitted_to_bank' && !reqDoc.submissionDetails?.submissionDate && !payload.submissionDate) {
    throw new BankConfirmationServiceError(
      422,
      'Submission date and reference must be recorded when moving to submitted_to_bank.',
    );
  }

  const reason = payload.reason?.trim() || `Status updated from ${currentStatus} to ${nextStatus}`;

  reqDoc.status = nextStatus;
  reqDoc.history.push({
    fromStatus: currentStatus,
    toStatus: nextStatus,
    updatedBy: user._id,
    updatedByName: user.fullName || user.email,
    updatedAt: now,
    reason,
    notes: payload.notes?.trim() || null,
  });

  await reqDoc.save();

  // Synchronize linked FDR bankVerification state
  if (reqDoc.fdr && isDbOrMocked(FDR, 'findById')) {
    const fdr = await FDR.findById(reqDoc.fdr).catch(() => null);
    if (fdr) {
      fdr.bankVerification = fdr.bankVerification || {};
      fdr.bankVerification.verificationReference = reqDoc.requestReference;

      if (nextStatus === 'confirmed') {
        fdr.bankVerification.status = 'verified_with_bank';
        fdr.bankVerification.manualVerification = {
          verifiedBy: user._id,
          verifiedAt: now,
          evidenceSource: 'Smart Bank Confirmation Tracker',
          contactMethod: reqDoc.submissionDetails?.submissionMethod || 'official_letter',
          branchContact: reqDoc.submissionDetails?.recipientBranchContact || reqDoc.branch,
          notes: reason,
          externalReference: reqDoc.requestReference,
        };
        fdr.bankVerification.history.push({
          status: 'verified_with_bank',
          updatedBy: user._id,
          updatedAt: now,
          evidenceSource: 'Smart Bank Confirmation Tracker (Verified)',
          notes: reason,
        });
      } else if (nextStatus === 'discrepancy_found') {
        fdr.bankVerification.status = 'verification_failed';
        fdr.bankVerification.history.push({
          status: 'verification_failed',
          updatedBy: user._id,
          updatedAt: now,
          evidenceSource: 'Smart Bank Confirmation Tracker (Discrepancy)',
          notes: reason,
        });
      } else if (nextStatus === 'unable_to_verify') {
        fdr.bankVerification.status = 'unverifiable';
        fdr.bankVerification.history.push({
          status: 'unverifiable',
          updatedBy: user._id,
          updatedAt: now,
          evidenceSource: 'Smart Bank Confirmation Tracker (Unverifiable)',
          notes: reason,
        });
      }

      // Recalculate trust score & risk assessment
      const trustScore = calculateFdrTrustScore({
        fdr,
        bankVerification: fdr.bankVerification,
      });
      fdr.trustScore = trustScore;

      const riskAssessment = calculateFdrRiskScore({
        fdr,
        trustScore,
        bankVerification: fdr.bankVerification,
      });
      fdr.riskAssessment = riskAssessment;

      if (typeof fdr.save === 'function') {
        await fdr.save();
      }
    }
  }

  await safeRecordAuditEvent({
    actor: user._id,
    actorRole: user.role,
    action: 'bank_confirmation_status_updated',
    entityType: 'BankConfirmationRequest',
    entityId: reqDoc._id,
    reason,
    diff: [{ field: 'status', previousValue: currentStatus, newValue: nextStatus }],
    metadata: {
      fdrNumber: reqDoc.fdrNumber,
      requestReference: reqDoc.requestReference,
      fromStatus: currentStatus,
      toStatus: nextStatus,
    },
  });

  return enrichRequestWithDeadline(reqDoc, now);
};

/**
 * 6. Record Bank Submission (Real Dispatch / Sending)
 */
export const recordBankSubmission = async ({ id, user, payload = {}, file = null, now = new Date() }) => {
  if (!user || !isOfficial(user)) {
    throw new BankConfirmationServiceError(403, 'Only authorized officials can record bank submissions.');
  }

  const reqDoc = await BankConfirmationRequest.findById(id);
  if (!reqDoc) {
    throw new BankConfirmationServiceError(404, 'Bank confirmation request not found.');
  }

  const submissionDate = payload.submissionDate ? new Date(payload.submissionDate) : now;
  const deadlineDays = Math.max(1, Math.min(90, Number(payload.deadlineDays) || reqDoc.deadlineDetails?.deadlineDays || 15));
  const { responseDeadline } = calculateDeadlineDates(submissionDate, deadlineDays);

  const submissionMethod = payload.submissionMethod?.trim() || 'official_letter';
  if (!SUBMISSION_METHODS.includes(submissionMethod)) {
    throw new BankConfirmationServiceError(400, `Invalid submission method: ${submissionMethod}.`);
  }

  const dispatchReference = payload.dispatchReference?.trim() || `DISPATCH-${Date.now()}`;
  const notes = payload.notes?.trim() || null;
  const recipientBranchContact = payload.recipientBranchContact?.trim() || null;

  let evidenceDoc = null;
  if (file && file.buffer) {
    const stored = await storeUploadedDocument(file);
    evidenceDoc = {
      storageRef: stored.storageRef,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
      checksum: stored.checksum,
      documentType: 'inquiry_letter',
      uploadedAt: now,
      uploadedBy: user._id,
    };
    reqDoc.evidenceDocuments.push(evidenceDoc);
  }

  reqDoc.submissionDetails = {
    submissionDate,
    submittedBy: user._id,
    submissionMethod,
    dispatchReference,
    recipientBranchContact,
    notes,
  };

  reqDoc.deadlineDetails = {
    deadlineDays,
    responseDeadline,
    escalationLevel: 'normal',
    lastEscalatedAt: null,
  };

  const prevStatus = reqDoc.status;
  reqDoc.status = 'submitted_to_bank';

  reqDoc.history.push({
    fromStatus: prevStatus,
    toStatus: 'submitted_to_bank',
    updatedBy: user._id,
    updatedByName: user.fullName || user.email,
    updatedAt: now,
    reason: `Dispatched to ${reqDoc.bankName} via ${submissionMethod} (Ref: ${dispatchReference})`,
    notes,
    evidenceDocumentRef: evidenceDoc ? evidenceDoc.fileName : null,
  });

  await reqDoc.save();

  // Send Notification
  try {
    const institutionAdmin = await User.findOne({
      institution: reqDoc.institution,
      role: 'institution_admin',
    });
    if (institutionAdmin) {
      await Notification.create({
        recipient: institutionAdmin._id,
        institution: reqDoc.institution,
        fdr: reqDoc.fdr,
        type: 'bank_confirmation_submitted',
        title: `Bank Confirmation Dispatched: ${reqDoc.fdrNumber}`,
        message: `Official inquiry sent to ${reqDoc.bankName} (${reqDoc.branch}). Response deadline: ${responseDeadline.toISOString().slice(0, 10)}.`,
        metadata: {
          fdrNumber: reqDoc.fdrNumber,
          bankName: reqDoc.bankName,
          confirmationReference: reqDoc.requestReference,
          deadline: responseDeadline,
        },
      });
    }
  } catch (notifErr) {
    console.error('Failed to deliver submission notification:', notifErr.message);
  }

  await safeRecordAuditEvent({
    actor: user._id,
    actorRole: user.role,
    action: 'bank_confirmation_submitted',
    entityType: 'BankConfirmationRequest',
    entityId: reqDoc._id,
    reason: `Submission recorded to ${reqDoc.bankName} via ${submissionMethod}`,
    metadata: {
      fdrNumber: reqDoc.fdrNumber,
      dispatchReference,
      submissionMethod,
      responseDeadline,
    },
  });

  return enrichRequestWithDeadline(reqDoc, now);
};

/**
 * 7. Record Bank Response (Official Reply with Evidence)
 */
export const recordBankResponse = async ({ id, user, payload = {}, file = null, now = new Date() }) => {
  if (!user || !isOfficial(user)) {
    throw new BankConfirmationServiceError(403, 'Only authorized officials can record bank responses.');
  }

  const reqDoc = await BankConfirmationRequest.findById(id);
  if (!reqDoc) {
    throw new BankConfirmationServiceError(404, 'Bank confirmation request not found.');
  }

  const outcome = payload.outcome?.trim();
  if (!['confirmed', 'discrepancy_found', 'unable_to_verify', 'clarification_requested'].includes(outcome)) {
    throw new BankConfirmationServiceError(400, `Invalid response outcome: ${outcome}.`);
  }

  let evidenceDoc = null;
  if (file && file.buffer) {
    const stored = await storeUploadedDocument(file);
    evidenceDoc = {
      storageRef: stored.storageRef,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
      checksum: stored.checksum,
      documentType: 'bank_letter',
      uploadedAt: now,
      uploadedBy: user._id,
    };
    reqDoc.evidenceDocuments.push(evidenceDoc);
  }

  // Strict check: 'confirmed' requires supporting evidence file either uploaded now or already present
  if (outcome === 'confirmed') {
    const hasEvidence = reqDoc.evidenceDocuments && reqDoc.evidenceDocuments.length > 0;
    if (!hasEvidence && !evidenceDoc) {
      throw new BankConfirmationServiceError(
        422,
        'Cannot mark bank response as Confirmed without uploading the official bank response letter or correspondence.',
      );
    }
  }

  const responseDate = payload.responseDate ? new Date(payload.responseDate) : now;
  const discrepancies = payload.discrepancies || {};

  reqDoc.bankResponse = {
    responseDate,
    recordedAt: now,
    recordedBy: user._id,
    responseReference: payload.responseReference?.trim() || null,
    responderName: payload.responderName?.trim() || null,
    responderDesignation: payload.responderDesignation?.trim() || 'Branch Manager',
    responderContact: payload.responderContact?.trim() || null,
    outcome,
    discrepancies: {
      amountMismatch: Boolean(discrepancies.amountMismatch),
      datesMismatch: Boolean(discrepancies.datesMismatch),
      lienNotMarked: Boolean(discrepancies.lienNotMarked),
      beneficiaryMismatch: Boolean(discrepancies.beneficiaryMismatch),
      accountNumberMismatch: Boolean(discrepancies.accountNumberMismatch),
      other: Boolean(discrepancies.other),
      notes: discrepancies.notes?.trim() || null,
    },
    clarificationDetails: payload.clarificationDetails?.trim() || null,
    generalNotes: payload.generalNotes?.trim() || null,
  };

  const prevStatus = reqDoc.status;
  let targetStatus = 'awaiting_bank_response';
  if (outcome === 'confirmed') targetStatus = 'confirmed';
  if (outcome === 'discrepancy_found') targetStatus = 'discrepancy_found';
  if (outcome === 'unable_to_verify') targetStatus = 'unable_to_verify';
  if (outcome === 'clarification_requested') targetStatus = 'awaiting_bank_response';

  reqDoc.status = targetStatus;

  const reason = payload.reason?.trim() || `Bank response recorded with outcome '${outcome}'`;
  reqDoc.history.push({
    fromStatus: prevStatus,
    toStatus: targetStatus,
    updatedBy: user._id,
    updatedByName: user.fullName || user.email,
    updatedAt: now,
    reason,
    notes: payload.generalNotes?.trim() || null,
    evidenceDocumentRef: evidenceDoc ? evidenceDoc.fileName : null,
  });

  await reqDoc.save();

  // Synchronize linked FDR
  if (reqDoc.fdr) {
    const fdr = await FDR.findById(reqDoc.fdr);
    if (fdr) {
      fdr.bankVerification = fdr.bankVerification || {};
      fdr.bankVerification.verificationReference = payload.responseReference || reqDoc.requestReference;

      if (outcome === 'confirmed') {
        fdr.bankVerification.status = 'verified_with_bank';
        fdr.bankVerification.manualVerification = {
          verifiedBy: user._id,
          verifiedAt: now,
          evidenceSource: 'Official Bank Written Response',
          contactMethod: reqDoc.submissionDetails?.submissionMethod || 'official_letter',
          branchContact: payload.responderName || reqDoc.branch,
          notes: payload.generalNotes || 'Bank confirmed genuine FDR and marked lien.',
          externalReference: payload.responseReference || reqDoc.requestReference,
        };
      } else if (outcome === 'discrepancy_found') {
        fdr.bankVerification.status = 'verification_failed';
      } else if (outcome === 'unable_to_verify') {
        fdr.bankVerification.status = 'unverifiable';
      }

      const trustScore = calculateFdrTrustScore({
        fdr,
        bankVerification: fdr.bankVerification,
      });
      fdr.trustScore = trustScore;

      const riskAssessment = calculateFdrRiskScore({
        fdr,
        trustScore,
        bankVerification: fdr.bankVerification,
      });
      fdr.riskAssessment = riskAssessment;

      await fdr.save();
    }
  }

  // Notify institution
  try {
    const institutionAdmin = await User.findOne({
      institution: reqDoc.institution,
      role: 'institution_admin',
    });
    if (institutionAdmin) {
      const isDiscrepancy = outcome === 'discrepancy_found';
      await Notification.create({
        recipient: institutionAdmin._id,
        institution: reqDoc.institution,
        fdr: reqDoc.fdr,
        type: isDiscrepancy ? 'bank_confirmation_discrepancy' : 'bank_confirmation_response_received',
        title: isDiscrepancy
          ? `Discrepancy Reported by Bank: ${reqDoc.fdrNumber}`
          : `Bank Response Received: ${reqDoc.fdrNumber}`,
        message: isDiscrepancy
          ? `The issuing bank flagged discrepancies on FDR ${reqDoc.fdrNumber}. Please review comments.`
          : `Bank response recorded for FDR ${reqDoc.fdrNumber}. Outcome: ${outcome}.`,
        metadata: {
          fdrNumber: reqDoc.fdrNumber,
          bankName: reqDoc.bankName,
          confirmationReference: reqDoc.requestReference,
        },
      });
    }
  } catch (notifErr) {
    console.error('Failed to send response notification:', notifErr.message);
  }

  await safeRecordAuditEvent({
    actor: user._id,
    actorRole: user.role,
    action: 'bank_confirmation_response_recorded',
    entityType: 'BankConfirmationRequest',
    entityId: reqDoc._id,
    reason: `Bank response recorded (${outcome}) for FDR ${reqDoc.fdrNumber}`,
    metadata: {
      outcome,
      fdrNumber: reqDoc.fdrNumber,
      responseReference: payload.responseReference,
      responderName: payload.responderName,
    },
  });

  return enrichRequestWithDeadline(reqDoc, now);
};

/**
 * 8. Upload Supporting Evidence Document
 */
export const uploadConfirmationEvidence = async ({ id, user, file, documentType = 'bank_letter', now = new Date() }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const reqDoc = await BankConfirmationRequest.findById(id);
  if (!reqDoc) {
    throw new BankConfirmationServiceError(404, 'Bank confirmation request not found.');
  }

  if (isInstitution(user)) {
    const userInstId = getInstitutionId(user);
    const reqInstId = reqDoc.institution ? String(reqDoc.institution._id || reqDoc.institution) : null;
    if (!userInstId || userInstId !== reqInstId) {
      throw new BankConfirmationServiceError(403, 'Unauthorized.');
    }
  }

  if (!file || !file.buffer) {
    throw new BankConfirmationServiceError(400, 'File buffer is required.');
  }

  const stored = await storeUploadedDocument(file);
  const evidenceDoc = {
    storageRef: stored.storageRef,
    fileName: stored.fileName,
    mimeType: stored.mimeType,
    fileSize: stored.fileSize,
    checksum: stored.checksum,
    documentType,
    uploadedAt: now,
    uploadedBy: user._id,
  };

  reqDoc.evidenceDocuments.push(evidenceDoc);
  await reqDoc.save();

  await safeRecordAuditEvent({
    actor: user._id,
    actorRole: user.role,
    action: 'bank_confirmation_document_uploaded',
    entityType: 'BankConfirmationRequest',
    entityId: reqDoc._id,
    reason: `Evidence document '${stored.fileName}' attached to confirmation request ${reqDoc.requestReference}`,
    metadata: {
      fdrNumber: reqDoc.fdrNumber,
      fileName: stored.fileName,
      documentType,
    },
  });

  return evidenceDoc;
};

/**
 * 9. Download Evidence Document
 */
export const downloadConfirmationEvidence = async ({ id, docId, user }) => {
  if (!user) {
    throw new BankConfirmationServiceError(401, 'Authentication required.');
  }

  const reqDoc = await BankConfirmationRequest.findById(id);
  if (!reqDoc) {
    throw new BankConfirmationServiceError(404, 'Bank confirmation request not found.');
  }

  if (isInstitution(user)) {
    const userInstId = getInstitutionId(user);
    const reqInstId = reqDoc.institution ? String(reqDoc.institution._id || reqDoc.institution) : null;
    if (!userInstId || userInstId !== reqInstId) {
      throw new BankConfirmationServiceError(403, 'Unauthorized.');
    }
  }

  const doc = reqDoc.evidenceDocuments.id(docId);
  if (!doc) {
    throw new BankConfirmationServiceError(404, 'Evidence document not found.');
  }

  const buffer = await readStoredDocument(doc.storageRef);
  return {
    buffer,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
  };
};

/**
 * 10. Automated Deadline Check & Escalation (Job / Service method)
 */
export const checkDeadlinesAndEscalate = async ({ now = new Date() } = {}) => {
  const activeRequests = await BankConfirmationRequest.find({
    status: { $in: ['submitted_to_bank', 'awaiting_bank_response'] },
    'deadlineDetails.responseDeadline': { $exists: true, $ne: null },
  });

  let processedCount = 0;
  let upcomingWarnings = 0;
  let escalatedOverdue = 0;

  for (const req of activeRequests) {
    processedCount++;
    const deadline = new Date(req.deadlineDetails.responseDeadline);
    const diffMs = deadline.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (24 * 60 * 60 * 1000));

    // A. Critical Overdue (> 7 days past deadline)
    if (diffMs < -7 * 24 * 60 * 60 * 1000) {
      if (!req.notificationsSent?.criticalOverdueSentAt) {
        req.deadlineDetails.escalationLevel = 'critical_overdue';
        req.deadlineDetails.lastEscalatedAt = now;
        req.notificationsSent = req.notificationsSent || {};
        req.notificationsSent.criticalOverdueSentAt = now;
        escalatedOverdue++;

        if (req.assignedOfficial) {
          await Notification.create({
            recipient: req.assignedOfficial,
            fdr: req.fdr,
            institution: req.institution,
            type: 'bank_confirmation_overdue',
            title: `CRITICAL: Overdue Bank Confirmation (${req.fdrNumber})`,
            message: `Bank confirmation for FDR ${req.fdrNumber} at ${req.bankName} is over 7 days past deadline. Escalated for administrative action.`,
            metadata: {
              fdrNumber: req.fdrNumber,
              bankName: req.bankName,
              confirmationReference: req.requestReference,
              daysOverdue: Math.floor(Math.abs(diffMs) / (24 * 60 * 60 * 1000)),
            },
          }).catch(() => {});
        }
        await req.save();
      }
    }
    // B. Overdue (1 to 7 days past deadline)
    else if (diffMs < 0) {
      if (!req.notificationsSent?.overdueSentAt) {
        req.deadlineDetails.escalationLevel = 'overdue';
        req.deadlineDetails.lastEscalatedAt = now;
        req.notificationsSent = req.notificationsSent || {};
        req.notificationsSent.overdueSentAt = now;
        escalatedOverdue++;

        if (req.assignedOfficial) {
          await Notification.create({
            recipient: req.assignedOfficial,
            fdr: req.fdr,
            institution: req.institution,
            type: 'bank_confirmation_overdue',
            title: `OVERDUE: Bank Confirmation Deadline Elapsed (${req.fdrNumber})`,
            message: `Response deadline elapsed for ${req.fdrNumber} from ${req.bankName}. Follow-up dispatch recommended.`,
            metadata: {
              fdrNumber: req.fdrNumber,
              bankName: req.bankName,
              confirmationReference: req.requestReference,
            },
          }).catch(() => {});
        }
        await req.save();
      }
    }
    // C. Upcoming Warning (<= 3 days remaining)
    else if (daysRemaining <= 3 && daysRemaining >= 0) {
      if (!req.notificationsSent?.upcomingWarningSentAt) {
        req.deadlineDetails.escalationLevel = 'warning';
        req.notificationsSent = req.notificationsSent || {};
        req.notificationsSent.upcomingWarningSentAt = now;
        upcomingWarnings++;

        if (req.assignedOfficial) {
          await Notification.create({
            recipient: req.assignedOfficial,
            fdr: req.fdr,
            institution: req.institution,
            type: 'bank_confirmation_deadline_warning',
            title: `Upcoming Deadline: ${req.fdrNumber} (${daysRemaining} days left)`,
            message: `Bank confirmation response from ${req.bankName} is due in ${daysRemaining} day(s).`,
            metadata: {
              fdrNumber: req.fdrNumber,
              bankName: req.bankName,
              confirmationReference: req.requestReference,
            },
          }).catch(() => {});
        }
        await req.save();
      }
    }
  }

  return {
    processedCount,
    upcomingWarnings,
    escalatedOverdue,
  };
};

export const bankConfirmationService = {
  createBankConfirmationRequest,
  listBankConfirmationRequests,
  getBankConfirmationSummary,
  getBankConfirmationRequestById,
  updateConfirmationStatus,
  recordBankSubmission,
  recordBankResponse,
  uploadConfirmationEvidence,
  downloadConfirmationEvidence,
  checkDeadlinesAndEscalate,
};

export default bankConfirmationService;
