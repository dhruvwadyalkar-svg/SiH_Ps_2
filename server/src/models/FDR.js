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
    version: {
      type: Number,
      default: 1,
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
    requestedLanguage: {
      type: String,
      default: 'en-IN',
    },
    languageName: {
      type: String,
      default: 'English (India)',
    },
    providerMetadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    lowConfidenceFields: {
      type: [String],
      default: [],
    },
    missingFields: {
      type: [String],
      default: [],
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

const trustScoreSignalSchema = new mongoose.Schema(
  {
    category: { type: String, required: true },
    label: { type: String, required: true },
    status: {
      type: String,
      enum: ['passed', 'warning', 'failed', 'not_assessed', 'missing_data'],
      required: true,
    },
    score: { type: Number, required: true, default: 0 },
    maxScore: { type: Number, required: true, default: 0 },
    impact: { type: String, enum: ['positive', 'negative', 'neutral'], required: true },
    details: { type: String, required: true },
    sourceReference: { type: String, default: null },
  },
  { _id: false },
);

const trustScoreHistorySchema = new mongoose.Schema(
  {
    score: { type: Number, required: true },
    category: { type: String, required: true },
    evidenceCoverage: { type: Number, required: true },
    version: { type: String, required: true },
    calculatedAt: { type: Date, required: true, default: Date.now },
    summary: { type: String, required: true },
    trigger: { type: String, required: true },
  },
  { _id: true },
);

const trustScoreSchema = new mongoose.Schema(
  {
    score: { type: Number, min: 0, max: 100, default: null },
    category: {
      type: String,
      enum: [
        'low_observed_risk',
        'review_recommended',
        'high_review_priority',
        'insufficient_evidence',
        null,
      ],
      default: null,
    },
    evidenceCoverage: { type: Number, min: 0, max: 100, default: 0 },
    version: { type: String, default: '1.0.0' },
    calculatedAt: { type: Date, default: null },
    signals: { type: [trustScoreSignalSchema], default: [] },
    positiveFindings: { type: [String], default: [] },
    riskFindings: { type: [String], default: [] },
    missingData: { type: [String], default: [] },
    unavailableChecks: { type: [String], default: [] },
    summary: { type: String, default: null },
  },
  { _id: false },
);

const riskFindingSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    points: { type: Number, required: true, default: 0 },
    category: { type: String, required: true },
    evidence: { type: String, required: true },
    explanation: { type: String, required: true },
    status: { type: String, enum: ['active', 'reviewed', 'dismissed'], default: 'active' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewReason: { type: String, default: null },
  },
  { _id: true },
);

const riskAssessmentSchema = new mongoose.Schema(
  {
    score: { type: Number, min: 0, max: 100, default: 0 },
    level: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'low',
    },
    version: { type: String, default: '1.0.0' },
    calculatedAt: { type: Date, default: null },
    findings: { type: [riskFindingSchema], default: [] },
    summary: { type: String, default: null },
    recommendedAction: { type: String, default: null },
  },
  { _id: false },
);

const qrCodeMetadataSchema = new mongoose.Schema(
  {
    detected: { type: Boolean, default: false },
    decodedText: { type: String, default: null },
    extractedReference: { type: String, default: null },
    candidateUrl: { type: String, default: null },
    isUntrustedDestination: { type: Boolean, default: false },
    pageNumber: { type: Number, default: 1 },
    location: { type: String, default: null },
    inspectedAt: { type: Date, default: null },
  },
  { _id: false },
);

const verificationChecklistItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const bankVerificationHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'verified_with_bank', 'unverifiable', 'verification_failed'],
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedAt: { type: Date, required: true, default: Date.now },
    evidenceSource: { type: String, required: true },
    notes: { type: String, default: null },
  },
  { _id: true },
);

const bankVerificationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'verified_with_bank', 'unverifiable', 'verification_failed'],
      default: 'pending',
    },
    verificationReference: { type: String, default: null },
    qrCode: { type: qrCodeMetadataSchema, default: () => ({}) },
    manualVerification: {
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      verifiedAt: { type: Date, default: null },
      evidenceSource: { type: String, default: null },
      contactMethod: {
        type: String,
        enum: ['email', 'official_portal', 'branch_visit', 'phone', 'other', null],
        default: null,
      },
      branchContact: { type: String, default: null },
      notes: { type: String, default: null },
      externalReference: { type: String, default: null },
    },
    checklist: { type: [verificationChecklistItemSchema], default: [] },
    history: { type: [bankVerificationHistorySchema], default: [] },
  },
  { _id: false },
);

const duplicateMatchSchema = new mongoose.Schema(
  {
    matchedFdr: { type: mongoose.Schema.Types.ObjectId, ref: 'FDR', required: true },
    institution: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
    institutionName: { type: String, default: null },
    fdrNumber: { type: String, required: true },
    bankName: { type: String, required: true },
    matchType: {
      type: String,
      enum: [
        'exact_document_match',
        'same_instrument_reference',
        'probable_metadata_duplicate',
        'possible_reuse',
      ],
      required: true,
    },
    similarityScore: { type: Number, default: 0 },
    reasons: { type: [String], default: [] },
    isAuthorizedReplacement: { type: Boolean, default: false },
  },
  { _id: false },
);

const duplicateResolutionSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['unreviewed', 'confirmed_duplicate', 'legitimate_renewal_replacement', 'inconclusive'],
      default: 'unreviewed',
    },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { _id: false },
);

const duplicateResolutionHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['unreviewed', 'confirmed_duplicate', 'legitimate_renewal_replacement', 'inconclusive'],
      required: true,
    },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedAt: { type: Date, required: true, default: Date.now },
    notes: { type: String, default: null },
  },
  { _id: true },
);

const duplicateCheckSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        'no_candidate_found',
        'exact_document_match',
        'same_instrument_reference',
        'probable_metadata_duplicate',
        'possible_reuse',
      ],
      default: 'no_candidate_found',
    },
    checkedAt: { type: Date, default: null },
    candidateCount: { type: Number, default: 0 },
    matches: { type: [duplicateMatchSchema], default: [] },
    resolution: { type: duplicateResolutionSchema, default: () => ({ status: 'unreviewed' }) },
    resolutionHistory: { type: [duplicateResolutionHistorySchema], default: [] },
  },
  { _id: false },
);

const maturityEscalationHistorySchema = new mongoose.Schema(
  {
    stage: { type: String, required: true },
    escalatedAt: { type: Date, required: true, default: Date.now },
    recipientsCount: { type: Number, default: 0 },
    channels: { type: [String], default: [] },
    summary: { type: String, default: null },
  },
  { _id: true },
);

const maturityEscalationSchema = new mongoose.Schema(
  {
    currentStage: {
      type: String,
      enum: ['not_due', '90d', '30d', '7d', 'overdue', 'completed'],
      default: 'not_due',
    },
    lastEscalatedAt: { type: Date, default: null },
    escalationHistory: { type: [maturityEscalationHistorySchema], default: [] },
  },
  { _id: false },
);

const integrityCheckHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['verified', 'mismatch', 'unavailable', 'not_checked'],
      required: true,
    },
    version: { type: Number, required: true },
    recordedChecksum: { type: String, default: null },
    calculatedChecksum: { type: String, default: null },
    match: { type: Boolean, default: null },
    checkedAt: { type: Date, required: true, default: Date.now },
    checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    trigger: { type: String, enum: ['manual', 'scheduled', 'automated', 'upload'], default: 'manual' },
    message: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { _id: true },
);

const integrityAlertSchema = new mongoose.Schema(
  {
    alertId: { type: String, required: true },
    documentVersion: { type: Number, required: true },
    expectedChecksum: { type: String, required: true },
    observedChecksum: { type: String, default: null },
    detectedAt: { type: Date, required: true, default: Date.now },
    status: {
      type: String,
      enum: ['active', 'investigating', 'acknowledged', 'resolved', 'dismissed'],
      default: 'active',
    },
    severity: { type: String, enum: ['high', 'critical', 'warning'], default: 'high' },
    notes: { type: String, default: null },
    investigationOutcome: { type: String, default: null },
    investigatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    investigatedAt: { type: Date, default: null },
  },
  { _id: true },
);

const integrityStatusSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['verified', 'mismatch', 'not_checked', 'unavailable'],
      default: 'not_checked',
    },
    lastCheckedAt: { type: Date, default: null },
    lastCheckedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    version: { type: Number, default: 1 },
    recordedChecksum: { type: String, default: null },
    calculatedChecksum: { type: String, default: null },
    message: { type: String, default: null },
    reason: { type: String, default: null },
    history: { type: [integrityCheckHistorySchema], default: [] },
    alerts: { type: [integrityAlertSchema], default: [] },
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
    interestRate: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    depositorName: {
      type: String,
      default: null,
      trim: true,
    },
    ifscCode: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },
    documentMetadata: {
      type: documentMetadataSchema,
      default: {},
    },
    documentVersions: {
      type: [
        new mongoose.Schema(
          {
            version: { type: Number, required: true },
            storageRef: { type: String, default: null },
            fileName: { type: String, default: null },
            mimeType: { type: String, default: null },
            fileSize: { type: Number, default: null },
            checksum: { type: String, default: null },
            uploadedAt: { type: Date, default: Date.now },
            uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
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
    trustScore: {
      type: trustScoreSchema,
      default: () => ({}),
    },
    trustScoreHistory: {
      type: [trustScoreHistorySchema],
      default: [],
    },
    riskAssessment: {
      type: riskAssessmentSchema,
      default: () => ({ score: 0, level: 'low' }),
    },
    bankVerification: {
      type: bankVerificationSchema,
      default: () => ({ status: 'pending' }),
    },
    duplicateCheck: {
      type: duplicateCheckSchema,
      default: () => ({ status: 'no_candidate_found' }),
    },
    maturityEscalation: {
      type: maturityEscalationSchema,
      default: () => ({ currentStage: 'not_due' }),
    },
    integrityStatus: {
      type: integrityStatusSchema,
      default: () => ({ status: 'not_checked' }),
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
fdrSchema.index({ 'bankVerification.status': 1 });
fdrSchema.index({ 'duplicateCheck.status': 1 });
fdrSchema.index({ 'documentMetadata.checksum': 1 });
fdrSchema.index({ 'trustScore.category': 1 });
fdrSchema.index({ 'integrityStatus.status': 1 });

fdrSchema.path('maturityDate').validate(function validateMaturityDate(value) {
  if (!this.issueDate || !value) {
    return true;
  }

  return new Date(value) > new Date(this.issueDate);
}, 'Maturity date must be later than issue date.');

const FDR = mongoose.model('FDR', fdrSchema);

export default FDR;
