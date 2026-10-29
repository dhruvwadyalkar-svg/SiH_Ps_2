import crypto from 'node:crypto';
import mongoose from 'mongoose';

export const GENESIS_HASH = '0'.repeat(64);

export const canonicalStringify = (value) => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (typeof value.toHexString === 'function') {
    return JSON.stringify(value.toHexString());
  }
  const plain = typeof value.toObject === 'function' ? value.toObject() : value;
  const keys = Object.keys(plain).sort();
  return '{' + keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(plain[key])}`).join(',') + '}';
};

export const canonicalPayloadFromDoc = (doc) => {
  const ts = doc.createdAt instanceof Date ? doc.createdAt.toISOString() : (doc.createdAt || new Date().toISOString());
  return {
    action: doc.action,
    actor: doc.actor ? String(doc.actor._id || doc.actor) : null,
    actorRole: doc.actorRole || null,
    correlationId: doc.correlationId || null,
    diff: Array.isArray(doc.diff)
      ? doc.diff
          .map((d) => ({
            field: d.field,
            newValue: d.newValue ?? null,
            previousValue: d.previousValue ?? null,
          }))
          .sort((a, b) => a.field.localeCompare(b.field))
      : [],
    documentChecksum: doc.documentChecksum || null,
    documentVersion: doc.documentVersion ?? 1,
    entityId: doc.entityId ? String(doc.entityId._id || doc.entityId) : null,
    entityType: doc.entityType,
    metadata: doc.metadata || {},
    outcome: doc.outcome || 'success',
    reason: doc.reason || null,
    sequence: doc.sequence,
    timestamp: ts,
  };
};

export const computeEventHash = (canonicalPayload, previousHash) => {
  const normalizedObject = {
    ...canonicalPayload,
    previousHash,
  };
  const canonicalString = canonicalStringify(normalizedObject);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
};

const auditDiffSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const auditLogSchema = new mongoose.Schema(
  {
    sequence: {
      type: Number,
      index: true,
      default: null,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorRole: {
      type: String,
      enum: ['institution_admin', 'institution_user', 'aicte_admin', 'reviewer', 'system', null],
      default: null,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    entityType: {
      type: String,
      required: true,
      enum: ['Institution', 'User', 'FDR', 'Document', 'AuditLog', 'ReleaseRequest'],
      default: 'FDR',
      trim: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    outcome: {
      type: String,
      enum: ['success', 'failure', 'warning'],
      default: 'success',
    },
    reason: {
      type: String,
      default: null,
      trim: true,
    },
    correlationId: {
      type: String,
      default: null,
    },
    documentVersion: {
      type: Number,
      default: 1,
    },
    documentChecksum: {
      type: String,
      default: null,
      trim: true,
    },
    diff: {
      type: [auditDiffSchema],
      default: [],
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    previousHash: {
      type: String,
      default: null,
      maxlength: 64,
    },
    hash: {
      type: String,
      default: null,
      maxlength: 64,
      index: true,
    },
  },
  { timestamps: true },
);

auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ sequence: 1 });
auditLogSchema.index({ outcome: 1, createdAt: -1 });

auditLogSchema.pre('save', async function preSaveAuditLog() {
  if (!this.createdAt) {
    this.createdAt = new Date();
  }
  if (!this.sequence || !this.hash) {
    const session = this.$session ? this.$session() : null;
    const query = this.constructor
      .findOne({ sequence: { $ne: null } })
      .sort({ sequence: -1 })
      .select('sequence hash')
      .lean();

    if (session) {
      query.session(session);
    }

    const latest = await query;
    this.sequence = latest?.sequence ? latest.sequence + 1 : 1;
    this.previousHash = latest?.hash || GENESIS_HASH;

    const payload = canonicalPayloadFromDoc(this);
    this.hash = computeEventHash(payload, this.previousHash);
  }
});

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export default AuditLog;
