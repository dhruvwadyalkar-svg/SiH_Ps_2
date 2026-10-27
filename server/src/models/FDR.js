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
      enum: ['pending', 'completed', 'failed', 'not_started'],
      default: 'not_started',
    },
    extractedData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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
      min: 0,
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
      enum: ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'expired', 'released'],
      default: 'draft',
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
fdrSchema.index({ workflowStatus: 1 });
fdrSchema.index({ maturityDate: 1 });

fdrSchema.path('maturityDate').validate(function validateMaturityDate(value) {
  if (!this.issueDate || !value) {
    return true;
  }

  return new Date(value) > new Date(this.issueDate);
}, 'Maturity date must be later than issue date.');

const FDR = mongoose.model('FDR', fdrSchema);

export default FDR;
