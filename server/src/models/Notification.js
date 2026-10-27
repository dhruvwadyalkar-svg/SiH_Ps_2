import mongoose from 'mongoose';

const notificationTypes = [
  'maturity_reminder',
  'overdue_maturity',
];

const notificationMetadataSchema = new mongoose.Schema(
  {
    fdrNumber: { type: String, trim: true, maxlength: 100 },
    maturityDate: { type: String, trim: true, maxlength: 10 },
    reminderStage: { type: String, trim: true, maxlength: 10 },
  },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    institution: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Institution',
      default: null,
    },
    fdr: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FDR',
      default: null,
    },
    type: {
      type: String,
      enum: notificationTypes,
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    metadata: { type: notificationMetadataSchema, default: {} },
    deduplicationKey: {
      type: String,
      trim: true,
      maxlength: 250,
      default: null,
    },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ recipient: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { deduplicationKey: 1 },
  { unique: true, partialFilterExpression: { deduplicationKey: { $type: 'string' } } },
);

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
