import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import ForensicAnalysis from '../models/ForensicAnalysis.js';
import Institution from '../models/Institution.js';
import ReleaseRequest from '../models/ReleaseRequest.js';
import User from '../models/User.js';
import { deleteStoredDocument, storeUploadedDocument } from './document-storage.service.js';
import { getFdrById, serializeFdr } from './fdr.service.js';

const officialRoles = new Set(['aicte_admin', 'reviewer']);
const institutionRoles = new Set(['institution_admin', 'institution_user']);

export class FdrWorkflowError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const requireOfficial = (user) => {
  if (!officialRoles.has(user?.role)) {
    throw new FdrWorkflowError(403, 'forbidden', 'Only authorized AICTE officials may perform this action.');
  }
};

const getInstitutionId = (user) => {
  const institutionId = user?.institution?._id || user?.institution;
  return institutionId ? String(institutionId) : null;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withSession = async (operation) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => operation(session));
  } finally {
    await session.endSession();
  }
};

const writeAudit = ({ actor, action, entityId, metadata }) =>
  new AuditLog({ actor, action, entityType: 'FDR', entityId, metadata });

const safeFdrSummary = (record) => ({
  id: String(record._id),
  fdrNumber: record.fdrNumber,
  bankName: record.bankName,
  branch: record.branch,
  amount: record.amount,
  currency: record.currency,
  issueDate: record.issueDate,
  maturityDate: record.maturityDate,
  workflowStatus: record.workflowStatus,
  financialStatus: record.financialStatus,
  createdAt: record.createdAt,
  submittedAt: record.submittedAt || record.createdAt,
});

export const listFdrReviewQueue = async ({ user, query }) => {
  requireOfficial(user);
  const filter = {};
  if (query.workflowStatus) filter.workflowStatus = query.workflowStatus;
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const institutions = await Institution.find({
      $or: [{ name: pattern }, { institutionCode: pattern }],
    }).select('_id');
    filter.$or = [
      { fdrNumber: pattern },
      { institution: { $in: institutions.map(({ _id }) => _id) } },
    ];
  }

  const [total, records] = await Promise.all([
    FDR.countDocuments(filter),
    FDR.find(filter)
      .select('institution fdrNumber bankName branch amount currency issueDate maturityDate workflowStatus submittedAt createdAt')
      .populate('institution', 'name institutionCode')
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);
  return {
    records: records.map((record) => ({
      ...safeFdrSummary(record),
      institution: record.institution
        ? {
            id: String(record.institution._id || record.institution),
            name: record.institution.name || null,
            institutionCode: record.institution.institutionCode || null,
          }
        : null,
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
};

const safeForensicSummary = (report) => report && ({
  analysisId: String(report._id),
  checksum: report.checksum || null,
  engine: report.engine,
  analysisVersion: report.analysisVersion,
  status: report.status,
  findings: report.findings,
  analyzedAt: report.analyzedAt,
});

export const getFdrReviewDetails = async ({ user, fdrId }) => {
  requireOfficial(user);
  const fdr = await getFdrById({ user, fdrId });
  const [institution, forensic, replacements, original, releaseRequests, reviewActors] = await Promise.all([
    Institution.findById(fdr.institution).select('name institutionCode contactEmail contactPhone address status'),
    ForensicAnalysis.findOne({ fdrId: fdr._id }).sort({ analyzedAt: -1, _id: -1 }),
    FDR.find({ replacesFdr: fdr._id })
      .select('fdrNumber workflowStatus issueDate maturityDate createdAt')
      .sort({ createdAt: -1, _id: -1 }),
    fdr.replacesFdr
      ? FDR.findById(fdr.replacesFdr).select('fdrNumber workflowStatus issueDate maturityDate')
      : Promise.resolve(null),
    ReleaseRequest.find({ fdrId: fdr._id })
      .select('status reason createdAt updatedAt history')
      .sort({ createdAt: -1, _id: -1 }),
    fdr.reviewHistory?.length
      ? User.find({ _id: { $in: fdr.reviewHistory.map(({ actor }) => actor) } }).select('fullName role')
      : Promise.resolve([]),
  ]);
  const actorsById = new Map(reviewActors.map((actor) => [String(actor._id), actor]));
  return {
    institution: institution && {
      id: String(institution._id),
      name: institution.name,
      institutionCode: institution.institutionCode,
      status: institution.status,
    },
    fdr: {
      ...safeFdrSummary(fdr),
      institutionSubmitted: {
        fdrNumber: fdr.fdrNumber,
        bankName: fdr.bankName,
        branch: fdr.branch,
        amount: fdr.amount,
        currency: fdr.currency,
        issueDate: fdr.issueDate,
        maturityDate: fdr.maturityDate,
      },
      document: {
        fileName: fdr.documentMetadata?.fileName || null,
        mimeType: fdr.documentMetadata?.mimeType || null,
        fileSize: fdr.documentMetadata?.fileSize ?? null,
        checksum: fdr.documentMetadata?.checksum || null,
        uploadedAt: fdr.documentMetadata?.uploadedAt || null,
        downloadEndpoint: `/api/fdrs/${fdr._id}/document`,
      },
      ocr: {
        status: fdr.ocrResult?.status || 'not_started',
        extractedFields: ['completed', 'partially_completed'].includes(fdr.ocrResult?.status)
          ? fdr.ocrResult.extractedData
          : null,
        comparisons: ['completed', 'partially_completed'].includes(fdr.ocrResult?.status)
          ? fdr.ocrResult.comparisonResults
          : null,
      },
      forensic: safeForensicSummary(forensic),
      reviewerConfirmedDetails: fdr.reviewerConfirmedDetails || {},
      reviewHistory: (fdr.reviewHistory || []).map((entry) => {
        const actor = actorsById.get(String(entry.actor));
        return {
          id: String(entry._id),
          actor: actor ? { id: String(actor._id), fullName: actor.fullName, role: actor.role } : null,
          decision: entry.decision,
          reason: entry.reason,
          previousStatus: entry.previousStatus,
          nextStatus: entry.nextStatus,
          timestamp: entry.timestamp,
        };
      }),
      replacements: replacements.map((record) => ({
        id: String(record._id),
        fdrNumber: record.fdrNumber,
        workflowStatus: record.workflowStatus,
        issueDate: record.issueDate,
        maturityDate: record.maturityDate,
        createdAt: record.createdAt,
      })),
      replacementOf: original && {
        id: String(original._id),
        fdrNumber: original.fdrNumber,
        workflowStatus: original.workflowStatus,
        issueDate: original.issueDate,
        maturityDate: original.maturityDate,
      },
      releaseRequests: releaseRequests.map((request) => ({
        id: String(request._id),
        status: request.status,
        reason: request.reason,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      })),
    },
  };
};

const reviewTransitions = {
  request_correction: { from: ['submitted', 'under_review'], to: 'correction_requested' },
  reject_submission: { from: ['submitted', 'under_review'], to: 'rejected' },
  complete_review: { from: ['submitted', 'under_review'], to: 'review_completed' },
};

export const decideFdrReview = async ({ user, fdrId, decision, reason }) => {
  requireOfficial(user);
  const transition = reviewTransitions[decision];
  if (!transition) throw new FdrWorkflowError(400, 'invalid_decision', 'The review decision is not supported.');
  let updatedFdr;
  const timestamp = new Date();
  await withSession(async (session) => {
    const fdr = await FDR.findById(fdrId).session(session);
    if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');
    const previousStatus = fdr.workflowStatus;
    if (!transition.from.includes(previousStatus)) {
      throw new FdrWorkflowError(409, 'invalid_transition', `A review decision cannot be applied while the FDR is "${previousStatus}".`);
    }

    fdr.workflowStatus = transition.to;
    fdr.reviewer = user._id;
    fdr.reviewHistory.push({
      actor: user._id,
      actorRole: user.role,
      decision,
      reason,
      previousStatus,
      nextStatus: transition.to,
      timestamp,
    });
    await fdr.save({ session });
    await writeAudit({
      actor: user._id,
      action: 'fdr_review_decided',
      entityId: fdr._id,
      metadata: { decision, reason, previousStatus, nextStatus: transition.to, timestamp },
    }).save({ session });
    updatedFdr = fdr;
  });
  return {
    fdr: safeFdrSummary(updatedFdr),
    decision: updatedFdr.reviewHistory.at(-1),
  };
};

const cleanupStoredFile = async (storageKey) => {
  try {
    await deleteStoredDocument(storageKey);
  } catch (error) {
    console.error('Failed to clean up private FDR replacement upload:', error.name || 'Error');
  }
};

export const createFdrRenewal = async ({ user, fdrId, payload, file }) => {
  if (!institutionRoles.has(user?.role)) {
    throw new FdrWorkflowError(403, 'forbidden', 'Only institution users may submit an FDR replacement.');
  }
  const original = await getFdrById({ user, fdrId });
  if (['released', 'expired'].includes(original.workflowStatus) || original.financialStatus === 'cancelled') {
    throw new FdrWorkflowError(409, 'invalid_renewal_state', 'This FDR is not eligible for a replacement submission.');
  }

  let document;
  try {
    document = await storeUploadedDocument(file);
  } catch (error) {
    throw new FdrWorkflowError(400, 'invalid_document', error.message || 'The replacement document is invalid.');
  }

  let replacement;
  try {
    await withSession(async (session) => {
      const existing = await FDR.findOne({ replacesFdr: original._id, workflowStatus: { $in: ['submitted', 'under_review', 'review_completed', 'approved'] } }).session(session);
      if (existing) {
        throw new FdrWorkflowError(409, 'replacement_exists', 'A replacement record already exists for this FDR.');
      }
      replacement = new FDR({
        institution: original.institution,
        ...payload,
        workflowStatus: 'submitted',
        submittedAt: document.uploadedAt,
        replacesFdr: original._id,
        documentMetadata: {
          storageRef: document.storageKey,
          fileName: document.fileName,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
          checksum: document.checksum,
          uploadedAt: document.uploadedAt,
        },
      });
      await replacement.save({ session });
      await writeAudit({
        actor: user._id,
        action: 'fdr_replacement_submitted',
        entityId: replacement._id,
        metadata: {
          originalFdrId: String(original._id),
          previousStatus: null,
          nextStatus: replacement.workflowStatus,
          submittedAt: document.uploadedAt,
        },
      }).save({ session });
    });
  } catch (error) {
    await cleanupStoredFile(document.storageKey);
    if (error.code === 11000) {
      throw new FdrWorkflowError(409, 'replacement_exists', 'A replacement record already exists for this FDR.');
    }
    throw error;
  }
  return { original: serializeFdr(original), replacement: serializeFdr(replacement) };
};

const serializeReleaseRequest = (request) => ({
  id: String(request._id),
  fdrId: request.fdrId?._id
    ? { id: String(request.fdrId._id), fdrNumber: request.fdrId.fdrNumber }
    : String(request.fdrId),
  institution: request.institution?._id
    ? { id: String(request.institution._id), name: request.institution.name, institutionCode: request.institution.institutionCode }
    : String(request.institution),
  reason: request.reason,
  status: request.status,
  history: (request.history || []).map((entry) => ({
    id: String(entry._id),
    actor: String(entry.actor),
    actorRole: entry.actorRole,
    decision: entry.decision,
    reason: entry.reason,
    previousStatus: entry.previousStatus,
    nextStatus: entry.nextStatus,
    timestamp: entry.timestamp,
  })),
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

export const createReleaseRequest = async ({ user, fdrId, reason }) => {
  if (!institutionRoles.has(user?.role)) {
    throw new FdrWorkflowError(403, 'forbidden', 'Only institution users may submit a release request.');
  }
  const fdr = await getFdrById({ user, fdrId });
  const requestId = new mongoose.Types.ObjectId();
  let result;
  let previousRequestStatus = 'new';
  await withSession(async (session) => {
    const current = await ReleaseRequest.findOne({ fdrId: fdr._id, active: true }).session(session);
    const timestamp = new Date();
    if (current?.status === 'submitted') {
      throw new FdrWorkflowError(409, 'request_already_pending', 'A release request is already awaiting review.');
    }
    if (current?.status === 'information_requested') {
      const previousStatus = current.status;
      previousRequestStatus = previousStatus;
      current.reason = reason;
      current.status = 'submitted';
      current.history.push({
        actor: user._id,
        actorRole: user.role,
        decision: 'resubmit_request',
        reason,
        previousStatus,
        nextStatus: 'submitted',
        timestamp,
      });
      await current.save({ session });
      result = current;
    } else {
      result = new ReleaseRequest({
        _id: requestId,
        fdrId: fdr._id,
        institution: fdr.institution,
        requestedBy: user._id,
        reason,
        status: 'submitted',
        active: true,
        history: [{
          actor: user._id,
          actorRole: user.role,
          decision: 'submit_request',
          reason,
          previousStatus: 'new',
          nextStatus: 'submitted',
          timestamp,
        }],
      });
      await result.save({ session });
    }
    await writeAudit({
      actor: user._id,
      action: current ? 'fdr_release_request_resubmitted' : 'fdr_release_request_submitted',
      entityId: fdr._id,
      metadata: {
        requestId: String(result._id),
        previousStatus: previousRequestStatus,
        nextStatus: 'submitted',
      },
    }).save({ session });
  });
  return serializeReleaseRequest(result);
};

export const listReleaseRequests = async ({ user, query }) => {
  requireOfficial(user);
  const filter = query.status ? { status: query.status } : {};
  const [total, records] = await Promise.all([
    ReleaseRequest.countDocuments(filter),
    ReleaseRequest.find(filter)
      .select('fdrId institution requestedBy reason status createdAt updatedAt')
      .populate('fdrId', 'fdrNumber amount currency workflowStatus maturityDate')
      .populate('institution', 'name institutionCode')
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);
  return {
    requests: records.map((record) => ({
      id: String(record._id),
      status: record.status,
      reason: record.reason,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      fdr: record.fdrId && {
        id: String(record.fdrId._id || record.fdrId),
        fdrNumber: record.fdrId.fdrNumber,
        amount: record.fdrId.amount,
        currency: record.fdrId.currency,
        workflowStatus: record.fdrId.workflowStatus,
        maturityDate: record.fdrId.maturityDate,
      },
      institution: record.institution && {
        id: String(record.institution._id || record.institution),
        name: record.institution.name,
        institutionCode: record.institution.institutionCode,
      },
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
};

export const getReleaseRequest = async ({ user, requestId }) => {
  requireOfficial(user);
  const request = await ReleaseRequest.findById(requestId)
    .populate('fdrId', 'fdrNumber amount currency workflowStatus maturityDate')
    .populate('institution', 'name institutionCode');
  if (!request) throw new FdrWorkflowError(404, 'request_not_found', 'Release request not found.');
  return serializeReleaseRequest(request);
};

const releaseTransitions = {
  request_information: { from: 'submitted', to: 'information_requested' },
  approve_request: { from: 'submitted', to: 'approved' },
  reject_request: { from: 'submitted', to: 'rejected' },
};

export const decideReleaseRequest = async ({ user, requestId, decision, reason }) => {
  requireOfficial(user);
  let updated;
  await withSession(async (session) => {
    const request = await ReleaseRequest.findById(requestId).session(session);
    if (!request) throw new FdrWorkflowError(404, 'request_not_found', 'Release request not found.');
    const transition = releaseTransitions[decision];
    if (!transition) throw new FdrWorkflowError(400, 'invalid_decision', 'The release decision is not supported.');
    if (request.status !== transition.from) {
      throw new FdrWorkflowError(409, 'invalid_transition', `A decision cannot be applied while the request is "${request.status}".`);
    }
    if (decision === 'approve_request') {
      const fdr = await FDR.findById(request.fdrId).session(session);
      if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'The linked FDR was not found.');
      if (!['review_completed', 'approved'].includes(fdr.workflowStatus) && fdr.financialStatus !== 'matured') {
        throw new FdrWorkflowError(
          409,
          'release_not_eligible',
          'The linked FDR must complete administrative review or reach maturity before this request can be approved.',
        );
      }
    }
    const previousStatus = request.status;
    const timestamp = new Date();
    request.status = transition.to;
    if (transition.to === 'approved' || transition.to === 'rejected') {
      request.active = false;
    }
    request.history.push({
      actor: user._id,
      actorRole: user.role,
      decision,
      reason,
      previousStatus,
      nextStatus: transition.to,
      timestamp,
    });
    await request.save({ session });
    await writeAudit({
      actor: user._id,
      action: 'fdr_release_request_decided',
      entityId: request.fdrId,
      metadata: {
        requestId: String(request._id),
        decision,
        reason,
        previousStatus,
        nextStatus: transition.to,
        timestamp,
      },
    }).save({ session });
    updated = request;
  });
  return serializeReleaseRequest(updated);
};
