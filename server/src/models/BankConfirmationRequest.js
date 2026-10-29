import mongoose from 'mongoose';

export const BANK_CONFIRMATION_STATUSES = [
  'draft',
  'pending_submission',
  'submitted_to_bank',
  'awaiting_bank_response',
  'confirmed',
  'discrepancy_found',
  'unable_to_verify',
  'closed',
];

export const SUBMISSION_METHODS = [
  'official_letter',
  'registered_post_courier',
  'bank_portal',
  'official_email',
  'branch_visit',
  'other',
];

export const EVIDENCE_DOCUMENT_TYPES = [
  'inquiry_letter',
  'courier_receipt',
  'bank_letter',
  'bank_email',
  'discrepancy_memo',
  'other',
];

const evidenceDocumentSchema = new mongoose.Schema(
  {
    storageRef: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    fileSize: { type: Number, required: true },
    checksum: { type: String, default: null },
    documentType: {
      type: String,
      enum: EVIDENCE_DOCUMENT_TYPES,
      default: 'bank_letter',
    },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: true },
);

const historyEntrySchema = new mongoose.Schema(
  {
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedByName: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now },
    reason: { type: String, required: true, trim: true },
    notes: { type: String, default: null },
    evidenceDocumentRef: { type: String, default: null },
  },
  { _id: true },
);

const discrepanciesSchema = new mongoose.Schema(
  {
    amountMismatch: { type: Boolean, default: false },
    datesMismatch: { type: Boolean, default: false },
    lienNotMarked: { type: Boolean, default: false },
    beneficiaryMismatch: { type: Boolean, default: false },
    accountNumberMismatch: { type: Boolean, default: false },
    other: { type: Boolean, default: false },
    notes: { type: String, default: null },
  },
  { _id: false },
);

const bankResponseSchema = new mongoose.Schema(
  {
    responseDate: { type: Date, default: null },
    recordedAt: { type: Date, default: null },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    responseReference: { type: String, default: null, trim: true },
    responderName: { type: String, default: null, trim: true },
    responderDesignation: { type: String, default: null, trim: true },
    responderContact: { type: String, default: null, trim: true },
    outcome: {
      type: String,
      enum: ['confirmed', 'discrepancy_found', 'unable_to_verify', 'clarification_requested', null],
      default: null,
    },
    discrepancies: { type: discrepanciesSchema, default: () => ({}) },
    clarificationDetails: { type: String, default: null },
    generalNotes: { type: String, default: null },
  },
  { _id: false },
);

const submissionDetailsSchema = new mongoose.Schema(
  {
    submissionDate: { type: Date, default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    submissionMethod: {
      type: String,
      enum: [...SUBMISSION_METHODS, null],
      default: null,
    },
    dispatchReference: { type: String, default: null, trim: true },
    recipientBranchContact: { type: String, default: null, trim: true },
    notes: { type: String, default: null },
  },
  { _id: false },
);

const deadlineDetailsSchema = new mongoose.Schema(
  {
    deadlineDays: { type: Number, default: 15, min: 1, max: 90 },
    responseDeadline: { type: Date, default: null },
    escalationLevel: {
      type: String,
      enum: ['normal', 'warning', 'overdue', 'critical_overdue'],
      default: 'normal',
    },
    lastEscalatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const bankConfirmationRequestSchema = new mongoose.Schema(
  {
    fdr: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FDR',
      required: true,
      index: true,
    },
    fdrNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institution',
      required: true,
      index: true,
    },
    institutionName: {
      type: String,
      trim: true,
      default: null,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    branch: {
      type: String,
      required: true,
      trim: true,
    },
    requestReference: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: BANK_CONFIRMATION_STATUSES,
      default: 'pending_submission',
      index: true,
    },
    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    initiatedByName: {
      type: String,
      default: null,
    },
    assignedOfficial: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    assignedOfficialName: {
      type: String,
      default: null,
    },
    requestDate: {
      type: Date,
      default: Date.now,
      required: true,
    },
    submissionDetails: {
      type: submissionDetailsSchema,
      default: () => ({}),
    },
    deadlineDetails: {
      type: deadlineDetailsSchema,
      default: () => ({}),
    },
    bankResponse: {
      type: bankResponseSchema,
      default: () => ({}),
    },
    evidenceDocuments: {
      type: [evidenceDocumentSchema],
      default: [],
    },
    remarks: {
      type: String,
      default: null,
      trim: true,
    },
    notificationsSent: {
      upcomingWarningSentAt: { type: Date, default: null },
      overdueSentAt: { type: Date, default: null },
      criticalOverdueSentAt: { type: Date, default: null },
    },
    history: {
      type: [historyEntrySchema],
      default: [],
    },
  },
  { timestamps: true },
);

bankConfirmationRequestSchema.index({ institution: 1, createdAt: -1 });
bankConfirmationRequestSchema.index({ fdr: 1, createdAt: -1 });
bankConfirmationRequestSchema.index({ status: 1, 'deadlineDetails.responseDeadline': 1 });

const BankConfirmationRequest = mongoose.model('BankConfirmationRequest', bankConfirmationRequestSchema);

export default BankConfirmationRequest;

