import crypto from 'node:crypto';
import mongoose from 'mongoose';
import FDR from '../models/FDR.js';
import Notification from '../models/Notification.js';
import { readStoredDocument } from './document-storage.service.js';
import { recordAuditEvent } from './audit-log.service.js';

export class DocumentIntegrityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const institutionRoles = new Set(['institution_admin', 'institution_user']);
const officialRoles = new Set(['aicte_admin', 'reviewer']);

export const verifyStoredDocumentIntegrity = async ({ fdrId, user, trigger = 'manual' }) => {
  if (!mongoose.isValidObjectId(fdrId)) {
    throw new DocumentIntegrityError(400, 'Invalid FDR ID.');
  }

  const fdr = await FDR.findById(fdrId).populate('institution', 'name institutionCode');
  if (!fdr) {
    throw new DocumentIntegrityError(404, 'FDR record not found.');
  }

  // Tenant scoping check
  if (institutionRoles.has(user?.role)) {
    const userInstitutionId = user.institution?._id || user.institution;
    const recordInstitutionId = fdr.institution?._id || fdr.institution;
    if (!userInstitutionId || !recordInstitutionId || String(userInstitutionId) !== String(recordInstitutionId)) {
      throw new DocumentIntegrityError(403, 'You do not have permission to verify this document.');
    }
  }

  const storageRef = fdr.documentMetadata?.storageRef;
  const recordedChecksum = fdr.documentMetadata?.checksum;
  const currentVersion = fdr.documentMetadata?.version || 1;
  const fileName = fdr.documentMetadata?.fileName || 'document';
  const checkedAt = new Date().toISOString();

  // Helper to persist integrity status on FDR document safely
  const persistIntegrityOnFdr = async (status, isMatch, calculatedChecksum, message, reason, alertEntry = null) => {
    const historyEntry = {
      status,
      version: currentVersion,
      recordedChecksum: recordedChecksum || null,
      calculatedChecksum: calculatedChecksum || null,
      match: isMatch,
      checkedAt: new Date(checkedAt),
      checkedBy: user?._id || null,
      trigger,
      message: message || null,
      reason: reason || null,
    };

    const currentHistory = Array.isArray(fdr.integrityStatus?.history) ? [...fdr.integrityStatus.history] : [];
    const currentAlerts = Array.isArray(fdr.integrityStatus?.alerts) ? [...fdr.integrityStatus.alerts] : [];

    if (alertEntry) {
      currentAlerts.push(alertEntry);
    }

    fdr.integrityStatus = {
      status,
      lastCheckedAt: new Date(checkedAt),
      lastCheckedBy: user?._id || null,
      version: currentVersion,
      recordedChecksum: recordedChecksum || null,
      calculatedChecksum: calculatedChecksum || null,
      message: message || null,
      reason: reason || null,
      history: [...currentHistory, historyEntry],
      alerts: currentAlerts,
    };

    if (typeof fdr.save === 'function') {
      try {
        await fdr.save();
      } catch (saveErr) {
        console.error('Failed to save FDR integrityStatus:', saveErr.message);
      }
    } else if (mongoose.connection?.readyState === 1 && mongoose.isValidObjectId(fdr._id)) {
      try {
        await FDR.updateOne({ _id: fdr._id }, { $set: { integrityStatus: fdr.integrityStatus } });
      } catch (updateErr) {
        console.error('Failed to update FDR integrityStatus:', updateErr.message);
      }
    }
  };

  // If no document or checksum on record
  if (!storageRef || !recordedChecksum) {
    const reason = 'No uploaded document or original SHA-256 checksum is on record for this instrument.';
    await persistIntegrityOnFdr('unavailable', null, null, null, reason);
    return {
      status: 'unavailable',
      fdrId: String(fdr._id),
      fdrNumber: fdr.fdrNumber,
      fileName,
      version: currentVersion,
      recordedChecksum: recordedChecksum || null,
      calculatedChecksum: null,
      match: null,
      reason,
      checkedAt,
    };
  }

  let fileBuffer = null;
  try {
    fileBuffer = await readStoredDocument(storageRef);
  } catch (error) {
    const reason = `Stored document could not be retrieved from private repository: ${error.message || 'File not found'}`;
    await persistIntegrityOnFdr('unavailable', null, null, null, reason);
    return {
      status: 'unavailable',
      fdrId: String(fdr._id),
      fdrNumber: fdr.fdrNumber,
      fileName,
      version: currentVersion,
      recordedChecksum,
      calculatedChecksum: null,
      match: null,
      reason,
      checkedAt,
    };
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    const reason = 'The stored document in repository was empty or unreadable.';
    await persistIntegrityOnFdr('unavailable', null, null, null, reason);
    return {
      status: 'unavailable',
      fdrId: String(fdr._id),
      fdrNumber: fdr.fdrNumber,
      fileName,
      version: currentVersion,
      recordedChecksum,
      calculatedChecksum: null,
      match: null,
      reason,
      checkedAt,
    };
  }

  // Calculate fresh SHA-256 hash on backend
  const calculatedChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const isMatch = calculatedChecksum.toLowerCase() === recordedChecksum.toLowerCase();

  if (isMatch) {
    const message = 'Cryptographic integrity verified. Stored document byte contents match the recorded SHA-256 checksum exactly.';
    await persistIntegrityOnFdr('verified', true, calculatedChecksum, message, null);

    // Log verified audit event
    try {
      await recordAuditEvent({
        actor: user._id,
        actorRole: user.role,
        action: 'fdr_document_integrity_verified',
        entityId: fdr._id,
        outcome: 'success',
        reason: 'Cryptographic SHA-256 hash matches repository record perfectly. Document is unaltered.',
        documentVersion: currentVersion,
        documentChecksum: recordedChecksum,
        metadata: {
          fdrNumber: fdr.fdrNumber,
          fileName,
          recordedChecksum,
          calculatedChecksum,
          trigger,
        },
      });
    } catch (auditErr) {
      console.error('Failed to write audit event for document verification:', auditErr);
    }

    return {
      status: 'verified',
      fdrId: String(fdr._id),
      fdrNumber: fdr.fdrNumber,
      fileName,
      version: currentVersion,
      recordedChecksum,
      calculatedChecksum,
      match: true,
      message,
      checkedAt,
      historyCount: fdr.integrityStatus?.history?.length || 1,
    };
  }

  // Mismatch detected! File contents differ from the recorded hash
  const alertText = 'INTEGRITY MISMATCH: Stored document bytes differ from the recorded cryptographic checksum. File may have been altered or corrupted.';
  const alertEntry = {
    alertId: crypto.randomUUID(),
    documentVersion: currentVersion,
    expectedChecksum: recordedChecksum,
    observedChecksum: calculatedChecksum,
    detectedAt: new Date(checkedAt),
    status: 'active',
    severity: 'critical',
    notes: 'Cryptographic SHA-256 mismatch detected. File differs from recorded version.',
  };

  await persistIntegrityOnFdr('mismatch', false, calculatedChecksum, null, alertText, alertEntry);

  try {
    await recordAuditEvent({
      actor: user._id,
      actorRole: user.role,
      action: 'fdr_document_integrity_mismatch',
      entityId: fdr._id,
      outcome: 'failure',
      reason: `SECURITY ALERT: Stored document SHA-256 hash mismatch! Recorded: ${recordedChecksum}, Computed: ${calculatedChecksum}`,
      documentVersion: currentVersion,
      documentChecksum: recordedChecksum,
      diff: [
        {
          field: 'documentChecksum',
          previousValue: recordedChecksum,
          newValue: calculatedChecksum,
        },
      ],
      metadata: {
        fdrNumber: fdr.fdrNumber,
        fileName,
        recordedChecksum,
        calculatedChecksum,
        trigger,
        alertId: alertEntry.alertId,
      },
    });

    // Alert administrators via Notification
    await Notification.create({
      recipient: user._id,
      type: 'system_alert',
      title: 'DOCUMENT INTEGRITY MISMATCH DETECTED',
      message: `Integrity check failed for FDR ${fdr.fdrNumber}. Stored file (${fileName}) checksum differs from recorded hash. Potential unauthorized modification detected.`,
      metadata: {
        fdrId: String(fdr._id),
        fdrNumber: fdr.fdrNumber,
        recordedChecksum,
        calculatedChecksum,
        alertId: alertEntry.alertId,
      },
    });
  } catch (alertErr) {
    console.error('Failed to record mismatch alert:', alertErr);
  }

  return {
    status: 'mismatch',
    fdrId: String(fdr._id),
    fdrNumber: fdr.fdrNumber,
    fileName,
    version: currentVersion,
    recordedChecksum,
    calculatedChecksum,
    match: false,
    alert: alertText,
    checkedAt,
    alertId: alertEntry.alertId,
    historyCount: fdr.integrityStatus?.history?.length || 1,
  };
};

export const listIntegrityRecords = async ({ user, query = {} }) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 15));
  const skip = (page - 1) * limit;

  const filter = {
    workflowStatus: { $nin: ['released', 'expired'] },
    financialStatus: { $in: ['active', 'matured'] },
  };

  // Role Scoping
  if (institutionRoles.has(user?.role)) {
    const institutionId = user.institution?._id || user.institution;
    if (!institutionId) {
      throw new DocumentIntegrityError(404, 'No institution associated with current user.');
    }
    filter.institution = new mongoose.Types.ObjectId(institutionId);
  } else if (query.institutionId && mongoose.isValidObjectId(query.institutionId)) {
    filter.institution = new mongoose.Types.ObjectId(query.institutionId);
  }

  // Status Filter
  if (query.status && query.status !== 'all') {
    if (query.status === 'not_checked') {
      filter.$or = [
        { 'integrityStatus.status': 'not_checked' },
        { 'integrityStatus.status': { $exists: false } },
        { integrityStatus: null },
      ];
    } else if (query.status === 'unavailable') {
      filter.$or = [
        { 'integrityStatus.status': 'unavailable' },
        { 'documentMetadata.storageRef': { $in: [null, ''] } },
        { 'documentMetadata.checksum': { $in: [null, ''] } },
      ];
    } else {
      filter['integrityStatus.status'] = query.status;
    }
  }

  // Bank filter
  if (query.bankName) {
    filter.bankName = new RegExp(query.bankName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  // Search filter
  if (query.search) {
    const safeRegex = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { fdrNumber: safeRegex },
      { bankName: safeRegex },
      { 'documentMetadata.fileName': safeRegex },
      { branch: safeRegex },
    ];
  }

  const [totalCount, rawRecords, summaryResult] = await Promise.all([
    FDR.countDocuments(filter),
    FDR.find(filter)
      .populate('institution', 'name institutionCode')
      .sort({ 'integrityStatus.lastCheckedAt': -1, updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FDR.aggregate([
      {
        $match: {
          ...(filter.institution ? { institution: filter.institution } : {}),
          workflowStatus: { $nin: ['released', 'expired'] },
          financialStatus: { $in: ['active', 'matured'] },
        },
      },
      {
        $facet: {
          total: [{ $count: 'count' }],
          verified: [{ $match: { 'integrityStatus.status': 'verified' } }, { $count: 'count' }],
          mismatch: [{ $match: { 'integrityStatus.status': 'mismatch' } }, { $count: 'count' }],
          unavailable: [
            {
              $match: {
                $or: [
                  { 'integrityStatus.status': 'unavailable' },
                  { 'documentMetadata.storageRef': { $in: [null, ''] } },
                  { 'documentMetadata.checksum': { $in: [null, ''] } },
                ],
              },
            },
            { $count: 'count' },
          ],
        },
      },
    ]),
  ]);

  const facet = summaryResult[0] || {};
  const totalSummary = facet.total?.[0]?.count || 0;
  const verifiedSummary = facet.verified?.[0]?.count || 0;
  const mismatchSummary = facet.mismatch?.[0]?.count || 0;
  const unavailableSummary = facet.unavailable?.[0]?.count || 0;
  const notCheckedSummary = Math.max(0, totalSummary - verifiedSummary - mismatchSummary - unavailableSummary);

  const records = rawRecords.map((r) => {
    const hasDoc = Boolean(r.documentMetadata?.storageRef && r.documentMetadata?.checksum);
    let resolvedStatus = r.integrityStatus?.status || (hasDoc ? 'not_checked' : 'unavailable');
    if (!hasDoc) resolvedStatus = 'unavailable';

    const alerts = Array.isArray(r.integrityStatus?.alerts) ? r.integrityStatus.alerts : [];
    const activeAlerts = alerts.filter((a) => a.status === 'active');

    return {
      fdrId: String(r._id),
      fdrNumber: r.fdrNumber,
      institution: r.institution ? {
        id: String(r.institution._id || r.institution),
        name: r.institution.name || 'Unknown Institution',
        institutionCode: r.institution.institutionCode || 'N/A',
      } : null,
      bankName: r.bankName || 'N/A',
      branch: r.branch || 'N/A',
      amount: r.amount || 0,
      documentName: r.documentMetadata?.fileName || 'statutory_instrument.pdf',
      documentVersion: r.documentMetadata?.version || 1,
      uploadedAt: r.documentMetadata?.uploadedAt || r.createdAt,
      lastCheckedAt: r.integrityStatus?.lastCheckedAt || null,
      status: resolvedStatus,
      recordedChecksum: r.documentMetadata?.checksum || null,
      calculatedChecksum: r.integrityStatus?.calculatedChecksum || null,
      match: resolvedStatus === 'verified' ? true : resolvedStatus === 'mismatch' ? false : null,
      hasActiveAlert: activeAlerts.length > 0,
      activeAlertsCount: activeAlerts.length,
      historyCount: Array.isArray(r.integrityStatus?.history) ? r.integrityStatus.history.length : 0,
      lastResult: r.integrityStatus?.message || r.integrityStatus?.reason || null,
    };
  });

  return {
    records,
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
    },
    summary: {
      total: totalSummary,
      verified: verifiedSummary,
      mismatch: mismatchSummary,
      unavailable: unavailableSummary,
      notChecked: notCheckedSummary,
      notCheckedOrUnavailable: notCheckedSummary + unavailableSummary,
    },
  };
};

export const getFdrIntegrityHistory = async ({ fdrId, user }) => {
  if (!mongoose.isValidObjectId(fdrId)) {
    throw new DocumentIntegrityError(400, 'Invalid FDR ID.');
  }

  const fdr = await FDR.findById(fdrId).populate('institution', 'name institutionCode');
  if (!fdr) {
    throw new DocumentIntegrityError(404, 'FDR record not found.');
  }

  if (institutionRoles.has(user?.role)) {
    const userInstitutionId = user.institution?._id || user.institution;
    const recordInstitutionId = fdr.institution?._id || fdr.institution;
    if (!userInstitutionId || !recordInstitutionId || String(userInstitutionId) !== String(recordInstitutionId)) {
      throw new DocumentIntegrityError(403, 'Permission denied.');
    }
  }

  return {
    fdrId: String(fdr._id),
    fdrNumber: fdr.fdrNumber,
    institution: fdr.institution ? {
      id: String(fdr.institution._id || fdr.institution),
      name: fdr.institution.name,
      institutionCode: fdr.institution.institutionCode,
    } : null,
    documentMetadata: {
      fileName: fdr.documentMetadata?.fileName,
      version: fdr.documentMetadata?.version || 1,
      checksum: fdr.documentMetadata?.checksum,
      uploadedAt: fdr.documentMetadata?.uploadedAt,
    },
    integrityStatus: fdr.integrityStatus || { status: 'not_checked' },
    history: fdr.integrityStatus?.history || [],
    alerts: fdr.integrityStatus?.alerts || [],
  };
};

export const investigateIntegrityAlert = async ({ fdrId, alertId, user, payload }) => {
  if (!officialRoles.has(user?.role)) {
    throw new DocumentIntegrityError(403, 'Only authorized officials may record alert investigation outcomes.');
  }

  if (!mongoose.isValidObjectId(fdrId)) {
    throw new DocumentIntegrityError(400, 'Invalid FDR ID.');
  }

  const fdr = await FDR.findById(fdrId);
  if (!fdr) {
    throw new DocumentIntegrityError(404, 'FDR record not found.');
  }

  const alerts = fdr.integrityStatus?.alerts || [];
  const alertIndex = alerts.findIndex((a) => a.alertId === alertId || String(a._id) === alertId);
  if (alertIndex === -1) {
    throw new DocumentIntegrityError(404, 'Integrity alert not found.');
  }

  const validStatuses = ['investigating', 'acknowledged', 'resolved', 'dismissed'];
  const newStatus = validStatuses.includes(payload.status) ? payload.status : 'investigating';
  const notes = String(payload.notes || '').trim();
  const investigationOutcome = String(payload.investigationOutcome || notes).trim();

  alerts[alertIndex].status = newStatus;
  alerts[alertIndex].notes = notes;
  alerts[alertIndex].investigationOutcome = investigationOutcome;
  alerts[alertIndex].investigatedBy = user._id;
  alerts[alertIndex].investigatedAt = new Date();

  fdr.integrityStatus.alerts = alerts;
  await fdr.save();

  // Audit investigation event
  try {
    await recordAuditEvent({
      actor: user._id,
      actorRole: user.role,
      action: 'fdr_integrity_alert_investigated',
      entityId: fdr._id,
      outcome: 'success',
      reason: `Integrity alert ${alertId} updated to ${newStatus}: ${investigationOutcome.slice(0, 200)}`,
      documentVersion: alerts[alertIndex].documentVersion,
      documentChecksum: alerts[alertIndex].expectedChecksum,
      metadata: {
        alertId,
        newStatus,
        investigationOutcome,
        notes,
      },
    });
  } catch (auditErr) {
    console.error('Failed to log alert investigation audit event:', auditErr);
  }

  return {
    success: true,
    alert: alerts[alertIndex],
    message: `Integrity alert status updated to ${newStatus}.`,
  };
};

export const runBulkIntegrityCheck = async ({ user, fdrIds = null }) => {
  const filter = {
    workflowStatus: { $nin: ['released', 'expired'] },
    financialStatus: { $in: ['active', 'matured'] },
    'documentMetadata.storageRef': { $exists: true, $ne: null },
  };

  if (institutionRoles.has(user?.role)) {
    const institutionId = user.institution?._id || user.institution;
    if (!institutionId) {
      throw new DocumentIntegrityError(404, 'No institution associated with user.');
    }
    filter.institution = new mongoose.Types.ObjectId(institutionId);
  }

  if (Array.isArray(fdrIds) && fdrIds.length > 0) {
    filter._id = { $in: fdrIds.filter(mongoose.isValidObjectId).map((id) => new mongoose.Types.ObjectId(id)) };
  }

  const candidates = await FDR.find(filter).select('_id fdrNumber').limit(50);
  const results = [];

  for (const doc of candidates) {
    try {
      const res = await verifyStoredDocumentIntegrity({ fdrId: doc._id, user, trigger: 'batch' });
      results.push(res);
    } catch (err) {
      results.push({
        status: 'error',
        fdrId: String(doc._id),
        fdrNumber: doc.fdrNumber,
        error: err.message,
      });
    }
  }

  const verifiedCount = results.filter((r) => r.status === 'verified').length;
  const mismatchCount = results.filter((r) => r.status === 'mismatch').length;
  const unavailableCount = results.filter((r) => r.status === 'unavailable').length;

  return {
    totalChecked: results.length,
    verifiedCount,
    mismatchCount,
    unavailableCount,
    results,
  };
};
