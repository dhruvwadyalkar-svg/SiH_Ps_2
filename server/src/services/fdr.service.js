import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import {
  deleteStoredDocument,
  readDocumentStream,
  storeUploadedDocument,
} from './document-storage.service.js';
import { calculateFdrTrustScore } from './fdr-trust-score.service.js';
import {
  detectFdrDuplicates,
  sanitizeDuplicateCheckForUser,
} from './duplicate-detection.service.js';
import { scanDocumentForQrCode } from './bank-verification.service.js';

export class FdrServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const institutionRoles = new Set(['institution_admin', 'institution_user']);

const getInstitutionId = (user) => {
  if (!user?.institution) return null;
  const institutionId = user.institution._id || user.institution;
  return String(institutionId);
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const writeAuditEvent = ({ actor, action, entityId, metadata }) =>
  new AuditLog({
    actor,
    action,
    entityType: 'FDR',
    entityId,
    metadata,
  });

const removeUploadedFileAfterFailure = async (storageKey) => {
  try {
    await deleteStoredDocument(storageKey);
  } catch (error) {
    console.error('Failed to clean up private FDR upload:', error.name || 'Error');
  }
};

const sanitizeDocumentMetadata = (metadata = {}) => ({
  fileName: metadata.fileName || null,
  mimeType: metadata.mimeType || null,
  fileSize: metadata.fileSize ?? null,
  checksum: metadata.checksum || null,
  uploadedAt: metadata.uploadedAt || null,
});

export const serializeFdr = (fdr) => ({
  id: String(fdr._id),
  institution: fdr.institution ? String(fdr.institution._id || fdr.institution) : null,
  fdrNumber: fdr.fdrNumber,
  bankName: fdr.bankName,
  branch: fdr.branch,
  amount: fdr.amount,
  currency: fdr.currency,
  issueDate: fdr.issueDate,
  maturityDate: fdr.maturityDate,
  workflowStatus: fdr.workflowStatus,
  financialStatus: fdr.financialStatus,
  documentMetadata: sanitizeDocumentMetadata(fdr.documentMetadata),
  trustScore: fdr.trustScore ? {
    score: fdr.trustScore.score ?? null,
    category: fdr.trustScore.category || null,
    evidenceCoverage: fdr.trustScore.evidenceCoverage ?? 0,
    version: fdr.trustScore.version || '1.0.0',
    calculatedAt: fdr.trustScore.calculatedAt || null,
    summary: fdr.trustScore.summary || null,
    signals: fdr.trustScore.signals || [],
    positiveFindings: fdr.trustScore.positiveFindings || [],
    riskFindings: fdr.trustScore.riskFindings || [],
    missingData: fdr.trustScore.missingData || [],
    unavailableChecks: fdr.trustScore.unavailableChecks || [],
  } : null,
  bankVerification: fdr.bankVerification ? {
    status: fdr.bankVerification.status || 'pending',
    verificationReference: fdr.bankVerification.verificationReference || null,
    qrCode: fdr.bankVerification.qrCode ? {
      detected: Boolean(fdr.bankVerification.qrCode.detected),
      candidateUrl: fdr.bankVerification.qrCode.candidateUrl || null,
      extractedReference: fdr.bankVerification.qrCode.extractedReference || null,
      isUntrustedDestination: Boolean(fdr.bankVerification.qrCode.isUntrustedDestination),
      pageNumber: fdr.bankVerification.qrCode.pageNumber || 1,
      location: fdr.bankVerification.qrCode.location || null,
      inspectedAt: fdr.bankVerification.qrCode.inspectedAt || null,
    } : null,
    manualVerification: fdr.bankVerification.manualVerification || null,
    checklist: fdr.bankVerification.checklist || [],
  } : null,
  duplicateCheck: fdr.duplicateCheck ? sanitizeDuplicateCheckForUser({
    duplicateCheck: fdr.duplicateCheck,
    user: null,
    fdrInstitutionId: fdr.institution,
  }) : null,
  maturityEscalation: fdr.maturityEscalation ? {
    currentStage: fdr.maturityEscalation.currentStage || 'not_due',
    lastEscalatedAt: fdr.maturityEscalation.lastEscalatedAt || null,
  } : null,
  createdAt: fdr.createdAt,
  updatedAt: fdr.updatedAt,
});

export const createFdrRecord = async ({ user, payload, file }) => {
  if (!institutionRoles.has(user.role)) {
    throw new FdrServiceError(403, 'You are not authorized to create FDR records.');
  }

  const institutionId = getInstitutionId(user);
  if (!institutionId) {
    throw new FdrServiceError(404, 'No institution is associated with this user.');
  }

  const institution = await Institution.findById(institutionId);
  if (!institution) {
    throw new FdrServiceError(404, 'Institution not found.');
  }

  let documentInfo;
  try {
    documentInfo = await storeUploadedDocument(file);
  } catch (error) {
    throw new FdrServiceError(400, error.message || 'The uploaded document is invalid.');
  }

  // Scan QR code in uploaded file buffer if feasible
  let qrResult = null;
  try {
    qrResult = await scanDocumentForQrCode(file.buffer, documentInfo.mimeType);
  } catch {
    // Graceful QR inspection fallback
  }

  let session;
  let createdFdr;

  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const record = new FDR({
        institution: institution._id,
        ...payload,
        workflowStatus: 'submitted',
        submittedAt: new Date(),
        documentMetadata: {
          storageRef: documentInfo.storageKey,
          fileName: documentInfo.fileName,
          mimeType: documentInfo.mimeType,
          fileSize: documentInfo.fileSize,
          checksum: documentInfo.checksum,
          uploadedAt: documentInfo.uploadedAt,
        },
        bankVerification: {
          status: 'pending',
          qrCode: {
            detected: Boolean(qrResult?.detected),
            decodedText: qrResult?.decodedText || null,
            extractedReference: qrResult?.extractedReference || null,
            candidateUrl: qrResult?.candidateUrl || null,
            isUntrustedDestination: Boolean(qrResult?.isUntrustedDestination),
            pageNumber: qrResult?.pageNumber || 1,
            location: qrResult?.location || null,
            inspectedAt: new Date(),
          },
        },
      });

      // Duplicate check across existing repository
      let duplicateResult = null;
      try {
        duplicateResult = await detectFdrDuplicates({ fdrId: record._id, fdrRecord: record });
        record.duplicateCheck = duplicateResult;
      } catch {
        // safe fallback
      }

      // Initial Trust Score assessment
      const trustScoreResult = calculateFdrTrustScore({
        fdr: record,
        forensicAnalysis: null,
        duplicateResult,
        bankVerification: record.bankVerification,
        trigger: 'initial_creation',
      });
      record.trustScore = trustScoreResult;
      record.trustScoreHistory = [
        {
          score: trustScoreResult.score,
          category: trustScoreResult.category,
          evidenceCoverage: trustScoreResult.evidenceCoverage,
          version: trustScoreResult.version,
          calculatedAt: trustScoreResult.calculatedAt,
          summary: trustScoreResult.summary,
          trigger: 'initial_creation',
        },
      ];

      await record.save({ session });
      await writeAuditEvent({
        actor: user._id,
        action: 'fdr_created',
        entityId: record._id,
        metadata: {
          institutionId: String(institution._id),
          fdrNumber: record.fdrNumber,
        },
      }).save({ session });
      await writeAuditEvent({
        actor: user._id,
        action: 'fdr_document_uploaded',
        entityId: record._id,
        metadata: {
          fileName: documentInfo.fileName,
          mimeType: documentInfo.mimeType,
          fileSize: documentInfo.fileSize,
          checksum: documentInfo.checksum,
        },
      }).save({ session });

      createdFdr = record;
    });
  } catch (error) {
    await removeUploadedFileAfterFailure(documentInfo.storageKey);
    if (error.code === 11000) {
      throw new FdrServiceError(409, 'An FDR with that number already exists for this institution.');
    }
    throw error;
  } finally {
    if (session) {
      await session.endSession();
    }
  }

  return createdFdr;
};

export const listFdrRecords = async ({ user, query }) => {
  const filter = {};
  if (institutionRoles.has(user.role)) {
    const institutionId = getInstitutionId(user);
    if (!institutionId) {
      throw new FdrServiceError(404, 'No institution is associated with this user.');
    }
    filter.institution = institutionId;
  }

  if (query.search) {
    const search = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ fdrNumber: search }, { bankName: search }];
  }

  if (query.workflowStatus) {
    filter.workflowStatus = query.workflowStatus;
  }

  const page = Math.max(1, query.page || 1);
  const limit = Math.max(1, Math.min(query.limit || 10, 50));
  const skip = (page - 1) * limit;

  const [total, records] = await Promise.all([
    FDR.countDocuments(filter),
    FDR.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
  ]);

  return {
    fdrs: records.map(serializeFdr),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
  };
};

export const getFdrById = async ({ user, fdrId }) => {
  if (!mongoose.isValidObjectId(fdrId)) {
    throw new FdrServiceError(400, 'Invalid FDR ID.');
  }

  const fdr = await FDR.findById(fdrId);
  if (!fdr) {
    throw new FdrServiceError(404, 'FDR not found.');
  }

  if (institutionRoles.has(user.role)) {
    const institutionId = getInstitutionId(user);
    const recordInstitutionId = fdr.institution?._id || fdr.institution;
    if (!institutionId || !recordInstitutionId || String(recordInstitutionId) !== institutionId) {
      throw new FdrServiceError(403, 'You do not have access to this FDR.');
    }
  }

  return fdr;
};

export const updateFdrRecord = async ({ user, fdrId, updates }) => {
  if (!institutionRoles.has(user.role)) {
    throw new FdrServiceError(403, 'Only institution users can update FDR records.');
  }

  const institutionId = getInstitutionId(user);
  if (!institutionId) {
    throw new FdrServiceError(404, 'No institution is associated with this user.');
  }

  const session = await mongoose.startSession();
  let updatedRecord;

  try {
    await session.withTransaction(async () => {
      const record = await FDR.findById(fdrId).session(session);
      if (!record) {
        throw new FdrServiceError(404, 'FDR not found.');
      }
      if (String(record.institution) !== institutionId) {
        throw new FdrServiceError(403, 'You do not have access to this FDR.');
      }
      if (!['draft', 'rejected', 'correction_requested'].includes(record.workflowStatus)) {
        throw new FdrServiceError(409, 'Only draft, rejected, or correction-requested FDR records may be edited.');
      }
      const previousStatus = record.workflowStatus;
      if (previousStatus === 'correction_requested' && updates.workflowStatus !== 'submitted') {
        throw new FdrServiceError(409, 'Corrected FDR records must be resubmitted for review.');
      }

      for (const field of ['fdrNumber', 'bankName', 'branch', 'amount', 'currency', 'issueDate', 'maturityDate']) {
        if (field in updates) {
          record[field] = updates[field];
        }
      }
      if (updates.workflowStatus) {
        record.workflowStatus = updates.workflowStatus;
        if (updates.workflowStatus === 'submitted') {
          record.submittedAt = new Date();
        }
      }
      if (
        updates.workflowStatus === 'submitted' &&
        ['rejected', 'correction_requested'].includes(previousStatus)
      ) {
        record.reviewHistory.push({
          actor: user._id,
          actorRole: user.role,
          decision: 'resubmit',
          reason: 'Institution updated the FDR details and resubmitted the record.',
          previousStatus,
          nextStatus: 'submitted',
          timestamp: new Date(),
        });
      }

      // Recalculate duplicate check and trust score with updated fields
      let duplicateResult = record.duplicateCheck;
      if (mongoose.connection.readyState === 1) {
        try {
          duplicateResult = await detectFdrDuplicates({ fdrId: record._id, fdrRecord: record });
          record.duplicateCheck = duplicateResult;
        } catch {
          // safe fallback
        }
      }

      let latestForensic = null;
      if (record.latestForensicAnalysis && mongoose.connection.readyState === 1) {
        try {
          latestForensic = await ForensicAnalysis.findById(record.latestForensicAnalysis).session(session);
        } catch {
          // safe fallback
        }
      }

      const trustScoreResult = calculateFdrTrustScore({
        fdr: record,
        forensicAnalysis: latestForensic,
        duplicateResult,
        bankVerification: record.bankVerification || {},
        trigger: 'fdr_updated',
      });
      record.trustScore = trustScoreResult;
      record.trustScoreHistory = record.trustScoreHistory || [];
      record.trustScoreHistory.push({
        score: trustScoreResult.score,
        category: trustScoreResult.category,
        evidenceCoverage: trustScoreResult.evidenceCoverage,
        version: trustScoreResult.version,
        calculatedAt: trustScoreResult.calculatedAt,
        summary: trustScoreResult.summary,
        trigger: 'fdr_updated',
      });

      await record.save({ session });
      await writeAuditEvent({
        actor: user._id,
        action: 'fdr_metadata_updated',
        entityId: record._id,
        metadata: {
          changedFields: Object.keys(updates),
          institutionId,
          previousStatus,
          nextStatus: record.workflowStatus,
          trustScore: trustScoreResult.score,
        },
      }).save({ session });

      updatedRecord = record;
    });
  } catch (error) {
    if (error.code === 11000) {
      throw new FdrServiceError(409, 'An FDR with that number already exists for this institution.');
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return updatedRecord;
};

export const getFdrDocumentPath = async ({ user, fdrId }) => {
  const record = await getFdrById({ user, fdrId });
  if (!record.documentMetadata?.storageRef) {
    throw new FdrServiceError(404, 'This FDR has no uploaded document.');
  }

  let filePath;
  try {
    filePath = await readDocumentStream(record.documentMetadata.storageRef);
  } catch (error) {
    if (error.code === 'INVALID_STORAGE_KEY') {
      throw new FdrServiceError(404, 'The stored document is unavailable.');
    }
    throw error;
  }
  if (!filePath) {
    throw new FdrServiceError(404, 'The stored document is unavailable.');
  }

  return { record, filePath };
};

export const createDocumentDownloadAudit = async ({ actorId, entityId }) => {
  await writeAuditEvent({
    actor: actorId,
    action: 'fdr_document_downloaded',
    entityId,
    metadata: { requestedAt: new Date() },
  }).save();
};
