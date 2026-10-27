import mongoose from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import { readStoredDocument, validateUploadBuffer } from './document-storage.service.js';
import { SarvamOcrError, sarvamOcrService } from './sarvam-ocr.service.js';
import {
  compareFdrFields,
  parseExtractedFdrFields,
} from '../utils/fdr-extraction.schema.js';
import { getFdrById } from './fdr.service.js';

const activeStatuses = ['submitting', 'queued', 'processing', 'pending'];
const terminalStatuses = ['completed', 'partially_completed', 'failed', 'rejected'];
const acceptedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export class FdrExtractionError extends Error {
  constructor(status, errorCode, message) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

const mapProviderStatus = (status) => {
  const normalized = status.toLowerCase();
  if (['pending', 'queued'].includes(normalized)) return 'queued';
  if (['running', 'processing', 'in_progress'].includes(normalized)) return 'processing';
  if (terminalStatuses.includes(normalized)) return normalized;
  throw new FdrExtractionError(502, 'malformed_response', 'OCR provider returned an unsupported job status.');
};

const statusErrorCode = (status) => {
  if (status === 'rejected') return 'document_rejected';
  if (status === 'failed') return 'provider_error';
  return null;
};

const createAudit = ({ actor, action, entityId, metadata }) =>
  new AuditLog({ actor, action, entityType: 'FDR', entityId, metadata });

const withSession = async (operation) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => operation(session));
  } finally {
    await session.endSession();
  }
};

const updateAndAudit = async ({ fdrId, filter, update, userId, action, metadata }) =>
  withSession(async (session) => {
    const result = await FDR.updateOne(
      { _id: fdrId, ...filter },
      { $set: update },
      { session, runValidators: true },
    );
    if (result.matchedCount !== 1) {
      throw new FdrExtractionError(409, 'state_changed', 'The extraction state changed. Refresh and try again.');
    }

    await createAudit({
      actor: userId,
      action,
      entityId: fdrId,
      metadata,
    }).save({ session });
  });

const toPublicExtraction = (fdr) => {
  const result = fdr.ocrResult || {};
  const hasResults = ['completed', 'partially_completed'].includes(result.status);
  return {
    fdrId: String(fdr._id),
    status: result.status || 'not_started',
    extractedFields: hasResults ? result.extractedData : null,
    comparisons: hasResults ? result.comparisonResults : null,
    submittedAt: result.submittedAt || null,
    completedAt: result.completedAt || null,
    errorCode: ['failed', 'rejected'].includes(result.status) ? result.providerErrorCode : null,
  };
};

const getValidatedStoredDocument = async (fdr) => {
  const storageRef = fdr.documentMetadata?.storageRef;
  if (!storageRef) {
    throw new FdrExtractionError(422, 'missing_document', 'This FDR has no stored document to analyze.');
  }

  const mimeType = fdr.documentMetadata.mimeType;
  if (!acceptedMimeTypes.has(mimeType)) {
    throw new FdrExtractionError(422, 'unsupported_document', 'OCR supports PDF, JPEG, and PNG documents only.');
  }

  let document;
  try {
    document = await readStoredDocument(storageRef);
  } catch (error) {
    if (error.code === 'INVALID_STORAGE_KEY') {
      throw new FdrExtractionError(422, 'unsupported_document', 'The stored document is unavailable for analysis.');
    }
    if (error.message === 'Stored document exceeds the configured size limit.') {
      throw new FdrExtractionError(422, 'document_too_large', 'The stored document exceeds the configured size limit.');
    }
    throw error;
  }
  if (!document) {
    throw new FdrExtractionError(422, 'missing_document', 'The stored document is unavailable.');
  }

  try {
    await validateUploadBuffer({
      buffer: document,
      originalname: fdr.documentMetadata.fileName || 'stored-document',
      mimetype: mimeType,
    });
  } catch {
    throw new FdrExtractionError(422, 'unsupported_document', 'The stored document format is invalid or unsupported.');
  }

  if (mimeType === 'application/pdf') {
    let pdf;
    try {
      pdf = await PDFDocument.load(document, { ignoreEncryption: true, updateMetadata: false });
    } catch {
      throw new FdrExtractionError(422, 'unsupported_document', 'The PDF is unreadable or password-protected.');
    }
    if (pdf.getPageCount() > 20) {
      throw new FdrExtractionError(422, 'too_many_pages', 'Sarvam Extract supports PDFs with up to 20 pages.');
    }
  }

  return {
    document,
    fileName: fdr.documentMetadata.fileName || 'stored-document',
    mimeType,
  };
};

const markRequestFailure = async ({ fdr, user, error }) => {
  const safeError = error instanceof SarvamOcrError
    ? new FdrExtractionError(error.status, error.errorCode, error.message)
    : new FdrExtractionError(502, 'provider_unavailable', 'OCR provider request failed.');
  const completedAt = new Date();

  await updateAndAudit({
    fdrId: fdr._id,
    filter: { 'ocrResult.status': 'submitting' },
    update: {
      'ocrResult.status': 'failed',
      'ocrResult.completedAt': completedAt,
      'ocrResult.processedAt': completedAt,
      'ocrResult.providerErrorCode': safeError.errorCode,
    },
    userId: user._id,
    action: 'fdr_ocr_failed',
    metadata: {
      status: 'failed',
      errorCode: safeError.errorCode,
    },
  });

  Object.assign(fdr.ocrResult, {
    status: 'failed',
    completedAt,
    processedAt: completedAt,
    providerErrorCode: safeError.errorCode,
  });

  throw safeError;
};

export const requestFdrExtraction = async ({ user, fdrId }) => {
  const fdr = await getFdrById({ user, fdrId });
  if (!['submitted', 'under_review', 'rejected'].includes(fdr.workflowStatus)) {
    throw new FdrExtractionError(409, 'invalid_workflow_state', 'This FDR is not in a state that can be analyzed.');
  }

  const currentStatus = fdr.ocrResult?.status || 'not_started';
  if (activeStatuses.includes(currentStatus)) {
    throw new FdrExtractionError(409, 'extraction_in_progress', 'An extraction is already in progress for this FDR.');
  }
  if (['completed', 'partially_completed'].includes(currentStatus)) {
    throw new FdrExtractionError(409, 'already_extracted', 'This FDR already has extraction results.');
  }

  const storedDocument = await getValidatedStoredDocument(fdr);
  const submittedAt = new Date();
  await withSession(async (session) => {
    const claim = await FDR.updateOne(
      {
        _id: fdr._id,
        'ocrResult.status': { $in: [null, 'not_started', 'failed', 'rejected'] },
      },
      {
        $set: {
          'ocrResult.status': 'submitting',
          'ocrResult.providerJobId': null,
          'ocrResult.submittedAt': submittedAt,
          'ocrResult.completedAt': null,
          'ocrResult.processedAt': null,
          'ocrResult.providerErrorCode': null,
        },
      },
      { session, runValidators: true },
    );
    if (claim.matchedCount !== 1) {
      throw new FdrExtractionError(409, 'extraction_in_progress', 'An extraction is already in progress for this FDR.');
    }
    await createAudit({
      actor: user._id,
      action: 'fdr_ocr_requested',
      entityId: fdr._id,
      metadata: {
        provider: 'sarvam',
        mimeType: storedDocument.mimeType,
        fileSize: storedDocument.document.length,
      },
    }).save({ session });
  });

  Object.assign(fdr.ocrResult, {
    status: 'submitting',
    providerJobId: null,
    submittedAt,
    completedAt: null,
    processedAt: null,
    providerErrorCode: null,
  });

  let providerJob;
  try {
    providerJob = await sarvamOcrService.submitExtraction(storedDocument);
  } catch (error) {
    return markRequestFailure({ fdr, user, error });
  }

  if (
    !providerJob ||
    typeof providerJob.jobId !== 'string' ||
    providerJob.jobId.length === 0 ||
    typeof providerJob.status !== 'string'
  ) {
    return markRequestFailure({
      fdr,
      user,
      error: new SarvamOcrError('malformed_response', 502, 'OCR provider returned an invalid job response.'),
    });
  }

  const status = ['failed', 'rejected'].includes(providerJob.status)
    ? providerJob.status
    : 'queued';
  try {
    await withSession(async (session) => {
      const saved = await FDR.updateOne(
        { _id: fdr._id, 'ocrResult.status': 'submitting' },
        {
          $set: {
            'ocrResult.status': status,
            'ocrResult.providerJobId': providerJob.jobId,
            'ocrResult.providerErrorCode': statusErrorCode(status),
            ...(status === 'failed' || status === 'rejected' ? { 'ocrResult.completedAt': new Date() } : {}),
          },
        },
        { session, runValidators: true },
      );
      if (saved.matchedCount !== 1) {
        throw new FdrExtractionError(409, 'state_changed', 'The extraction state changed. Refresh and try again.');
      }
    });
  } catch (error) {
    if (error instanceof FdrExtractionError) throw error;
    throw new FdrExtractionError(503, 'persistence_failed', 'The extraction job was accepted but could not be saved.');
  }

  Object.assign(fdr.ocrResult, {
    status,
    providerJobId: providerJob.jobId,
    providerErrorCode: statusErrorCode(status),
  });

  return {
    fdrId: String(fdr._id),
    status,
    jobReference: providerJob.jobId,
  };
};

const getInstitutionName = async (fdr) => {
  const institution = await Institution.findById(fdr.institution).select('name');
  return institution?.name || null;
};

const persistProviderFailure = async ({ fdr, user, status, errorCode }) => {
  const completedAt = new Date();
  await updateAndAudit({
    fdrId: fdr._id,
    filter: {
      'ocrResult.providerJobId': fdr.ocrResult.providerJobId,
      'ocrResult.status': { $in: activeStatuses },
    },
    update: {
      'ocrResult.status': status,
      'ocrResult.completedAt': completedAt,
      'ocrResult.processedAt': completedAt,
      'ocrResult.providerErrorCode': errorCode,
    },
    userId: user._id,
    action: 'fdr_ocr_failed',
    metadata: { status, errorCode },
  });
  Object.assign(fdr.ocrResult, {
    status,
    completedAt,
    processedAt: completedAt,
    providerErrorCode: errorCode,
  });
};

const persistProgress = async ({ fdr, status }) => {
  await FDR.updateOne(
    {
      _id: fdr._id,
      'ocrResult.providerJobId': fdr.ocrResult.providerJobId,
      'ocrResult.status': { $in: activeStatuses },
    },
    { $set: { 'ocrResult.status': status } },
    { runValidators: true },
  );
  fdr.ocrResult.status = status;
};

const persistCompletedResults = async ({ fdr, user, status, extractedData }) => {
  const institutionName = await getInstitutionName(fdr);
  const comparisonResults = compareFdrFields({
    submitted: fdr,
    extracted: extractedData,
    institutionName,
  });
  const completedAt = new Date();
  await updateAndAudit({
    fdrId: fdr._id,
    filter: {
      'ocrResult.providerJobId': fdr.ocrResult.providerJobId,
      'ocrResult.status': { $in: activeStatuses },
    },
    update: {
      'ocrResult.status': status,
      'ocrResult.extractedData': extractedData,
      'ocrResult.comparisonResults': comparisonResults,
      'ocrResult.completedAt': completedAt,
      'ocrResult.processedAt': completedAt,
      'ocrResult.providerErrorCode': null,
    },
    userId: user._id,
    action: 'fdr_ocr_completed',
    metadata: {
      status,
      extractedFieldCount: Object.values(extractedData).filter((value) => value !== null).length,
    },
  });
  Object.assign(fdr.ocrResult, {
    status,
    extractedData,
    comparisonResults,
    completedAt,
    processedAt: completedAt,
    providerErrorCode: null,
  });
};

export const getFdrExtraction = async ({ user, fdrId }) => {
  const fdr = await getFdrById({ user, fdrId });
  const status = fdr.ocrResult?.status || 'not_started';
  if (terminalStatuses.includes(status) || status === 'not_started' || status === 'submitting') {
    return toPublicExtraction(fdr);
  }

  const jobId = fdr.ocrResult?.providerJobId;
  if (!jobId) {
    throw new FdrExtractionError(502, 'malformed_response', 'The extraction job reference is unavailable.');
  }

  const providerStatusResponse = await sarvamOcrService.getJobStatus(jobId);
  if (!providerStatusResponse || typeof providerStatusResponse.status !== 'string') {
    throw new FdrExtractionError(502, 'malformed_response', 'OCR provider returned an invalid status response.');
  }
  const providerStatus = mapProviderStatus(providerStatusResponse.status);

  if (!terminalStatuses.includes(providerStatus)) {
    if (providerStatus !== status) {
      await persistProgress({ fdr, status: providerStatus });
    }
    return toPublicExtraction(fdr);
  }

  if (providerStatus === 'failed' || providerStatus === 'rejected') {
    const errorCode = statusErrorCode(providerStatus);
    await persistProviderFailure({ fdr, user, status: providerStatus, errorCode });
    return toPublicExtraction(fdr);
  }

  let providerResult;
  try {
    providerResult = await sarvamOcrService.getJobResults(jobId);
  } catch (error) {
    if (error instanceof SarvamOcrError && error.errorCode === 'malformed_response') {
      await persistProviderFailure({
        fdr,
        user,
        status: 'failed',
        errorCode: 'malformed_response',
      });
      return toPublicExtraction(fdr);
    }
    throw error;
  }

  const parsed = parseExtractedFdrFields(providerResult);
  if (!parsed.success) {
    await persistProviderFailure({
      fdr,
      user,
      status: 'failed',
      errorCode: 'malformed_response',
    });
    return toPublicExtraction(fdr);
  }

  await persistCompletedResults({
    fdr,
    user,
    status: providerStatus,
    extractedData: parsed.data,
  });
  return toPublicExtraction(fdr);
};
