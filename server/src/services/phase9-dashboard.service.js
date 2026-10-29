import mongoose from 'mongoose';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import Notification from '../models/Notification.js';
import ReleaseRequest from '../models/ReleaseRequest.js';
import { dateOnlyKey } from '../utils/date-only.js';

const officialRoles = new Set(['aicte_admin', 'reviewer']);
const institutionRoles = new Set(['institution_admin', 'institution_user']);
const liveReplacementStatuses = ['submitted', 'under_review', 'correction_requested', 'review_completed', 'approved'];
const currentWorkflowStatusMatch = { $nin: ['released', 'expired'] };
const currentFinancialStatusMatch = { $in: ['active', 'matured'] };
const ADMIN_EXPORT_MAX_ROWS = 5000;

export class DashboardServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const getInstitutionId = (user) => {
  const id = user?.institution?._id || user?.institution;
  return id ? String(id) : null;
};

const currentInstrumentStages = [
  { $match: { workflowStatus: currentWorkflowStatusMatch, financialStatus: currentFinancialStatusMatch } },
  {
    $lookup: {
      from: FDR.collection.name,
      localField: '_id',
      foreignField: 'replacesFdr',
      pipeline: [{ $match: { workflowStatus: { $in: liveReplacementStatuses } } }, { $limit: 1 }],
      as: 'currentReplacement',
    },
  },
  { $match: { 'currentReplacement.0': { $exists: false } } },
];

const countFromFacet = (facet) => facet?.[0]?.count || 0;

const getFdrDashboardCounts = async ({ institutionId, today, upcomingEnd }) => {
  const initialMatch = {};
  if (institutionId) initialMatch.institution = new mongoose.Types.ObjectId(institutionId);
  const [result = {}] = await FDR.aggregate([
    { $match: initialMatch },
    ...currentInstrumentStages,
    {
      $facet: {
        total: [{ $count: 'count' }],
        byWorkflowStatus: [{ $group: { _id: '$workflowStatus', count: { $sum: 1 } } }],
        approachingMaturity: [
          { $match: { maturityDate: { $gte: today, $lte: upcomingEnd } } },
          { $count: 'count' },
        ],
        maturedAwaitingAction: [
          { $match: { maturityDate: { $lt: today }, financialStatus: { $in: ['active', 'matured'] } } },
          { $count: 'count' },
        ],
        pendingReview: [
          { $match: { workflowStatus: { $in: ['submitted', 'under_review'] } } },
          { $count: 'count' },
        ],
        correctionRequests: [
          { $match: { workflowStatus: 'correction_requested' } },
          { $count: 'count' },
        ],
        renewalReplacementWorkload: [
          { $match: { replacesFdr: { $ne: null }, workflowStatus: { $in: ['submitted', 'under_review', 'correction_requested'] } } },
          { $count: 'count' },
        ],
        integrityVerified: [
          { $match: { 'integrityStatus.status': 'verified' } },
          { $count: 'count' },
        ],
        integrityMismatch: [
          { $match: { 'integrityStatus.status': 'mismatch' } },
          { $count: 'count' },
        ],
        integrityUnavailable: [
          {
            $match: {
              $or: [
                { 'integrityStatus.status': 'unavailable' },
                { 'documentMetadata.storageRef': { $in: [null, ''] } },
                { 'documentMetadata.checksum': { $in: [null, ''] } },
              ],
            },
          },
          { $count: 'count' },
        ],
      },
    },
  ]);

  const byWorkflowStatus = Object.fromEntries(
    (result.byWorkflowStatus || []).map(({ _id, count }) => [_id, count]),
  );
  const total = countFromFacet(result.total);
  const verified = countFromFacet(result.integrityVerified);
  const mismatch = countFromFacet(result.integrityMismatch);
  const unavailable = countFromFacet(result.integrityUnavailable);
  const notChecked = Math.max(0, total - verified - mismatch - unavailable);

  return {
    totalFdrs: total,
    byWorkflowStatus,
    approachingMaturity: countFromFacet(result.approachingMaturity),
    maturedAwaitingAction: countFromFacet(result.maturedAwaitingAction),
    pendingReview: countFromFacet(result.pendingReview),
    correctionRequests: countFromFacet(result.correctionRequests),
    renewalReplacementWorkload: countFromFacet(result.renewalReplacementWorkload),
    integritySummary: {
      total,
      verified,
      mismatch,
      unavailable,
      notChecked,
      notCheckedOrUnavailable: notChecked + unavailable,
    },
  };
};

const getDateWindow = (now) => {
  const todayKey = dateOnlyKey(now);
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  const upcomingEnd = new Date(today);
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 30);
  upcomingEnd.setUTCHours(23, 59, 59, 999);
  return { today, upcomingEnd };
};

const getUnreadNotificationCount = async (userId) =>
  Notification.countDocuments({ recipient: userId, readAt: null });

export const getInstitutionDashboardSummary = async ({ user, now = new Date() }) => {
  if (!institutionRoles.has(user?.role)) {
    throw new DashboardServiceError(403, 'Only institution users may access the institution dashboard.');
  }
  const institutionId = getInstitutionId(user);
  if (!institutionId) {
    throw new DashboardServiceError(404, 'No institution is associated with this user.');
  }

  const { today, upcomingEnd } = getDateWindow(now);
  const [fdrCounts, activeReleaseRequests, unreadNotifications] = await Promise.all([
    getFdrDashboardCounts({ institutionId, today, upcomingEnd }),
    ReleaseRequest.countDocuments({ institution: institutionId, active: true }),
    getUnreadNotificationCount(user._id),
  ]);

  return {
    role: user.role,
    institutionId,
    period: { asOfDate: now, timezone: 'Asia/Kolkata' },
    activeReleaseRequests,
    unreadNotifications,
    ...fdrCounts,
  };
};

export const getAdminDashboardSummary = async ({ user, now = new Date() }) => {
  if (!officialRoles.has(user?.role)) {
    throw new DashboardServiceError(403, 'Only authorized AICTE officials may access the admin dashboard.');
  }

  const { today, upcomingEnd } = getDateWindow(now);
  const [totalInstitutions, fdrCounts, totalPendingReleaseRequests, unreadNotifications, workloadAgg] = await Promise.all([
    Institution.countDocuments({}),
    getFdrDashboardCounts({ today, upcomingEnd }),
    ReleaseRequest.countDocuments({ status: 'submitted', active: true }),
    getUnreadNotificationCount(user._id),
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),
  ]);

  const recentAdministrativeWorkload = Object.fromEntries(
    (workloadAgg || []).map((item) => [item._id, item.count]),
  );

  return {
    role: user.role,
    period: { asOfDate: now, timezone: 'Asia/Kolkata' },
    totalInstitutions,
    totalPendingReleaseRequests,
    recentAdministrativeWorkload,
    unreadNotifications,
    ...fdrCounts,
  };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const makeReportFilter = async (query = {}) => {
  const filter = {
    workflowStatus: currentWorkflowStatusMatch,
    financialStatus: currentFinancialStatusMatch,
  };

  if (query.workflowStatus) filter.workflowStatus = query.workflowStatus;
  if (query.financialStatus) filter.financialStatus = query.financialStatus;

  if (query.maturityRange) {
    const [start, end] = query.maturityRange.split('..');
    const range = {};
    if (start) range.$gte = new Date(`${start}T00:00:00.000Z`);
    if (end) range.$lte = new Date(`${end}T23:59:59.999Z`);
    if (Object.keys(range).length > 0) filter.maturityDate = range;
  }

  if (query.search) {
    const searchPattern = new RegExp(escapeRegex(query.search), 'i');
    const matchedInstitutions = await Institution.find({
      $or: [{ name: searchPattern }, { institutionCode: searchPattern }],
    }).select('_id');
    const institutionIds = matchedInstitutions.map(({ _id }) => _id);

    filter.$or = [
      { fdrNumber: searchPattern },
      { bankName: searchPattern },
      { branch: searchPattern },
      ...(institutionIds.length ? [{ institution: { $in: institutionIds } }] : []),
    ];
  }

  return filter;
};

const safeReportRecord = (record) => ({
  id: String(record._id),
  fdrNumber: record.fdrNumber,
  bankName: record.bankName,
  branch: record.branch,
  amount: record.amount,
  currency: record.currency,
  issueDate: record.issueDate,
  maturityDate: record.maturityDate,
  workflowStatus: record.workflowStatus,
  financialStatus: record.financialStatus,
  replacesFdr: record.replacesFdr ? String(record.replacesFdr) : null,
  institution: record.institution
    ? {
        id: String(record.institution._id || record.institution),
        name: record.institution.name || null,
        institutionCode: record.institution.institutionCode || null,
      }
    : null,
});

const queryReportRecords = async ({ query, limit, skip = 0 }) => {
  const filter = await makeReportFilter(query);
  const [total, records] = await Promise.all([
    FDR.countDocuments(filter),
    FDR.find(filter)
      .select('institution fdrNumber bankName branch amount currency issueDate maturityDate workflowStatus financialStatus replacesFdr createdAt')
      .populate('institution', 'name institutionCode')
      .sort({ maturityDate: 1, _id: 1 })
      .skip(skip)
      .limit(limit),
  ]);
  return { total, records: records.map(safeReportRecord) };
};

export const listAdminFdrReport = async ({ user, query }) => {
  if (!officialRoles.has(user?.role)) throw new DashboardServiceError(403, 'Only authorized AICTE officials may access reports.');
  const { total, records } = await queryReportRecords({
    query,
    limit: query.limit,
    skip: (query.page - 1) * query.limit,
  });
  return {
    records,
    pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
  };
};

const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export const exportAdminFdrReport = async ({ user, query }) => {
  if (!officialRoles.has(user?.role)) throw new DashboardServiceError(403, 'Only authorized AICTE officials may export reports.');
  const { total, records } = await queryReportRecords({ query, limit: ADMIN_EXPORT_MAX_ROWS });
  if (total > ADMIN_EXPORT_MAX_ROWS) {
    throw new DashboardServiceError(413, `Export exceeds the ${ADMIN_EXPORT_MAX_ROWS}-record limit; narrow the filters.`);
  }
  const columns = [
    ['Institution', (row) => row.institution?.name],
    ['Institution Code', (row) => row.institution?.institutionCode],
    ['FDR Number', (row) => row.fdrNumber],
    ['Bank', (row) => row.bankName],
    ['Branch', (row) => row.branch],
    ['Amount', (row) => row.amount],
    ['Currency', (row) => row.currency],
    ['Issue Date', (row) => dateOnlyKey(row.issueDate)],
    ['Maturity Date', (row) => dateOnlyKey(row.maturityDate)],
    ['Workflow Status', (row) => row.workflowStatus],
    ['Financial Status', (row) => row.financialStatus],
    ['Replacement Of', (row) => row.replacesFdr],
  ];
  const csv = [
    columns.map(([title]) => csvCell(title)).join(','),
    ...records.map((record) => columns.map(([, value]) => csvCell(value(record))).join(',')),
  ].join('\r\n');

  await new AuditLog({
    actor: user._id,
    action: 'fdr_report_exported',
    entityType: 'FDR',
    metadata: { rowCount: records.length, exportLimit: ADMIN_EXPORT_MAX_ROWS },
  }).save();
  return { csv, rowCount: records.length };
};

export const listAdminRiskBoard = async ({ user, query = {} }) => {
  if (!officialRoles.has(user?.role)) {
    throw new DashboardServiceError(403, 'Only authorized AICTE officials may access the risk board.');
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const riskFilter = (query.riskFilter || 'all').toLowerCase();

  const now = new Date();
  const todayKey = dateOnlyKey(now);
  const today = new Date(`${todayKey}T00:00:00.000Z`);

  const sevenDaysFromNow = new Date(today);
  sevenDaysFromNow.setUTCDate(sevenDaysFromNow.getUTCDate() + 7);
  sevenDaysFromNow.setUTCHours(23, 59, 59, 999);

  const ninetyDaysFromNow = new Date(today);
  ninetyDaysFromNow.setUTCDate(ninetyDaysFromNow.getUTCDate() + 90);
  ninetyDaysFromNow.setUTCHours(23, 59, 59, 999);

  const baseFilter = {
    workflowStatus: currentWorkflowStatusMatch,
    financialStatus: currentFinancialStatusMatch,
  };

  if (riskFilter === 'overdue') {
    baseFilter.maturityDate = { $lt: today };
  } else if (riskFilter === 'due') {
    baseFilter.maturityDate = { $gte: today, $lte: sevenDaysFromNow };
  } else if (riskFilter === 'upcoming') {
    const eightDaysFromNow = new Date(today);
    eightDaysFromNow.setUTCDate(eightDaysFromNow.getUTCDate() + 8);
    baseFilter.maturityDate = { $gte: eightDaysFromNow, $lte: ninetyDaysFromNow };
  } else {
    // all risk-eligible
    baseFilter.maturityDate = { $lte: ninetyDaysFromNow };
  }

  if (query.search) {
    const searchPattern = new RegExp(escapeRegex(query.search), 'i');
    const matchedInstitutions = await Institution.find({
      $or: [{ name: searchPattern }, { institutionCode: searchPattern }],
    }).select('_id');
    const institutionIds = matchedInstitutions.map(({ _id }) => _id);

    baseFilter.$or = [
      { fdrNumber: searchPattern },
      { bankName: searchPattern },
      ...(institutionIds.length ? [{ institution: { $in: institutionIds } }] : []),
    ];
  }

  const [total, records] = await Promise.all([
    FDR.countDocuments(baseFilter),
    FDR.find(baseFilter)
      .select('institution fdrNumber bankName branch amount currency issueDate maturityDate workflowStatus financialStatus trustScore bankVerification duplicateCheck maturityEscalation createdAt')
      .populate('institution', 'name institutionCode')
      .sort({ maturityDate: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  const items = records.map((record) => {
    const maturityKey = dateOnlyKey(record.maturityDate);
    const daysRemaining = Math.round((new Date(record.maturityDate) - now) / (24 * 60 * 60 * 1000));
    let stageTag = 'upcoming';
    if (daysRemaining < 0) stageTag = 'overdue';
    else if (daysRemaining <= 7) stageTag = 'due';

    return {
      id: String(record._id),
      fdrNumber: record.fdrNumber,
      bankName: record.bankName,
      branch: record.branch,
      amount: record.amount,
      currency: record.currency,
      issueDate: record.issueDate,
      maturityDate: record.maturityDate,
      maturityKey,
      daysRemaining,
      stageTag,
      workflowStatus: record.workflowStatus,
      financialStatus: record.financialStatus,
      institution: record.institution
        ? {
            id: String(record.institution._id || record.institution),
            name: record.institution.name,
            institutionCode: record.institution.institutionCode,
          }
        : null,
      trustScore: record.trustScore ? {
        score: record.trustScore.score,
        category: record.trustScore.category,
        evidenceCoverage: record.trustScore.evidenceCoverage,
      } : null,
      bankVerificationStatus: record.bankVerification?.status || 'pending',
      duplicateStatus: record.duplicateCheck?.status || 'no_candidate_found',
    };
  });

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
    },
    filter: riskFilter,
  };
};
