import mongoose from 'mongoose';
import AuditLog, {
  GENESIS_HASH,
  canonicalPayloadFromDoc,
  canonicalStringify,
  computeEventHash,
} from '../models/AuditLog.js';
import FDR from '../models/FDR.js';

const officialRoles = new Set(['aicte_admin', 'reviewer']);

export class AuditServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const requireOfficial = (user) => {
  if (!user || !officialRoles.has(user.role)) {
    throw new AuditServiceError(403, 'Only authorized AICTE officials may access the audit trail.');
  }
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sanitizeCsvCell = (value) => {
  if (value === null || value === undefined) return '';
  let str = String(value).trim();
  // Prevent CSV injection: if value begins with =, +, -, @, prefix with a single quote
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const recordAuditEvent = async (
  {
    actor,
    actorRole,
    action,
    entityType = 'FDR',
    entityId,
    outcome = 'success',
    reason = null,
    correlationId = null,
    documentVersion = 1,
    documentChecksum = null,
    diff = [],
    metadata = {},
  },
  { session } = {},
) => {
  let actorId = null;
  let resolvedRole = actorRole || null;

  if (actor) {
    if (typeof actor === 'object') {
      actorId = actor._id || actor.id || null;
      if (!resolvedRole && actor.role) {
        resolvedRole = actor.role;
      }
    } else {
      actorId = actor;
    }
  }

  const auditEntry = new AuditLog({
    actor: actorId,
    actorRole: resolvedRole,
    action,
    entityType,
    entityId,
    outcome,
    reason,
    correlationId,
    documentVersion,
    documentChecksum,
    diff,
    metadata,
  });

  if (session) {
    return await auditEntry.save({ session });
  }
  return await auditEntry.save();
};

export const verifyAuditChainIntegrity = async () => {
  const entries = await AuditLog.find({ sequence: { $ne: null } })
    .sort({ sequence: 1 })
    .lean();

  if (entries.length === 0) {
    return {
      status: 'valid',
      totalEvents: 0,
      verifiedCount: 0,
      brokenEvents: [],
      genesisHash: GENESIS_HASH,
      latestHash: null,
      message: 'Audit chain is empty.',
      verifiedAt: new Date().toISOString(),
    };
  }

  let expectedPreviousHash = GENESIS_HASH;
  let expectedSequence = 1;
  const brokenEvents = [];

  for (const entry of entries) {
    const issues = [];

    // 1. Check sequence continuity
    if (entry.sequence !== expectedSequence) {
      issues.push(`Sequence mismatch: expected ${expectedSequence}, but found ${entry.sequence}`);
    }

    // 2. Check previous hash reference
    if (entry.previousHash !== expectedPreviousHash) {
      issues.push(`Previous hash link broken: expected ${expectedPreviousHash}, but recorded ${entry.previousHash}`);
    }

    // 3. Recompute canonical hash
    const payload = canonicalPayloadFromDoc(entry);
    const recalculatedHash = computeEventHash(payload, entry.previousHash);

    if (entry.hash !== recalculatedHash) {
      issues.push(`Event content altered: recorded hash ${entry.hash} does not match computed hash ${recalculatedHash}`);
    }

    if (issues.length > 0) {
      brokenEvents.push({
        id: String(entry._id),
        sequence: entry.sequence,
        action: entry.action,
        timestamp: entry.createdAt,
        expectedHash: recalculatedHash,
        recordedHash: entry.hash,
        previousHash: entry.previousHash,
        reasons: issues,
      });
    }

    expectedPreviousHash = entry.hash;
    expectedSequence = entry.sequence + 1;
  }

  const isValid = brokenEvents.length === 0;

  return {
    status: isValid ? 'valid' : 'corrupted',
    totalEvents: entries.length,
    verifiedCount: entries.length - brokenEvents.length,
    brokenEvents,
    genesisHash: GENESIS_HASH,
    latestHash: entries[entries.length - 1]?.hash || null,
    message: isValid
      ? `Cryptographic audit chain intact: All ${entries.length} log events verified without discrepancy.`
      : `Integrity breach detected: ${brokenEvents.length} log event(s) failed cryptographic verification.`,
    verifiedAt: new Date().toISOString(),
  };
};

export const listAuditLogs = async ({ user, query }) => {
  requireOfficial(user);

  const filter = {};

  if (query.action) {
    filter.action = query.action;
  }

  if (query.outcome) {
    filter.outcome = query.outcome;
  }

  if (query.entityId) {
    if (mongoose.isValidObjectId(query.entityId)) {
      filter.entityId = query.entityId;
    }
  }

  if (query.actorId) {
    if (mongoose.isValidObjectId(query.actorId)) {
      filter.actor = query.actorId;
    }
  }

  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) {
      const from = new Date(query.dateFrom);
      if (!Number.isNaN(from.getTime())) {
        filter.createdAt.$gte = from;
      }
    }
    if (query.dateTo) {
      const to = new Date(query.dateTo);
      if (!Number.isNaN(to.getTime())) {
        filter.createdAt.$lte = to;
      }
    }
  }

  if (query.search) {
    const searchPattern = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [
      { action: searchPattern },
      { reason: searchPattern },
      { 'metadata.fdrNumber': searchPattern },
      { 'metadata.fileName': searchPattern },
      { actorRole: searchPattern },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.max(1, Math.min(Number(query.limit) || 20, 100));
  const skip = (page - 1) * limit;

  const [total, records, verifiedChecks, failedIntegrityChecks, recentModifications, approvalsCount, rejectionsCount] =
    await Promise.all([
      AuditLog.countDocuments(filter),
      AuditLog.find(filter)
        .populate('actor', 'fullName email role')
        .sort({ sequence: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments({ action: 'fdr_document_integrity_verified' }),
      AuditLog.countDocuments({
        $or: [{ action: 'fdr_document_integrity_mismatch' }, { outcome: 'failure' }],
      }),
      AuditLog.countDocuments({
        action: { $in: ['fdr_record_updated', 'fdr_metadata_updated'] },
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
      AuditLog.countDocuments({
        $or: [{ action: 'fdr_approved' }, { 'metadata.decision': 'approved' }],
      }),
      AuditLog.countDocuments({
        $or: [{ action: 'fdr_rejected' }, { 'metadata.decision': 'reject_submission' }],
      }),
    ]);

  // Lookup FDR numbers for records if entityType === 'FDR'
  const fdrIds = records
    .filter((r) => r.entityType === 'FDR' && r.entityId && !r.metadata?.fdrNumber)
    .map((r) => r.entityId);

  let fdrMap = new Map();
  if (fdrIds.length > 0) {
    const fdrs = await FDR.find({ _id: { $in: fdrIds } })
      .select('fdrNumber bankName')
      .lean();
    fdrMap = new Map(fdrs.map((f) => [String(f._id), f]));
  }

  const formattedRecords = records.map((r) => {
    const fdrInfo = r.entityId ? fdrMap.get(String(r.entityId)) : null;
    return {
      id: String(r._id),
      sequence: r.sequence,
      action: r.action,
      actor: r.actor
        ? {
            id: String(r.actor._id || r.actor),
            fullName: r.actor.fullName || 'System User',
            email: r.actor.email || null,
            role: r.actorRole || r.actor.role || null,
          }
        : {
            id: null,
            fullName: 'System Automation',
            email: null,
            role: r.actorRole || 'system',
          },
      actorRole: r.actorRole || r.actor?.role || 'system',
      entityType: r.entityType,
      entityId: r.entityId ? String(r.entityId) : null,
      fdrNumber: r.metadata?.fdrNumber || fdrInfo?.fdrNumber || null,
      bankName: r.metadata?.bankName || fdrInfo?.bankName || null,
      outcome: r.outcome || 'success',
      reason: r.reason || null,
      correlationId: r.correlationId || null,
      documentVersion: r.documentVersion || 1,
      documentChecksum: r.documentChecksum || null,
      diffCount: Array.isArray(r.diff) ? r.diff.length : 0,
      diff: r.diff || [],
      metadata: r.metadata || {},
      previousHash: r.previousHash,
      hash: r.hash,
      createdAt: r.createdAt,
    };
  });

  return {
    records: formattedRecords,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
    summary: {
      totalEvents: total,
      verifiedChecks,
      failedIntegrityChecks,
      recentModifications,
      approvalsCount,
      rejectionsCount,
    },
  };
};

export const getAuditLogDetails = async ({ user, logId }) => {
  requireOfficial(user);

  if (!mongoose.isValidObjectId(logId)) {
    throw new AuditServiceError(400, 'Invalid audit log ID.');
  }

  const log = await AuditLog.findById(logId).populate('actor', 'fullName email role').lean();
  if (!log) {
    throw new AuditServiceError(404, 'Audit event not found.');
  }

  let fdrRecord = null;
  if (log.entityType === 'FDR' && log.entityId) {
    fdrRecord = await FDR.findById(log.entityId)
      .populate('institution', 'name institutionCode')
      .select('fdrNumber bankName branch amount currency workflowStatus documentMetadata')
      .lean();
  }

  // Recalculate hash on the fly to confirm single-event integrity
  const payload = canonicalPayloadFromDoc(log);
  const recomputedHash = computeEventHash(payload, log.previousHash);
  const isHashValid = log.hash === recomputedHash;

  return {
    id: String(log._id),
    sequence: log.sequence,
    action: log.action,
    actor: log.actor
      ? {
          id: String(log.actor._id),
          fullName: log.actor.fullName,
          email: log.actor.email,
          role: log.actorRole || log.actor.role,
        }
      : {
          id: null,
          fullName: 'System Automation',
          email: null,
          role: log.actorRole || 'system',
        },
    actorRole: log.actorRole || log.actor?.role || 'system',
    entityType: log.entityType,
    entityId: log.entityId ? String(log.entityId) : null,
    outcome: log.outcome,
    reason: log.reason,
    correlationId: log.correlationId,
    documentVersion: log.documentVersion || 1,
    documentChecksum: log.documentChecksum,
    diff: log.diff || [],
    metadata: log.metadata || {},
    previousHash: log.previousHash,
    hash: log.hash,
    computedHash: recomputedHash,
    isHashValid,
    createdAt: log.createdAt,
    fdr: fdrRecord
      ? {
          id: String(fdrRecord._id),
          fdrNumber: fdrRecord.fdrNumber,
          bankName: fdrRecord.bankName,
          branch: fdrRecord.branch,
          amount: fdrRecord.amount,
          currency: fdrRecord.currency,
          workflowStatus: fdrRecord.workflowStatus,
          institution: fdrRecord.institution
            ? {
                name: fdrRecord.institution.name,
                code: fdrRecord.institution.institutionCode,
              }
            : null,
          documentMetadata: fdrRecord.documentMetadata || null,
        }
      : null,
  };
};

export const exportAuditLogsCsv = async ({ user, query }) => {
  requireOfficial(user);

  const filter = {};
  if (query.action) filter.action = query.action;
  if (query.outcome) filter.outcome = query.outcome;
  if (query.entityId && mongoose.isValidObjectId(query.entityId)) filter.entityId = query.entityId;

  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.createdAt.$lte = new Date(query.dateTo);
  }

  if (query.search) {
    const searchPattern = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [
      { action: searchPattern },
      { reason: searchPattern },
      { 'metadata.fdrNumber': searchPattern },
      { actorRole: searchPattern },
    ];
  }

  const records = await AuditLog.find(filter)
    .populate('actor', 'fullName email role')
    .sort({ sequence: -1, createdAt: -1 })
    .limit(5000)
    .lean();

  const generatedAt = new Date().toISOString();
  const filtersApplied = JSON.stringify({
    action: query.action || 'all',
    outcome: query.outcome || 'all',
    dateFrom: query.dateFrom || 'all',
    dateTo: query.dateTo || 'all',
    search: query.search || 'none',
  });

  const headers = [
    'Sequence',
    'Event ID',
    'Timestamp (UTC)',
    'Actor Name',
    'Actor Email',
    'Actor Role',
    'Action',
    'Entity Type',
    'Entity ID',
    'FDR Number',
    'Outcome',
    'Reason / Comments',
    'Changed Fields',
    'Document Version',
    'Document SHA-256 Checksum',
    'Previous Block Hash',
    'Current Block Hash',
  ];

  const rows = records.map((r) => {
    const changedFields = Array.isArray(r.diff) && r.diff.length > 0
      ? r.diff.map((d) => `${d.field}: ${d.previousValue ?? 'null'} -> ${d.newValue ?? 'null'}`).join('; ')
      : '';

    return [
      sanitizeCsvCell(r.sequence),
      sanitizeCsvCell(String(r._id)),
      sanitizeCsvCell(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
      sanitizeCsvCell(r.actor?.fullName || 'System Automation'),
      sanitizeCsvCell(r.actor?.email || 'system@aicte-india.org'),
      sanitizeCsvCell(r.actorRole || r.actor?.role || 'system'),
      sanitizeCsvCell(r.action),
      sanitizeCsvCell(r.entityType),
      sanitizeCsvCell(r.entityId ? String(r.entityId) : ''),
      sanitizeCsvCell(r.metadata?.fdrNumber || ''),
      sanitizeCsvCell(r.outcome || 'success'),
      sanitizeCsvCell(r.reason || ''),
      sanitizeCsvCell(changedFields),
      sanitizeCsvCell(r.documentVersion || 1),
      sanitizeCsvCell(r.documentChecksum || ''),
      sanitizeCsvCell(r.previousHash || ''),
      sanitizeCsvCell(r.hash || ''),
    ].join(',');
  });

  const csvContent = [
    `# AICTE Central Fixed Deposit Receipt Portal - Tamper-Evident Audit Report`,
    `# Generated At (UTC): ${generatedAt}`,
    `# Applied Filters: ${filtersApplied}`,
    `# Total Events Exported: ${records.length}`,
    headers.join(','),
    ...rows,
  ].join('\r\n');

  // Record audit event for the export itself
  try {
    await recordAuditEvent({
      actor: user._id,
      actorRole: user.role,
      action: 'audit_trail_exported',
      entityType: 'AuditLog',
      outcome: 'success',
      reason: `Authorized official exported ${records.length} audit trail records to CSV`,
      metadata: { recordsCount: records.length, generatedAt, query },
    });
  } catch (err) {
    // Non-blocking
  }

  return csvContent;
};

