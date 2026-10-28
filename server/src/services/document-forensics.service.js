import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import AuditLog from '../models/AuditLog.js';
import ForensicAnalysis from '../models/ForensicAnalysis.js';
import FDR from '../models/FDR.js';
import { readStoredDocument, validateUploadBuffer } from './document-storage.service.js';
import { getFdrById } from './fdr.service.js';
import { calculateFdrTrustScore } from './fdr-trust-score.service.js';
import { detectFdrDuplicates } from './duplicate-detection.service.js';
import { inspectFdrDocumentForQr } from './bank-verification.service.js';

const analysisVersion = '1.0.0';
const analysisEngine = 'local-document-forensics';
const maxPdfPages = 20;
const maxImagePixels = 40_000_000;
const supportedMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
const limitations = [
  'This is a preliminary local analysis, not a determination that a document is genuine or fraudulent.',
  'No bank-side verification, certificate trust evaluation, or cryptographic PDF signature validation is performed.',
  'Image inspection reads bounded structural metadata only; it does not detect all edits, recompression, synthetic imagery, or AI generation.',
  'The stored checksum establishes byte integrity only relative to the checksum recorded at upload time.',
];
const withSession = async (operation) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => operation(session));
  } finally {
    await session.endSession();
  }
};

export class DocumentForensicsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const finding = (code, severity, explanation, { conclusive = false, heuristic = true } = {}) => ({
  code,
  severity,
  explanation,
  conclusive,
  heuristic,
});

const pngCrc32 = (buffer, start, end) => {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = pngCrcTable[(crc ^ buffer[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const parsePng = (buffer) => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('Malformed PNG signature or header.');
  }

  let offset = 8;
  let width;
  let height;
  let hasExif = false;
  let foundData = false;
  let foundEnd = false;
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > buffer.length) {
      throw new Error('PNG chunk exceeds the document boundary.');
    }
    if (chunkType === 'IHDR') {
      if (offset !== 8 || chunkLength !== 13 || width !== undefined) {
        throw new Error('Malformed PNG image header.');
      }
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
    }
    if (chunkType === 'IDAT') foundData = true;
    if (chunkType === 'eXIf') hasExif = true;
    const storedCrc = buffer.readUInt32BE(offset + 8 + chunkLength);
    if (pngCrc32(buffer, offset + 4, offset + 8 + chunkLength) !== storedCrc) {
      throw new Error('PNG chunk checksum is invalid.');
    }
    offset = nextOffset;
    if (chunkType === 'IEND') {
      foundEnd = chunkLength === 0 && foundData;
      break;
    }
  }
  if (!foundEnd || !width || !height) {
    throw new Error('PNG is missing a valid image header or end chunk.');
  }
  return { format: 'png', width, height, metadataPresent: hasExif };
};

const parseJpeg = (buffer) => {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Malformed JPEG signature.');
  }

  let offset = 2;
  let width;
  let height;
  let metadataPresent = false;
  let foundEnd = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      if (height !== undefined) {
        offset += 1;
        continue;
      }
      throw new Error('Malformed JPEG marker sequence.');
    }

    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9) {
      foundEnd = true;
      break;
    }
    if (marker === 0xda) {
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        throw new Error('Malformed JPEG scan header.');
      }
      const endMarker = buffer.indexOf(Buffer.from([0xff, 0xd9]), offset + segmentLength);
      if (endMarker < 0) throw new Error('JPEG scan is missing an end marker.');
      foundEnd = true;
      break;
    }
    if ([0xd8, 0x01, ...Array.from({ length: 8 }, (_, index) => 0xd0 + index)].includes(marker)) {
      continue;
    }
    if (offset + 2 > buffer.length) throw new Error('Truncated JPEG segment.');
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new Error('JPEG segment exceeds the document boundary.');
    }
    const payloadOffset = offset + 2;
    const payloadLength = segmentLength - 2;
    if (marker === 0xe1 && buffer.toString('ascii', payloadOffset, payloadOffset + 6) === 'Exif\u0000\u0000') {
      metadataPresent = true;
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (payloadLength < 6) throw new Error('Malformed JPEG frame header.');
      height = buffer.readUInt16BE(payloadOffset + 1);
      width = buffer.readUInt16BE(payloadOffset + 3);
    }
    offset += segmentLength;
  }
  if (!foundEnd || !width || !height) {
    throw new Error('JPEG is missing a valid image frame or end marker.');
  }
  return { format: 'jpeg', width, height, metadataPresent };
};

const analyzePdf = async (buffer, findings, metadata) => {
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
    const pages = pdf.getPageCount();
    metadata.format = 'pdf';
    metadata.pageCount = pages;
    const safeText = (value) => typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) || null
      : null;
    metadata.title = safeText(pdf.getTitle());
    metadata.author = safeText(pdf.getAuthor());
    metadata.subject = safeText(pdf.getSubject());
    metadata.creator = safeText(pdf.getCreator());
    metadata.producer = safeText(pdf.getProducer());

    const creationDate = pdf.getCreationDate();
    const modificationDate = pdf.getModificationDate();
    metadata.creationDate = creationDate instanceof Date && Number.isFinite(creationDate.getTime())
      ? creationDate.toISOString()
      : null;
    metadata.modificationDate = modificationDate instanceof Date && Number.isFinite(modificationDate.getTime())
      ? modificationDate.toISOString()
      : null;

    if (pages > maxPdfPages) {
      findings.push(finding(
        'pdf_page_limit_exceeded',
        'medium',
        `The PDF has ${pages} pages; analysis is limited to ${maxPdfPages} pages.`,
        { heuristic: false },
      ));
      return 'analysis_inconclusive';
    }

    if (!metadata.title && !metadata.author && !metadata.creator && !metadata.producer && !metadata.creationDate) {
      findings.push(finding(
        'pdf_metadata_unavailable',
        'low',
        'Common descriptive PDF metadata is absent; this is a weak signal and is not evidence of manipulation.',
      ));
    }
    if (
      metadata.creationDate &&
      metadata.modificationDate &&
      new Date(metadata.modificationDate) < new Date(metadata.creationDate)
    ) {
      findings.push(finding(
        'pdf_metadata_date_inconsistency',
        'low',
        'The recorded modification date precedes the creation date; PDF metadata is editable and this is not proof of manipulation.',
      ));
    }

    metadata.digitalSignatureFieldDetection = 'unsupported';
    metadata.digitalSignatureValidationSupported = false;
    findings.push(finding(
      'pdf_signature_validation_unsupported',
      'inconclusive',
      'This analysis does not detect or validate PDF digital signatures, signer identity, certificate chains, or trust.',
    ));
    return 'no_signals_detected';
  } catch {
    findings.push(finding(
      'malformed_pdf',
      'inconclusive',
      'The PDF parser could not safely read the document structure.',
      { heuristic: false },
    ));
    return 'analysis_failed';
  }
};

const analyzeImage = (buffer, mimeType, findings, metadata) => {
  let image;
  try {
    image = mimeType === 'image/png' ? parsePng(buffer) : parseJpeg(buffer);
  } catch {
    findings.push(finding(
      'malformed_image',
      'inconclusive',
      'The image header or bounded structural markers could not be read safely.',
      { heuristic: false },
    ));
    return 'analysis_failed';
  }

  metadata.format = image.format;
  metadata.width = image.width;
  metadata.height = image.height;
  metadata.metadataPresent = image.metadataPresent;
  metadata.pixelCount = image.width * image.height;
  if (metadata.pixelCount > maxImagePixels) {
    findings.push(finding(
      'image_pixel_limit_exceeded',
      'medium',
      `The image exceeds the ${maxImagePixels} pixel analysis limit.`,
      { heuristic: false },
    ));
    return 'analysis_inconclusive';
  }
  if (!image.metadataPresent) {
    findings.push(finding(
      'image_metadata_absent',
      'low',
      'No supported EXIF metadata block was found; metadata can be stripped during ordinary image handling and this is not proof of manipulation.',
    ));
  }
  return 'no_signals_detected';
};

const chooseStatus = ({ integrityMismatch, integrityUnavailable, inspectionStatus, findings }) => {
  if (integrityMismatch) return 'integrity_check_failed';
  if (integrityUnavailable) return 'analysis_inconclusive';
  if (inspectionStatus === 'analysis_failed') return 'analysis_failed';
  if (inspectionStatus === 'analysis_inconclusive') return 'analysis_inconclusive';
  if (findings.some(({ severity }) => ['medium', 'high'].includes(severity))) return 'review_recommended';
  if (findings.some(({ severity }) => severity === 'low')) return 'review_recommended';
  return 'no_signals_detected';
};

export const analyzeStoredFdrDocument = async ({ user, fdrId, analysisId }) => {
  const fdr = await getFdrById({ user, fdrId });
  const { storageRef, mimeType, checksum } = fdr.documentMetadata || {};
  if (!storageRef) throw new DocumentForensicsError(404, 'missing_document', 'This FDR has no stored document.');
  if (!supportedMimeTypes.has(mimeType)) {
    throw new DocumentForensicsError(422, 'unsupported_document', 'Forensics supports PDF, JPEG, and PNG documents only.');
  }

  const analyzedAt = new Date();
  const findings = [];
  const metadata = { mimeType };
  let integrityUnavailable = false;
  let document;
  try {
    document = await readStoredDocument(storageRef);
  } catch (error) {
    if (
      error.code !== 'INVALID_STORAGE_KEY' &&
      error.code !== 'ENOENT' &&
      error.code !== 'EACCES' &&
      error.message !== 'Stored document exceeds the configured size limit.'
    ) throw error;
    integrityUnavailable = true;
  }
  if (!document) integrityUnavailable = true;

  const validChecksum = typeof checksum === 'string' && /^[a-f0-9]{64}$/i.test(checksum);
  const actualChecksum = document ? crypto.createHash('sha256').update(document).digest('hex') : null;
  const checksumMatches = validChecksum && actualChecksum === checksum.toLowerCase();
  metadata.checksum = validChecksum ? checksum.toLowerCase() : null;
  metadata.recalculatedChecksum = actualChecksum;
  metadata.checksumVerified = checksumMatches;

  if (!document) {
    findings.push(finding(
      'stored_file_unavailable',
      'inconclusive',
      'The private stored document is missing, unreadable, or exceeds the configured size limit.',
      { heuristic: false },
    ));
  } else if (!validChecksum) {
    findings.push(finding(
      'upload_checksum_unavailable',
      'inconclusive',
      'No valid upload-time SHA-256 checksum is recorded, so integrity since upload cannot be verified.',
      { heuristic: false },
    ));
    integrityUnavailable = true;
  } else if (!checksumMatches) {
    findings.push(finding(
      'stored_file_integrity_mismatch',
      'high',
      'The current document bytes do not match the SHA-256 checksum recorded at upload time; this establishes a byte change since upload, not authenticity at issuance.',
      { conclusive: true, heuristic: false },
    ));
  }

  let inspectionStatus = 'analysis_inconclusive';
  if (document) {
    try {
      await validateUploadBuffer({
        buffer: document,
        originalname: fdr.documentMetadata.fileName || 'stored-document',
        mimetype: mimeType,
      });
    } catch {
      findings.push(finding(
        'stored_file_format_mismatch',
        'high',
        'The stored bytes do not match the declared supported document format.',
        { conclusive: true, heuristic: false },
      ));
      inspectionStatus = 'analysis_failed';
    }
    if (inspectionStatus !== 'analysis_failed') {
      inspectionStatus = mimeType === 'application/pdf'
        ? await analyzePdf(document, findings, metadata)
        : analyzeImage(document, mimeType, findings, metadata);
    }
  }

  const integrityMismatch = Boolean(document && validChecksum && !checksumMatches);
  const status = chooseStatus({
    integrityMismatch,
    integrityUnavailable,
    inspectionStatus,
    findings,
  });
  const report = new ForensicAnalysis({
    _id: analysisId,
    fdrId: fdr._id,
    checksum: validChecksum ? checksum.toLowerCase() : null,
    engine: analysisEngine,
    analysisVersion,
    status,
    findings,
    metadata,
    limitations: [...limitations],
    analyzedAt,
  });
  return { fdr, report };
};

const auditForensics = ({ actor, action, entityId, analysisId, metadata }) =>
  new AuditLog({
    actor,
    action,
    entityType: 'FDR',
    entityId,
    metadata: { analysisId: String(analysisId), ...metadata },
  });

const persistReportAndAudit = async ({
  fdrId,
  report,
  actor,
  action,
  metadata,
  trustScoreResult = null,
  duplicateResult = null,
  qrData = null,
}) =>
  withSession(async (session) => {
    await report.save({ session });
    const updateOps = {
      $set: {
        latestForensicAnalysis: report._id,
        ...(trustScoreResult ? { trustScore: trustScoreResult } : {}),
        ...(duplicateResult ? { duplicateCheck: duplicateResult } : {}),
        ...(qrData ? { 'bankVerification.qrCode': qrData } : {}),
      },
    };
    if (trustScoreResult) {
      updateOps.$push = {
        trustScoreHistory: {
          score: trustScoreResult.score,
          category: trustScoreResult.category,
          evidenceCoverage: trustScoreResult.evidenceCoverage,
          version: trustScoreResult.version,
          calculatedAt: trustScoreResult.calculatedAt,
          summary: trustScoreResult.summary,
          trigger: 'forensic_update',
        },
      };
    }

    const result = await FDR.updateOne(
      { _id: fdrId },
      updateOps,
      { session, runValidators: true },
    );
    if (result.matchedCount !== 1) {
      throw new DocumentForensicsError(404, 'fdr_not_found', 'FDR not found.');
    }
    await auditForensics({
      actor,
      action,
      entityId: fdrId,
      analysisId: report._id,
      metadata,
    }).save({ session });
  });

const makeFailedReport = ({ fdr, analysisId, errorCode }) =>
  new ForensicAnalysis({
    _id: analysisId,
    fdrId: fdr._id,
    checksum: /^[a-f0-9]{64}$/i.test(fdr.documentMetadata?.checksum || '')
      ? fdr.documentMetadata.checksum.toLowerCase()
      : null,
    engine: analysisEngine,
    analysisVersion,
    status: 'analysis_failed',
    findings: [
      finding('analysis_failed', 'inconclusive', 'The document could not be fully analyzed; see the safe error code.', {
        heuristic: false,
      }),
    ],
    metadata: { mimeType: fdr.documentMetadata?.mimeType || null, errorCode },
    limitations,
    analyzedAt: new Date(),
  });

export const runFdrForensics = async ({ user, fdrId }) => {
  const fdr = await getFdrById({ user, fdrId });
  const analysisId = new mongoose.Types.ObjectId();
  await withSession(async (session) => {
    await auditForensics({
      actor: user._id,
      action: 'fdr_forensics_requested',
      entityId: fdr._id,
      analysisId,
      metadata: { status: 'requested' },
    }).save({ session });
  });

  try {
    const { report } = await analyzeStoredFdrDocument({ user, fdrId, analysisId });

    let qrData = fdr.bankVerification?.qrCode;
    if (!qrData?.inspectedAt) {
      try {
        qrData = await inspectFdrDocumentForQr({ fdr });
      } catch {
        // safe fallback
      }
    }

    let duplicateResult = fdr.duplicateCheck;
    if (mongoose.connection.readyState === 1) {
      try {
        duplicateResult = await detectFdrDuplicates({ fdrId: fdr._id, fdrRecord: fdr });
      } catch {
        // safe fallback
      }
    }

    const trustScoreResult = calculateFdrTrustScore({
      fdr,
      forensicAnalysis: report,
      duplicateResult,
      bankVerification: fdr.bankVerification,
      trigger: 'forensic_update',
    });

    await persistReportAndAudit({
      fdrId: fdr._id,
      report,
      actor: user._id,
      action: report.status === 'analysis_failed' || report.status === 'integrity_check_failed'
        ? 'fdr_forensics_failed'
        : 'fdr_forensics_completed',
      metadata: {
        status: report.status,
        findingCount: report.findings.length,
        trustScore: trustScoreResult.score,
      },
      trustScoreResult,
      duplicateResult,
      qrData,
    });
    return report;
  } catch (error) {
    const code = error instanceof DocumentForensicsError ? error.code : 'analysis_failed';
    const report = makeFailedReport({ fdr, analysisId, errorCode: code });
    await persistReportAndAudit({
      fdrId: fdr._id,
      report,
      actor: user._id,
      action: 'fdr_forensics_failed',
      metadata: { status: 'analysis_failed', errorCode: code },
    });
    if (error instanceof DocumentForensicsError) throw error;
    throw new DocumentForensicsError(500, 'analysis_failed', 'Document analysis could not be completed.');
  }
};

export const getLatestForensicReport = async ({ user, fdrId }) => {
  await getFdrById({ user, fdrId });
  return ForensicAnalysis.findOne({ fdrId }).sort({ analyzedAt: -1, _id: -1 });
};
