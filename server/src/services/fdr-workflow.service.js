import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import ForensicAnalysis from '../models/ForensicAnalysis.js';
import Institution from '../models/Institution.js';
import ReleaseRequest from '../models/ReleaseRequest.js';
import User from '../models/User.js';
import { deleteStoredDocument, storeUploadedDocument } from './document-storage.service.js';
import { getFdrById, serializeFdr } from './fdr.service.js';
import { calculateFdrTrustScore } from './fdr-trust-score.service.js';
import { calculateFdrRiskScore, mapRiskScoreToLevel } from './fdr-risk-score.service.js';
import {
  generateBankVerificationEmailDraft,
  scanDocumentForQrCode,
  STANDARD_VERIFICATION_CHECKLIST,
} from './bank-verification.service.js';
import {
  detectFdrDuplicates,
  sanitizeDuplicateCheckForUser,
} from './duplicate-detection.service.js';

const officialRoles = new Set(['aicte_admin', 'reviewer']);
const institutionRoles = new Set(['institution_admin', 'institution_user']);

export class FdrWorkflowError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const requireOfficial = (user) => {
  if (!officialRoles.has(user?.role)) {
    throw new FdrWorkflowError(403, 'forbidden', 'Only authorized AICTE officials may perform this action.');
  }
};

const getInstitutionId = (user) => {
  const institutionId = user?.institution?._id || user?.institution;
  return institutionId ? String(institutionId) : null;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withSession = async (operation) => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => operation(session));
  } finally {
    await session.endSession();
  }
};

const writeAudit = ({
  actor,
  actorRole,
  action,
  entityType = 'FDR',
  entityId,
  outcome = 'success',
  reason = null,
  documentVersion = 1,
  documentChecksum = null,
  diff = [],
  metadata = {},
}) =>
  new AuditLog({
    actor,
    actorRole,
    action,
    entityType,
    entityId,
    outcome,
    reason,
    documentVersion,
    documentChecksum,
    diff,
    metadata,
  });

const safeFdrSummary = (record) => ({
  id: String(record._id),
  fdrNumber: record.fdrNumber,
  bankName: record.bankName,
  branch: record.branch,
  amount: record.amount,
  currency: record.currency,
  issueDate: record.issueDate,
  maturityDate: record.maturityDate,
  interestRate: record.interestRate ?? null,
  depositorName: record.depositorName || null,
  ifscCode: record.ifscCode || null,
  workflowStatus: record.workflowStatus,
  financialStatus: record.financialStatus,
  createdAt: record.createdAt,
  submittedAt: record.submittedAt || record.createdAt,
});

export const listFdrReviewQueue = async ({ user, query }) => {
  requireOfficial(user);
  const filter = {};
  if (query.workflowStatus) filter.workflowStatus = query.workflowStatus;
  if (query.riskLevel) filter['riskAssessment.level'] = query.riskLevel.toLowerCase();
  if (query.bank) filter.bankName = new RegExp(escapeRegex(query.bank), 'i');
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const institutions = await Institution.find({
      $or: [{ name: pattern }, { institutionCode: pattern }],
    }).select('_id');
    filter.$or = [
      { fdrNumber: pattern },
      { institution: { $in: institutions.map(({ _id }) => _id) } },
    ];
  }

  let sortOptions = { createdAt: -1, _id: -1 };
  if (query.sortBy === 'risk_desc') {
    sortOptions = { 'riskAssessment.score': -1, createdAt: -1 };
  } else if (query.sortBy === 'risk_asc') {
    sortOptions = { 'riskAssessment.score': 1, createdAt: -1 };
  } else if (query.sortBy === 'urgency') {
    sortOptions = { 'riskAssessment.score': -1, maturityDate: 1 };
  } else if (query.sortBy === 'date_asc') {
    sortOptions = { createdAt: 1, _id: 1 };
  } else if (query.sortBy === 'date_desc') {
    sortOptions = { createdAt: -1, _id: -1 };
  }

  const [total, records] = await Promise.all([
    FDR.countDocuments(filter),
    FDR.find(filter)
      .select('institution fdrNumber bankName branch amount currency issueDate maturityDate workflowStatus submittedAt createdAt trustScore bankVerification duplicateCheck riskAssessment')
      .populate('institution', 'name institutionCode')
      .sort(sortOptions)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);
  return {
    records: records.map((record) => ({
      ...safeFdrSummary(record),
      institution: record.institution
        ? {
            id: String(record.institution._id || record.institution),
            name: record.institution.name || null,
            institutionCode: record.institution.institutionCode || null,
          }
        : null,
      trustScore: record.trustScore ? {
        score: record.trustScore.score,
        category: record.trustScore.category,
        evidenceCoverage: record.trustScore.evidenceCoverage,
      } : null,
      riskAssessment: record.riskAssessment ? {
        score: record.riskAssessment.score ?? 0,
        level: record.riskAssessment.level || 'low',
        summary: record.riskAssessment.summary || null,
        totalFindingsCount: record.riskAssessment.findings?.length ?? 0,
        activeFindingsCount: record.riskAssessment.findings?.filter((f) => f.status === 'active')?.length ?? 0,
      } : null,
      bankVerificationStatus: record.bankVerification?.status || 'pending',
      duplicateStatus: record.duplicateCheck?.status || 'no_candidate_found',
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit) || 1,
    },
  };
};

const safeForensicSummary = (report) => report && ({
  analysisId: String(report._id),
  checksum: report.checksum || null,
  engine: report.engine,
  analysisVersion: report.analysisVersion,
  status: report.status,
  findings: report.findings,
  analyzedAt: report.analyzedAt,
});

export const getFdrReviewDetails = async ({ user, fdrId }) => {
  requireOfficial(user);
  const fdr = await getFdrById({ user, fdrId });
  const [institution, forensic, replacements, original, releaseRequests, reviewActors] = await Promise.all([
    Institution.findById(fdr.institution).select('name institutionCode contactEmail contactPhone address status'),
    ForensicAnalysis.findOne({ fdrId: fdr._id }).sort({ analyzedAt: -1, _id: -1 }),
    FDR.find({ replacesFdr: fdr._id })
      .select('fdrNumber workflowStatus issueDate maturityDate createdAt')
      .sort({ createdAt: -1, _id: -1 }),
    fdr.replacesFdr
      ? FDR.findById(fdr.replacesFdr).select('fdrNumber workflowStatus issueDate maturityDate amount currency bankName branch interestRate depositorName ifscCode documentMetadata')
      : Promise.resolve(null),
    ReleaseRequest.find({ fdrId: fdr._id })
      .select('status reason createdAt updatedAt history')
      .sort({ createdAt: -1, _id: -1 }),
    fdr.reviewHistory?.length
      ? User.find({ _id: { $in: fdr.reviewHistory.map(({ actor }) => actor) } }).select('fullName role')
      : Promise.resolve([]),
  ]);
  const actorsById = new Map(reviewActors.map((actor) => [String(actor._id), actor]));

  // Ensure standard checklist items exist
  const existingChecklist = fdr.bankVerification?.checklist || [];
  const checklistMap = new Map(existingChecklist.map((item) => [item.id, item]));
  const completeChecklist = STANDARD_VERIFICATION_CHECKLIST.map((item) => {
    const existing = checklistMap.get(item.id);
    return {
      id: item.id,
      label: item.label,
      completed: existing ? existing.completed : false,
      completedAt: existing?.completedAt || null,
      completedBy: existing?.completedBy || null,
    };
  });

  return {
    institution: institution && {
      id: String(institution._id),
      name: institution.name,
      institutionCode: institution.institutionCode,
      status: institution.status,
    },
    fdr: {
      ...safeFdrSummary(fdr),
      institutionSubmitted: {
        fdrNumber: fdr.fdrNumber,
        bankName: fdr.bankName,
        branch: fdr.branch,
        amount: fdr.amount,
        currency: fdr.currency,
        issueDate: fdr.issueDate,
        maturityDate: fdr.maturityDate,
        interestRate: fdr.interestRate ?? null,
        depositorName: fdr.depositorName || null,
        ifscCode: fdr.ifscCode || null,
      },
      document: {
        fileName: fdr.documentMetadata?.fileName || null,
        mimeType: fdr.documentMetadata?.mimeType || null,
        fileSize: fdr.documentMetadata?.fileSize ?? null,
        checksum: fdr.documentMetadata?.checksum || null,
        uploadedAt: fdr.documentMetadata?.uploadedAt || null,
        downloadEndpoint: `/api/fdrs/${fdr._id}/document`,
      },
      ocr: {
        status: fdr.ocrResult?.status || 'not_started',
        requestedLanguage: fdr.ocrResult?.requestedLanguage || 'en-IN',
        languageName: fdr.ocrResult?.languageName || 'English (India)',
        extractedFields: ['completed', 'partially_completed'].includes(fdr.ocrResult?.status)
          ? fdr.ocrResult.extractedData
          : null,
        comparisons: ['completed', 'partially_completed'].includes(fdr.ocrResult?.status)
          ? fdr.ocrResult.comparisonResults
          : null,
        missingFields: fdr.ocrResult?.missingFields || [],
        lowConfidenceFields: fdr.ocrResult?.lowConfidenceFields || [],
      },
      forensic: safeForensicSummary(forensic),
      trustScore: fdr.trustScore ? {
        score: fdr.trustScore.score,
        category: fdr.trustScore.category,
        evidenceCoverage: fdr.trustScore.evidenceCoverage,
        version: fdr.trustScore.version,
        calculatedAt: fdr.trustScore.calculatedAt,
        summary: fdr.trustScore.summary,
        signals: fdr.trustScore.signals || [],
        positiveFindings: fdr.trustScore.positiveFindings || [],
        riskFindings: fdr.trustScore.riskFindings || [],
        missingData: fdr.trustScore.missingData || [],
        unavailableChecks: fdr.trustScore.unavailableChecks || [],
        history: fdr.trustScoreHistory || [],
      } : null,
      riskAssessment: fdr.riskAssessment ? {
        score: fdr.riskAssessment.score ?? 0,
        level: fdr.riskAssessment.level || 'low',
        version: fdr.riskAssessment.version || '1.0.0',
        calculatedAt: fdr.riskAssessment.calculatedAt || null,
        summary: fdr.riskAssessment.summary || null,
        recommendedAction: fdr.riskAssessment.recommendedAction || null,
        totalFindingsCount: fdr.riskAssessment.findings?.length ?? 0,
        activeFindingsCount: fdr.riskAssessment.findings?.filter((f) => f.status === 'active')?.length ?? 0,
        findings: (fdr.riskAssessment.findings || []).map((f) => ({
          id: String(f._id || f.id),
          ruleId: f.id || null,
          label: f.label,
          points: f.points,
          category: f.category,
          evidence: f.evidence,
          explanation: f.explanation,
          status: f.status || 'active',
          reviewedBy: f.reviewedBy ? String(f.reviewedBy) : null,
          reviewedAt: f.reviewedAt || null,
          reviewReason: f.reviewReason || null,
        })),
      } : null,
      bankVerification: {
        status: fdr.bankVerification?.status || 'pending',
        verificationReference: fdr.bankVerification?.verificationReference || null,
        qrCode: fdr.bankVerification?.qrCode || null,
        manualVerification: fdr.bankVerification?.manualVerification || null,
        checklist: completeChecklist,
        history: fdr.bankVerification?.history || [],
        emailDraft: generateBankVerificationEmailDraft({ fdr, institution, reviewer: user }),
      },
      duplicateCheck: fdr.duplicateCheck ? {
        status: fdr.duplicateCheck.status || 'no_candidate_found',
        checkedAt: fdr.duplicateCheck.checkedAt || null,
        candidateCount: fdr.duplicateCheck.candidateCount || 0,
        matches: fdr.duplicateCheck.matches || [],
        resolution: fdr.duplicateCheck.resolution || { status: 'unreviewed' },
        resolutionHistory: fdr.duplicateCheck.resolutionHistory || [],
      } : null,
      maturityEscalation: fdr.maturityEscalation ? {
        currentStage: fdr.maturityEscalation.currentStage || 'not_due',
        lastEscalatedAt: fdr.maturityEscalation.lastEscalatedAt || null,
        escalationHistory: fdr.maturityEscalation.escalationHistory || [],
      } : null,
      reviewerConfirmedDetails: fdr.reviewerConfirmedDetails || {},
      reviewHistory: (fdr.reviewHistory || []).map((entry) => {
        const actor = actorsById.get(String(entry.actor));
        return {
          id: String(entry._id),
          actor: actor ? { id: String(actor._id), fullName: actor.fullName, role: actor.role } : null,
          decision: entry.decision,
          reason: entry.reason,
          previousStatus: entry.previousStatus,
          nextStatus: entry.nextStatus,
          timestamp: entry.timestamp,
        };
      }),
      replacements: replacements.map((record) => ({
        id: String(record._id),
        fdrNumber: record.fdrNumber,
        workflowStatus: record.workflowStatus,
        issueDate: record.issueDate,
        maturityDate: record.maturityDate,
        createdAt: record.createdAt,
      })),
      replacementOf: original && {
        id: String(original._id),
        fdrNumber: original.fdrNumber,
        bankName: original.bankName,
        branch: original.branch,
        amount: original.amount,
        currency: original.currency,
        issueDate: original.issueDate,
        maturityDate: original.maturityDate,
        interestRate: original.interestRate ?? null,
        depositorName: original.depositorName || null,
        ifscCode: original.ifscCode || null,
        workflowStatus: original.workflowStatus,
        document: {
          fileName: original.documentMetadata?.fileName || null,
          mimeType: original.documentMetadata?.mimeType || null,
          fileSize: original.documentMetadata?.fileSize ?? null,
          downloadEndpoint: `/api/fdrs/${original._id}/document`,
        },
      },
      releaseRequests: releaseRequests.map((request) => ({
        id: String(request._id),
        status: request.status,
        reason: request.reason,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      })),
    },
  };
};

const reviewTransitions = {
  request_correction: { from: ['submitted', 'under_review'], to: 'correction_requested' },
  reject_submission: { from: ['submitted', 'under_review'], to: 'rejected' },
  complete_review: { from: ['submitted', 'under_review'], to: 'review_completed' },
};

export const decideFdrReview = async ({ user, fdrId, decision, reason }) => {
  requireOfficial(user);
  const transition = reviewTransitions[decision];
  if (!transition) throw new FdrWorkflowError(400, 'invalid_decision', 'The review decision is not supported.');
  let updatedFdr;
  const timestamp = new Date();
  await withSession(async (session) => {
    const fdr = await FDR.findById(fdrId).session(session);
    if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');
    const previousStatus = fdr.workflowStatus;
    if (!transition.from.includes(previousStatus)) {
      throw new FdrWorkflowError(409, 'invalid_transition', `A review decision cannot be applied while the FDR is "${previousStatus}".`);
    }

    fdr.workflowStatus = transition.to;
    fdr.reviewer = user._id;
    fdr.reviewHistory.push({
      actor: user._id,
      actorRole: user.role,
      decision,
      reason,
      previousStatus,
      nextStatus: transition.to,
      timestamp,
    });
    await fdr.save({ session });
    await writeAudit({
      actor: user._id,
      actorRole: user.role,
      action: 'fdr_review_decided',
      entityId: fdr._id,
      outcome: 'success',
      reason,
      diff: [
        {
          field: 'workflowStatus',
          previousValue: previousStatus,
          newValue: transition.to,
        },
      ],
      documentVersion: fdr.documentMetadata?.version || 1,
      documentChecksum: fdr.documentMetadata?.checksum || null,
      metadata: { decision, reason, previousStatus, nextStatus: transition.to, timestamp },
    }).save({ session });
    updatedFdr = fdr;
  });
  return {
    fdr: safeFdrSummary(updatedFdr),
    decision: updatedFdr.reviewHistory.at(-1),
  };
};

export const recordBankVerificationOutcome = async ({ user, fdrId, payload }) => {
  requireOfficial(user);
  const validStatuses = ['pending', 'verified_with_bank', 'unverifiable', 'verification_failed'];
  if (!validStatuses.includes(payload.status)) {
    throw new FdrWorkflowError(400, 'invalid_status', 'Invalid bank verification status.');
  }
  if (payload.status !== 'pending' && (!payload.evidenceSource || payload.evidenceSource.trim().length < 3)) {
    throw new FdrWorkflowError(400, 'missing_evidence', 'A verifiable evidence source description is required.');
  }

  const timestamp = new Date();
  await withSession(async (session) => {
    const fdr = await FDR.findById(fdrId).session(session);
    if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');

    fdr.bankVerification.status = payload.status;
    if (payload.verificationReference !== undefined) {
      fdr.bankVerification.verificationReference = payload.verificationReference;
    }
    fdr.bankVerification.manualVerification = {
      verifiedBy: user._id,
      verifiedAt: timestamp,
      evidenceSource: payload.evidenceSource || 'Reviewer manual verification',
      contactMethod: payload.contactMethod || 'email',
      branchContact: payload.branchContact || null,
      notes: payload.notes || null,
      externalReference: payload.externalReference || null,
    };

    if (Array.isArray(payload.checklist)) {
      fdr.bankVerification.checklist = payload.checklist.map((item) => ({
        id: item.id,
        label: item.label,
        completed: Boolean(item.completed),
        completedAt: item.completed ? timestamp : null,
        completedBy: item.completed ? user._id : null,
      }));
    }

    fdr.bankVerification.history.push({
      status: payload.status,
      updatedBy: user._id,
      updatedAt: timestamp,
      evidenceSource: payload.evidenceSource || 'Status updated',
      notes: payload.notes || null,
    });

    const latestForensic = fdr.latestForensicAnalysis
      ? await ForensicAnalysis.findById(fdr.latestForensicAnalysis).session(session)
      : null;

    const trustScoreResult = calculateFdrTrustScore({
      fdr,
      forensicAnalysis: latestForensic,
      duplicateResult: fdr.duplicateCheck,
      bankVerification: fdr.bankVerification,
      trigger: 'bank_verification_update',
    });
    fdr.trustScore = trustScoreResult;
    fdr.trustScoreHistory.push({
      score: trustScoreResult.score,
      category: trustScoreResult.category,
      evidenceCoverage: trustScoreResult.evidenceCoverage,
      version: trustScoreResult.version,
      calculatedAt: trustScoreResult.calculatedAt,
      summary: trustScoreResult.summary,
      trigger: 'bank_verification_update',
    });

    await fdr.save({ session });

    await writeAudit({
      actor: user._id,
      action: 'fdr_bank_verification_updated',
      entityId: fdr._id,
      metadata: {
        status: payload.status,
        evidenceSource: payload.evidenceSource,
        timestamp,
      },
    }).save({ session });
  });

  return getFdrReviewDetails({ user, fdrId });
};

export const recordDuplicateReviewOutcome = async ({ user, fdrId, payload }) => {
  requireOfficial(user);
  const validStatuses = ['confirmed_duplicate', 'legitimate_renewal_replacement', 'inconclusive'];
  if (!validStatuses.includes(payload.status)) {
    throw new FdrWorkflowError(400, 'invalid_status', 'Invalid duplicate resolution status.');
  }
  if (!payload.notes || payload.notes.trim().length < 5) {
    throw new FdrWorkflowError(400, 'missing_notes', 'A review explanation of at least 5 characters is required.');
  }

  const timestamp = new Date();
  await withSession(async (session) => {
    const fdr = await FDR.findById(fdrId).session(session);
    if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');

    fdr.duplicateCheck.resolution = {
      status: payload.status,
      reviewer: user._id,
      reviewedAt: timestamp,
      notes: payload.notes,
    };

    fdr.duplicateCheck.resolutionHistory.push({
      status: payload.status,
      reviewer: user._id,
      reviewedAt: timestamp,
      notes: payload.notes,
    });

    const latestForensic = fdr.latestForensicAnalysis
      ? await ForensicAnalysis.findById(fdr.latestForensicAnalysis).session(session)
      : null;

    const trustScoreResult = calculateFdrTrustScore({
      fdr,
      forensicAnalysis: latestForensic,
      duplicateResult: fdr.duplicateCheck,
      bankVerification: fdr.bankVerification,
      trigger: 'duplicate_review_update',
    });
    fdr.trustScore = trustScoreResult;
    fdr.trustScoreHistory.push({
      score: trustScoreResult.score,
      category: trustScoreResult.category,
      evidenceCoverage: trustScoreResult.evidenceCoverage,
      version: trustScoreResult.version,
      calculatedAt: trustScoreResult.calculatedAt,
      summary: trustScoreResult.summary,
      trigger: 'duplicate_review_update',
    });

    await fdr.save({ session });

    await writeAudit({
      actor: user._id,
      action: 'fdr_duplicate_reviewed',
      entityId: fdr._id,
      metadata: {
        resolution: payload.status,
        notes: payload.notes,
        timestamp,
      },
    }).save({ session });
  });

  return getFdrReviewDetails({ user, fdrId });
};

export const recalculateFdrTrustScoreAction = async ({ user, fdrId }) => {
  requireOfficial(user);
  const fdr = await FDR.findById(fdrId);
  if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');

  const latestForensic = fdr.latestForensicAnalysis
    ? await ForensicAnalysis.findById(fdr.latestForensicAnalysis)
    : await ForensicAnalysis.findOne({ fdrId }).sort({ analyzedAt: -1 });

  let duplicateResult = fdr.duplicateCheck;
  try {
    duplicateResult = await detectFdrDuplicates({ fdrId, fdrRecord: fdr });
    fdr.duplicateCheck = duplicateResult;
  } catch {
    // safe fallback
  }

  const trustScoreResult = calculateFdrTrustScore({
    fdr,
    forensicAnalysis: latestForensic,
    duplicateResult,
    bankVerification: fdr.bankVerification,
    trigger: 'manual_recalculate',
  });

  fdr.trustScore = trustScoreResult;
  fdr.trustScoreHistory.push({
    score: trustScoreResult.score,
    category: trustScoreResult.category,
    evidenceCoverage: trustScoreResult.evidenceCoverage,
    version: trustScoreResult.version,
    calculatedAt: trustScoreResult.calculatedAt,
    summary: trustScoreResult.summary,
    trigger: 'manual_recalculate',
  });

  await fdr.save();
  return getFdrReviewDetails({ user, fdrId });
};

export const reviewRiskFindingAction = async ({ user, fdrId, findingId, status, reviewReason }) => {
  requireOfficial(user);
  const fdr = await FDR.findById(fdrId);
  if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');

  if (!fdr.riskAssessment) {
    throw new FdrWorkflowError(404, 'no_risk_assessment', 'This FDR has no risk assessment.');
  }

  const validStatuses = ['dismissed', 'reviewed', 'active'];
  if (!validStatuses.includes(status)) {
    throw new FdrWorkflowError(400, 'invalid_status', 'Invalid finding review status.');
  }

  if (['dismissed', 'reviewed'].includes(status) && (!reviewReason || reviewReason.trim().length < 5)) {
    throw new FdrWorkflowError(400, 'missing_reason', 'A justification of at least 5 characters is required.');
  }

  const finding = (fdr.riskAssessment.findings || []).find(
    (f) => String(f._id || f.id) === String(findingId) || f.id === findingId
  );
  if (!finding) {
    throw new FdrWorkflowError(404, 'finding_not_found', 'Risk finding not found.');
  }

  finding.status = status;
  finding.reviewedBy = user._id;
  finding.reviewedAt = new Date();
  finding.reviewReason = reviewReason.trim();

  // Recalculate active findings and score dynamically
  const activeFindings = fdr.riskAssessment.findings.filter((f) => f.status === 'active');
  const activeScore = Math.min(
    100,
    activeFindings.reduce((sum, f) => sum + (f.points || 0), 0)
  );
  fdr.riskAssessment.score = activeScore;
  fdr.riskAssessment.level = mapRiskScoreToLevel(activeScore);
  fdr.riskAssessment.calculatedAt = new Date();

  await fdr.save();

  await writeAudit({
    actor: user._id,
    action: 'fdr_risk_finding_reviewed',
    entityId: fdr._id,
    metadata: {
      findingRuleCode: finding.id || findingId,
      status,
      reviewReason: reviewReason.trim(),
      newRiskScore: activeScore,
      newRiskLevel: fdr.riskAssessment.level,
    },
  }).save();

  return getFdrReviewDetails({ user, fdrId });
};

export const recalculateRiskScoreAction = async ({ user, fdrId }) => {
  requireOfficial(user);
  const fdr = await FDR.findById(fdrId);
  if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'FDR not found.');

  let previousFdr = null;
  if (fdr.replacesFdr) {
    previousFdr = await FDR.findById(fdr.replacesFdr);
  }

  let duplicateResult = fdr.duplicateCheck;
  try {
    duplicateResult = await detectFdrDuplicates({ fdrId, fdrRecord: fdr });
    fdr.duplicateCheck = duplicateResult;
  } catch {
    // safe fallback
  }

  const riskResult = calculateFdrRiskScore({
    fdr,
    duplicateResult,
    previousFdr,
  });

  fdr.riskAssessment = riskResult;
  await fdr.save();

  await writeAudit({
    actor: user._id,
    action: 'fdr_risk_recalculated',
    entityId: fdr._id,
    metadata: {
      score: riskResult.score,
      level: riskResult.level,
      findingsCount: riskResult.findings?.length || 0,
    },
  }).save();

  return getFdrReviewDetails({ user, fdrId });
};

const cleanupStoredFile = async (storageKey) => {
  try {
    await deleteStoredDocument(storageKey);
  } catch (error) {
    console.error('Failed to clean up private FDR replacement upload:', error.name || 'Error');
  }
};

export const createFdrRenewal = async ({ user, fdrId, payload, file }) => {
  if (!institutionRoles.has(user?.role)) {
    throw new FdrWorkflowError(403, 'forbidden', 'Only institution users may submit an FDR replacement.');
  }
  const original = await getFdrById({ user, fdrId });
  if (['released', 'expired'].includes(original.workflowStatus) || original.financialStatus === 'cancelled') {
    throw new FdrWorkflowError(409, 'invalid_renewal_state', 'This FDR is not eligible for a replacement submission.');
  }

  let document;
  try {
    document = await storeUploadedDocument(file);
  } catch (error) {
    throw new FdrWorkflowError(400, 'invalid_document', error.message || 'The replacement document is invalid.');
  }

  let qrResult = null;
  try {
    qrResult = await scanDocumentForQrCode(file.buffer, document.mimeType);
  } catch {
    // safe fallback
  }

  let replacement;
  try {
    await withSession(async (session) => {
      const existing = await FDR.findOne({
        replacesFdr: original._id,
        workflowStatus: { $in: ['submitted', 'under_review', 'review_completed', 'approved'] },
      }).session(session);
      if (existing) {
        throw new FdrWorkflowError(409, 'replacement_exists', 'A replacement record already exists for this FDR.');
      }
      const originalVersion = original.documentMetadata?.version || 1;
      const newVersion = originalVersion + 1;

      replacement = new FDR({
        institution: original.institution,
        ...payload,
        workflowStatus: 'submitted',
        submittedAt: document.uploadedAt,
        replacesFdr: original._id,
        documentMetadata: {
          storageRef: document.storageKey,
          fileName: document.fileName,
          mimeType: document.mimeType,
          fileSize: document.fileSize,
          checksum: document.checksum,
          version: newVersion,
          uploadedAt: document.uploadedAt,
        },
        documentVersions: [
          ...(original.documentVersions?.length
            ? original.documentVersions
            : [
                {
                  version: originalVersion,
                  storageRef: original.documentMetadata?.storageRef,
                  fileName: original.documentMetadata?.fileName,
                  mimeType: original.documentMetadata?.mimeType,
                  fileSize: original.documentMetadata?.fileSize,
                  checksum: original.documentMetadata?.checksum,
                  uploadedAt: original.documentMetadata?.uploadedAt,
                },
              ]),
          {
            version: newVersion,
            storageRef: document.storageKey,
            fileName: document.fileName,
            mimeType: document.mimeType,
            fileSize: document.fileSize,
            checksum: document.checksum,
            uploadedAt: document.uploadedAt,
            uploadedBy: user._id,
          },
        ],
        bankVerification: {
          status: 'pending',
          qrCode: {
            detected: Boolean(qrResult?.detected),
            decodedText: qrResult?.decodedText || null,
            extractedReference: qrResult?.extractedReference || null,
            candidateUrl: qrResult?.candidateUrl || null,
            isUntrustedDestination: Boolean(qrResult?.isUntrustedDestination),
            pageNumber: qrResult?.pageNumber || 1,
            location: qrResult?.location || null,
            inspectedAt: new Date(),
          },
        },
      });

      // Duplicate check (will correctly recognize authorized replacement)
      let duplicateResult = null;
      try {
        duplicateResult = await detectFdrDuplicates({ fdrId: replacement._id, fdrRecord: replacement });
        replacement.duplicateCheck = duplicateResult;
      } catch {
        // safe fallback
      }

      const trustScoreResult = calculateFdrTrustScore({
        fdr: replacement,
        forensicAnalysis: null,
        duplicateResult,
        bankVerification: replacement.bankVerification,
        trigger: 'replacement_created',
      });
      replacement.trustScore = trustScoreResult;
      replacement.trustScoreHistory = [
        {
          score: trustScoreResult.score,
          category: trustScoreResult.category,
          evidenceCoverage: trustScoreResult.evidenceCoverage,
          version: trustScoreResult.version,
          calculatedAt: trustScoreResult.calculatedAt,
          summary: trustScoreResult.summary,
          trigger: 'replacement_created',
        },
      ];

      const riskAssessmentResult = calculateFdrRiskScore({
        fdr: replacement,
        previousFdr: original,
        duplicateResult,
      });
      replacement.riskAssessment = riskAssessmentResult;

      await replacement.save({ session });
      await writeAudit({
        actor: user._id,
        actorRole: user.role,
        action: 'fdr_replacement_submitted',
        entityId: replacement._id,
        outcome: 'success',
        reason: 'Authorized replacement / renewal instrument submitted with new document version.',
        documentVersion: newVersion,
        documentChecksum: document.checksum,
        metadata: {
          originalFdrId: String(original._id),
          previousStatus: null,
          nextStatus: replacement.workflowStatus,
          submittedAt: document.uploadedAt,
        },
      }).save({ session });
    });
  } catch (error) {
    await cleanupStoredFile(document.storageKey);
    if (error.code === 11000) {
      throw new FdrWorkflowError(409, 'replacement_exists', 'A replacement record already exists for this FDR.');
    }
    throw error;
  }
  return { original: serializeFdr(original), replacement: serializeFdr(replacement) };
};

const serializeReleaseRequest = (request) => ({
  id: String(request._id),
  fdrId: request.fdrId?._id
    ? { id: String(request.fdrId._id), fdrNumber: request.fdrId.fdrNumber }
    : String(request.fdrId),
  institution: request.institution?._id
    ? { id: String(request.institution._id), name: request.institution.name, institutionCode: request.institution.institutionCode }
    : String(request.institution),
  reason: request.reason,
  status: request.status,
  history: (request.history || []).map((entry) => ({
    id: String(entry._id),
    actor: String(entry.actor),
    actorRole: entry.actorRole,
    decision: entry.decision,
    reason: entry.reason,
    previousStatus: entry.previousStatus,
    nextStatus: entry.nextStatus,
    timestamp: entry.timestamp,
  })),
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

export const createReleaseRequest = async ({ user, fdrId, reason }) => {
  if (!institutionRoles.has(user?.role)) {
    throw new FdrWorkflowError(403, 'forbidden', 'Only institution users may submit a release request.');
  }
  const fdr = await getFdrById({ user, fdrId });
  const requestId = new mongoose.Types.ObjectId();
  let result;
  let previousRequestStatus = 'new';
  await withSession(async (session) => {
    const current = await ReleaseRequest.findOne({ fdrId: fdr._id, active: true }).session(session);
    const timestamp = new Date();
    if (current?.status === 'submitted') {
      throw new FdrWorkflowError(409, 'request_already_pending', 'A release request is already awaiting review.');
    }
    if (current?.status === 'information_requested') {
      const previousStatus = current.status;
      previousRequestStatus = previousStatus;
      current.reason = reason;
      current.status = 'submitted';
      current.history.push({
        actor: user._id,
        actorRole: user.role,
        decision: 'resubmit_request',
        reason,
        previousStatus,
        nextStatus: 'submitted',
        timestamp,
      });
      await current.save({ session });
      result = current;
    } else {
      result = new ReleaseRequest({
        _id: requestId,
        fdrId: fdr._id,
        institution: fdr.institution,
        requestedBy: user._id,
        reason,
        status: 'submitted',
        active: true,
        history: [{
          actor: user._id,
          actorRole: user.role,
          decision: 'submit_request',
          reason,
          previousStatus: 'new',
          nextStatus: 'submitted',
          timestamp,
        }],
      });
      await result.save({ session });
    }
    await writeAudit({
      actor: user._id,
      action: current ? 'fdr_release_request_resubmitted' : 'fdr_release_request_submitted',
      entityId: fdr._id,
      metadata: {
        requestId: String(result._id),
        previousStatus: previousRequestStatus,
        nextStatus: 'submitted',
      },
    }).save({ session });
  });
  return serializeReleaseRequest(result);
};

export const listReleaseRequests = async ({ user, query }) => {
  requireOfficial(user);
  const filter = query.status ? { status: query.status } : {};
  const [total, records] = await Promise.all([
    ReleaseRequest.countDocuments(filter),
    ReleaseRequest.find(filter)
      .select('fdrId institution requestedBy reason status createdAt updatedAt')
      .populate('fdrId', 'fdrNumber amount currency workflowStatus maturityDate')
      .populate('institution', 'name institutionCode')
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);
  return {
    requests: records.map((record) => ({
      id: String(record._id),
      status: record.status,
      reason: record.reason,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      fdr: record.fdrId && {
        id: String(record.fdrId._id || record.fdrId),
        fdrNumber: record.fdrId.fdrNumber,
        amount: record.fdrId.amount,
        currency: record.fdrId.currency,
        workflowStatus: record.fdrId.workflowStatus,
        maturityDate: record.fdrId.maturityDate,
      },
      institution: record.institution && {
        id: String(record.institution._id || record.institution),
        name: record.institution.name,
        institutionCode: record.institution.institutionCode,
      },
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
};

export const getReleaseRequest = async ({ user, requestId }) => {
  requireOfficial(user);
  const request = await ReleaseRequest.findById(requestId)
    .populate('fdrId', 'fdrNumber amount currency workflowStatus maturityDate')
    .populate('institution', 'name institutionCode');
  if (!request) throw new FdrWorkflowError(404, 'request_not_found', 'Release request not found.');
  return serializeReleaseRequest(request);
};

const releaseTransitions = {
  request_information: { from: 'submitted', to: 'information_requested' },
  approve_request: { from: 'submitted', to: 'approved' },
  reject_request: { from: 'submitted', to: 'rejected' },
};

export const decideReleaseRequest = async ({ user, requestId, decision, reason }) => {
  requireOfficial(user);
  let updated;
  await withSession(async (session) => {
    const request = await ReleaseRequest.findById(requestId).session(session);
    if (!request) throw new FdrWorkflowError(404, 'request_not_found', 'Release request not found.');
    const transition = releaseTransitions[decision];
    if (!transition) throw new FdrWorkflowError(400, 'invalid_decision', 'The release decision is not supported.');
    if (request.status !== transition.from) {
      throw new FdrWorkflowError(409, 'invalid_transition', `A decision cannot be applied while the request is "${request.status}".`);
    }
    if (decision === 'approve_request') {
      const fdr = await FDR.findById(request.fdrId).session(session);
      if (!fdr) throw new FdrWorkflowError(404, 'fdr_not_found', 'The linked FDR was not found.');
      if (!['review_completed', 'approved'].includes(fdr.workflowStatus) && fdr.financialStatus !== 'matured') {
        throw new FdrWorkflowError(
          409,
          'release_not_eligible',
          'The linked FDR must complete administrative review or reach maturity before this request can be approved.',
        );
      }
    }
    const previousStatus = request.status;
    const timestamp = new Date();
    request.status = transition.to;
    if (transition.to === 'approved' || transition.to === 'rejected') {
      request.active = false;
    }
    request.history.push({
      actor: user._id,
      actorRole: user.role,
      decision,
      reason,
      previousStatus,
      nextStatus: transition.to,
      timestamp,
    });
    await request.save({ session });
    await writeAudit({
      actor: user._id,
      action: 'fdr_release_request_decided',
      entityId: request.fdrId,
      metadata: {
        requestId: String(request._id),
        decision,
        reason,
        previousStatus,
        nextStatus: transition.to,
        timestamp,
      },
    }).save({ session });
    updated = request;
  });
  return serializeReleaseRequest(updated);
};
