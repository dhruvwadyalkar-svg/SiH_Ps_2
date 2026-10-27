import 'dotenv/config';
import mongoose from 'mongoose';
import Institution from '../models/Institution.js';
import User from '../models/User.js';
import FDR from '../models/FDR.js';
import AuditLog from '../models/AuditLog.js';
import ForensicAnalysis from '../models/ForensicAnalysis.js';
import ReleaseRequest from '../models/ReleaseRequest.js';
import Notification from '../models/Notification.js';

const validateSchemas = async () => {
  const institution = new Institution({
    name: 'Sample Institution',
    institutionCode: 'ABC123',
    contactEmail: 'admin@example.com',
    contactPhone: '+91-9876543210',
    address: '123 Example Road, Pune',
    status: 'active',
  });

  await institution.validate();

  const user = new User({
    fullName: 'Sample User',
    email: 'user@example.com',
    passwordHash: 'placeholder-hash',
    role: 'institution_admin',
    institution: new mongoose.Types.ObjectId(),
    isActive: true,
  });

  await user.validate();

  const fdr = new FDR({
    institution: new mongoose.Types.ObjectId(),
    fdrNumber: 'FDR-1001',
    bankName: 'City Bank',
    branch: 'MG Road',
    amount: 250000,
    currency: 'INR',
    issueDate: new Date('2024-01-01T00:00:00.000Z'),
    maturityDate: new Date('2025-01-01T00:00:00.000Z'),
    workflowStatus: 'submitted',
    financialStatus: 'active',
  });

  await fdr.validate();

  const invalidFdr = new FDR({
    institution: new mongoose.Types.ObjectId(),
    fdrNumber: 'FDR-1002',
    bankName: 'City Bank',
    branch: 'MG Road',
    amount: 250000,
    currency: 'INR',
    issueDate: new Date('2025-01-01T00:00:00.000Z'),
    maturityDate: new Date('2024-01-01T00:00:00.000Z'),
  });

  try {
    await invalidFdr.validate();
    throw new Error('FDR validation did not reject a maturity date earlier than the issue date.');
  } catch (error) {
    if (!error.errors?.maturityDate) {
      throw error;
    }
  }

  const auditLog = new AuditLog({
    action: 'record_created',
    entityType: 'FDR',
    entityId: new mongoose.Types.ObjectId(),
    metadata: { source: 'db_check' },
  });

  await auditLog.validate();

  const forensicAnalysis = new ForensicAnalysis({
    fdrId: new mongoose.Types.ObjectId(),
    checksum: 'a'.repeat(64),
    engine: 'local-document-forensics',
    analysisVersion: '1.0.0',
    status: 'no_signals_detected',
    findings: [{
      code: 'pdf_signature_validation_unsupported',
      severity: 'inconclusive',
      explanation: 'Synthetic validation finding.',
      conclusive: false,
      heuristic: true,
    }],
    limitations: ['Synthetic validation limitation.'],
    analyzedAt: new Date(),
  });

  await forensicAnalysis.validate();

  const releaseRequest = new ReleaseRequest({
    fdrId: new mongoose.Types.ObjectId(),
    institution: new mongoose.Types.ObjectId(),
    requestedBy: new mongoose.Types.ObjectId(),
    reason: 'Synthetic release request validation.',
    status: 'submitted',
    history: [{
      actor: new mongoose.Types.ObjectId(),
      actorRole: 'institution_admin',
      decision: 'submit_request',
      reason: 'Synthetic release request validation.',
      previousStatus: 'new',
      nextStatus: 'submitted',
      timestamp: new Date(),
    }],
  });

  await releaseRequest.validate();

  const notification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    institution: new mongoose.Types.ObjectId(),
    fdr: new mongoose.Types.ObjectId(),
    type: 'maturity_reminder',
    title: 'Synthetic maturity reminder',
    message: 'A synthetic FDR is approaching maturity.',
    metadata: { fdrNumber: 'SYNTHETIC-FDR', reminderStage: '30d' },
    deduplicationKey: 'synthetic-phase-nine-reminder',
  });

  await notification.validate();

  console.log('Schema validation smoke test passed for Institution, User, FDR, AuditLog, ForensicAnalysis, ReleaseRequest, and Notification models.');
};

const runCheck = async () => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not defined. Add it to your environment and retry.');
  }

  await validateSchemas();

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
  });

  await mongoose.connection.db.admin().ping();

  console.log('MongoDB connection check passed.');
  console.log(`Connected to database "${mongoose.connection.name}" on host "${mongoose.connection.host}".`);
};

try {
  await runCheck();
} catch (error) {
  console.error('Database check failed:', error.name);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
