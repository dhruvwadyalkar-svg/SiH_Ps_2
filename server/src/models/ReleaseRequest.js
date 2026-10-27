import mongoose from 'mongoose';

const releaseDecisionSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: {
      type: String,
      enum: ['institution_admin', 'institution_user', 'aicte_admin', 'reviewer'],
      required: true,
    },
    decision: {
      type: String,
      enum: [
        'submit_request',
        'resubmit_request',
        'request_information',
        'approve_request',
        'reject_request',
      ],
      required: true,
    },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    previousStatus: { type: String, required: true },
    nextStatus: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: true },
);

const releaseRequestSchema = new mongoose.Schema(
  {
    fdrId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FDR',
      required: true,
    },
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institution',
      required: true,
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    status: {
      type: String,
      enum: ['submitted', 'information_requested', 'approved', 'rejected'],
      required: true,
      default: 'submitted',
    },
    active: { type: Boolean, default: true, required: true },
    history: { type: [releaseDecisionSchema], default: [] },
  },
  { timestamps: true },
);

releaseRequestSchema.index({ status: 1, createdAt: -1, _id: -1 });
releaseRequestSchema.index({ fdrId: 1, createdAt: -1 });
releaseRequestSchema.index(
  { fdrId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

const ReleaseRequest = mongoose.model('ReleaseRequest', releaseRequestSchema);

export default ReleaseRequest;
