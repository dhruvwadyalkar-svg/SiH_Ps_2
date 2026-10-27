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
      },
    },
  ]);

  const byWorkflowStatus = Object.fromEntries(
    (result.byWorkflowStatus || []).map(({ _id, count }) => [_id, count]),
  );
  return {
    totalFdrs: countFromFacet(result.total),
    byWorkflowStatus,
    approachingMaturity: countFromFacet(result.approachingMaturity),
    maturedAwaitingAction: countFromFacet(result.maturedAwaitingAction),
    pendingReview: countFromFacet(result.pendingReview),
    correctionRequests: countFromFacet(result.correctionRequests),
    renewalReplacementWorkload: countFromFacet(result.renewalReplacementWorkload),
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

export const getInstitutionDashboardSummary = async ({ user, now = new Date() }) => {
  if (!institutionRoles.has(user?.role)) throw new DashboardServiceError(403, 'Institution access is required.');
  const institutionId = getInstitutionId(user);
  if (!institutionId) throw new DashboardServiceError(404, 'No institution is associated with this user.');
  const { today, upcomingEnd } = getDateWindow(now);
  const [fdrs, activeReleaseRequests, unreadNotifications] = await Promise.all([
    getFdrDashboardCounts({ institutionId, today, upcomingEnd }),
    ReleaseRequest.countDocuments({ institution: institutionId, active: true }),
    Notification.countDocuments({ recipient: user._id, readAt: null }),
  ]);
  return {
    period: { upcomingMaturityDays: 30, asOfDate: dateOnlyKey(now) },
    ...fdrs,
    activeReleaseRequests,
    unreadNotifications,
  };
};

export const getAdminDashboardSummary = async ({ user, now = new Date() }) => {
  if (!officialRoles.has(user?.role)) throw new DashboardServiceError(403, 'Only authorized AICTE officials may access this summary.');
  const { today, upcomingEnd } = getDateWindow(now);
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 30);
  const [totalInstitutions, fdrs, activeReleaseRequests, recentWorkload, unreadNotifications] = await Promise.all([
    Institution.countDocuments({}),
    getFdrDashboardCounts({ today, upcomingEnd }),
    ReleaseRequest.countDocuments({ active: true }),
    AuditLog.aggregate([
      { $match: { entityType: 'FDR', createdAt: { $gte: since } } },
      {
        $lookup: {
          from: 'users',
          localField: 'actor',
          foreignField: '_id',
          as: 'actorRecord',
        },
      },
      { $unwind: '$actorRecord' },
      { $match: { 'actorRecord.role': { $in: [...officialRoles] } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),
    Notification.countDocuments({ recipient: user._id, readAt: null }),
  ]);
  return {
    period: { upcomingMaturityDays: 30, recentAdministrativeWorkloadDays: 30, asOfDate: dateOnlyKey(now) },
    totalInstitutions,
    ...fdrs,
    activeReleaseRequests,
    unreadNotifications,
    recentAdministrativeWorkload: Object.fromEntries(recentWorkload.map(({ _id, count }) => [_id, count])),
  };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const makeReportFilter = async (query) => {
  const filter = {};
  if (query.workflowStatus) filter.workflowStatus = query.workflowStatus;
  if (query.institutionId) filter.institution = query.institutionId;
  if (query.maturityFrom || query.maturityTo) {
    filter.maturityDate = {};
    if (query.maturityFrom) filter.maturityDate.$gte = new Date(`${query.maturityFrom}T00:00:00.000Z`);
    if (query.maturityTo) filter.maturityDate.$lte = new Date(`${query.maturityTo}T23:59:59.999Z`);
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const matches = await Institution.find({
      $or: [{ name: pattern }, { institutionCode: pattern }],
    }).select('_id').limit(5000);
    filter.$or = [
      { fdrNumber: pattern },
      { institution: { $in: matches.map(({ _id }) => _id) } },
    ];
  }
  return filter;
};

const safeReportRecord = (record) => ({
  id: String(record._id),
  institution: record.institution
    ? {
        id: String(record.institution._id || record.institution),
        name: record.institution.name || null,
        institutionCode: record.institution.institutionCode || null,
      }
    : null,
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
  createdAt: record.createdAt,
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
