import { createReadStream } from 'node:fs';
import { fdrCreateSchema, fdrIdSchema, listFdrQuerySchema, updateFdrSchema } from '../utils/fdr.validation.js';
import {
  createFdrRecord,
  createDocumentDownloadAudit,
  FdrServiceError,
  getFdrById,
  getFdrDocumentPath,
  listFdrRecords,
  serializeFdr,
  updateFdrRecord,
} from '../services/fdr.service.js';
import {
  FdrExtractionError,
  getFdrExtraction,
  requestFdrExtraction,
} from '../services/fdr-extraction.service.js';
import { SarvamOcrError } from '../services/sarvam-ocr.service.js';
import {
  DocumentForensicsError,
  getLatestForensicReport,
  runFdrForensics,
} from '../services/document-forensics.service.js';

const sendValidationError = (response, issues) =>
  response.status(400).json({
    error: 'Invalid request.',
    details: issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });

const handleServiceError = (response, error) => {
  if (
    error instanceof FdrServiceError ||
    error instanceof FdrExtractionError ||
    error instanceof SarvamOcrError ||
    error instanceof DocumentForensicsError
  ) {
    if (error.errorCode || error.code) {
      return response.status(error.status).json({ error: error.message, code: error.errorCode || error.code });
    }
    return response.status(error.status).json({ error: error.message });
  }
  return null;
};

const serializeForensicReport = (report) => ({
  analysisId: String(report._id),
  fdrId: String(report.fdrId),
  checksum: report.checksum || null,
  engine: report.engine,
  analysisVersion: report.analysisVersion,
  status: report.status,
  findings: report.findings,
  metadata: report.metadata,
  limitations: report.limitations,
  analyzedAt: report.analyzedAt,
});

export const runFdrForensicsController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  try {
    const report = await runFdrForensics({ user: request.user, fdrId: parsedId.data });
    return response.status(200).json({ analysis: serializeForensicReport(report) });
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const getFdrForensicsController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  try {
    const report = await getLatestForensicReport({ user: request.user, fdrId: parsedId.data });
    if (!report) {
      return response.status(404).json({
        error: 'No forensic analysis is available for this FDR.',
        code: 'analysis_not_found',
      });
    }
    return response.status(200).json({ analysis: serializeForensicReport(report) });
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const createFdrController = async (request, response, next) => {
  if (!request.file) {
    return response.status(400).json({ error: 'A valid PDF, JPEG, or PNG document is required.' });
  }

  const parsed = fdrCreateSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendValidationError(response, parsed.error.issues);
  }

  try {
    const record = await createFdrRecord({ user: request.user, payload: parsed.data, file: request.file });
    return response.status(201).json({ fdr: serializeFdr(record) });
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const listFdrController = async (request, response, next) => {
  const parsed = listFdrQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return sendValidationError(response, parsed.error.issues);
  }

  try {
    return response.status(200).json(await listFdrRecords({ user: request.user, query: parsed.data }));
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const getFdrController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  try {
    const record = await getFdrById({ user: request.user, fdrId: parsedId.data });
    return response.status(200).json({ fdr: serializeFdr(record) });
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const updateFdrController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  const parsedBody = updateFdrSchema.safeParse(request.body);
  if (!parsedBody.success) {
    return sendValidationError(response, parsedBody.error.issues);
  }

  try {
    const record = await updateFdrRecord({
      user: request.user,
      fdrId: parsedId.data,
      updates: parsedBody.data,
    });
    return response.status(200).json({ fdr: serializeFdr(record) });
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const downloadFdrDocumentController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  try {
    const { record, filePath } = await getFdrDocumentPath({ user: request.user, fdrId: parsedId.data });
    await createDocumentDownloadAudit({
      actorId: request.user._id,
      entityId: record._id,
    });

    response.setHeader('Content-Type', record.documentMetadata.mimeType || 'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(record.documentMetadata.fileName || 'fdr-document')}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(200);
    const stream = createReadStream(filePath);
    stream.on('error', (error) => {
      if (response.headersSent) {
        response.destroy();
      } else {
        next(error);
      }
    });
    stream.pipe(response);
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const requestFdrExtractionController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  try {
    const extraction = await requestFdrExtraction({
      user: request.user,
      fdrId: parsedId.data,
    });
    return response.status(202).json(extraction);
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};

export const getFdrExtractionController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid FDR ID.' });
  }

  try {
    return response.status(200).json(await getFdrExtraction({
      user: request.user,
      fdrId: parsedId.data,
    }));
  } catch (error) {
    if (handleServiceError(response, error)) return;
    return next(error);
  }
};
