import mongoose from 'mongoose';

const documentMetadataSchema = new mongoose.Schema(
  {
    storageRef: {
      type: String,
      default: null,
    },
    fileName: {
      type: String,
      default: null,
      trim: true,
    },
    mimeType: {
      type: String,
      default: null,
      trim: true,
    },
    fileSize: {
      type: Number,
      min: 0,
      default: null,
    },
    checksum: {
      type: String,
      default: null,
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const ocrResultSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        'not_started',
        'submitting',
        'queued',
        'processing',
        'completed',
        'partially_completed',
        'failed',
        'rejected',
        'pending',
      ],
      default: 'not_started',
    },
    providerJobId: {
      type: String,
      default: null,
      select: false,
      maxlength: 200,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    extractedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    comparisonResults: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    providerErrorCode: {
      type: String,
      enum: [
        null,
        'not_configured',
        'invalid_api_key',
        'rate_limited',
        'provider_timeout',
        'provider_unavailable',
        'provider_error',
        'malformed_response',
        'document_too_large',
        'document_rejected',
        'too_many_pages',
        'unsupported_document',
      ],
      default: null,
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const verificationResultSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'passed', 'failed', 'not_started'],
      default: 'not_started',
    },
    summary: {
      type: String,
      default: null,
      trim: true,
    },
    checkedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const reviewMetadataSchema = new mongoose.Schema(
  {
    decision: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'needs_revision'],
      default: 'pending',
    },
    reviewerNotes: {
      type: String,
      default: null,
      trim: true,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const reviewDecisionSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: {
      type: String,
      enum: ['institution_admin', 'institution_user', 'aicte_admin', 'reviewer'],
      required: true,
    },
    decision: {
      type: String,
      enum: ['request_correction', 'reject_submission', 'complete_review', 'resubmit'],
      required: true,
    },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    previousStatus: { type: String, required: true },
    nextStatus: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: true },
);

const fdrSchema = new mongoose.Schema(
  {
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institution',
      required: true,
      index: true,
    },
    fdrNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
    },
    branch: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      default: 'INR',
    },
    issueDate: {
      type: Date,
      required: true,
    },
    maturityDate: {
      type: Date,
      required: true,
    },
    documentMetadata: {
      type: documentMetadataSchema,
      default: {},
    },
    workflowStatus: {
      type: String,
      enum: [
        'draft',
        'submitted',
        'under_review',
        'correction_requested',
        'review_completed',
        'approved',
        'rejected',
        'expired',
        'released',
      ],
      default: 'draft',
    },
    submittedAt: {
      type: Date,
      default: null,
    },
    replacesFdr: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FDR',
      default: null,
    },
    reviewHistory: {
      type: [reviewDecisionSchema],
      default: [],
    },
    reviewerConfirmedDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    financialStatus: {
      type: String,
      enum: ['active', 'matured', 'renewed', 'released', 'cancelled'],
      default: 'active',
    },
    ocrResult: {
      type: ocrResultSchema,
      default: {},
    },
    latestForensicAnalysis: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ForensicAnalysis',
      default: null,
    },
    verificationResult: {
      type: verificationResultSchema,
      default: {},
    },
    reviewer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewMetadata: {
      type: reviewMetadataSchema,
      default: {},
    },
  },
  { timestamps: true },
);

fdrSchema.index({ institution: 1, fdrNumber: 1 }, { unique: true });
fdrSchema.index({ institution: 1, bankName: 1 });
fdrSchema.index({ workflowStatus: 1 });
fdrSchema.index({ maturityDate: 1 });
fdrSchema.index({ workflowStatus: 1, financialStatus: 1, maturityDate: 1 });
fdrSchema.index({ replacesFdr: 1, workflowStatus: 1 });
fdrSchema.index(
  { replacesFdr: 1 },
  { unique: true, partialFilterExpression: { replacesFdr: { $type: 'objectId' } } },
);

fdrSchema.path('maturityDate').validate(function validateMaturityDate(value) {
  if (!this.issueDate || !value) {
    return true;
  }

  return new Date(value) > new Date(this.issueDate);
}, 'Maturity date must be later than issue date.');

const FDR = mongoose.model('FDR', fdrSchema);

export default FDR;
