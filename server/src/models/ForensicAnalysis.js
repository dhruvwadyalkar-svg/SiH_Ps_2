import mongoose from 'mongoose';

const findingSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    severity: {
      type: String,
      enum: ['info', 'low', 'medium', 'high', 'inconclusive'],
      required: true,
    },
    explanation: { type: String, required: true, trim: true, maxlength: 500 },
    conclusive: { type: Boolean, required: true },
    heuristic: { type: Boolean, required: true },
  },
  { _id: false },
);

const forensicAnalysisSchema = new mongoose.Schema(
  {
    fdrId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FDR',
      required: true,
    },
    checksum: {
      type: String,
      default: null,
      match: /^[a-f0-9]{64}$/i,
    },
    engine: { type: String, required: true, trim: true },
    analysisVersion: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: [
        'no_signals_detected',
        'review_recommended',
        'analysis_inconclusive',
        'integrity_check_failed',
        'analysis_failed',
      ],
      required: true,
    },
    findings: { type: [findingSchema], default: [] },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    limitations: { type: [String], default: [] },
    analyzedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

forensicAnalysisSchema.index({ fdrId: 1, analyzedAt: -1, _id: -1 });

const ForensicAnalysis = mongoose.model('ForensicAnalysis', forensicAnalysisSchema);

export default ForensicAnalysis;
