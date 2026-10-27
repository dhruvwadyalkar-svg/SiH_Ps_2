import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import {
  deleteStoredDocument,
  readDocumentStream,
  storeUploadedDocument,
} from './document-storage.service.js';

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
      });

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

  if (query.fromDate || query.toDate) {
    filter.maturityDate = {};
    if (query.fromDate) filter.maturityDate.$gte = query.fromDate;
    if (query.toDate) filter.maturityDate.$lte = query.toDate;
  }

  const [total, records] = await Promise.all([
    FDR.countDocuments(filter),
    FDR.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);

  return {
    fdrs: records.map(serializeFdr),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
};

export const getFdrById = async ({ user, fdrId }) => {
  const fdr = await FDR.findById(fdrId).select('+ocrResult.providerJobId');
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
