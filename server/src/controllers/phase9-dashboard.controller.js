import {
  DashboardServiceError,
  exportAdminFdrReport,
  getAdminDashboardSummary,
  getInstitutionDashboardSummary,
  listAdminFdrReport,
  listAdminRiskBoard,
} from '../services/phase9-dashboard.service.js';
import {
  reportExportQuerySchema,
  reportQuerySchema,
} from '../utils/phase9.validation.js';

const validationError = (response, error) => response.status(400).json({
  error: 'Invalid request.',
  details: error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  })),
});

const handleError = (response, error) => {
  if (!(error instanceof DashboardServiceError)) return false;
  response.status(error.status).json({ error: error.message });
  return true;
};

export const institutionDashboardSummaryController = async (request, response, next) => {
  try {
    return response.status(200).json(await getInstitutionDashboardSummary({ user: request.user }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const adminDashboardSummaryController = async (request, response, next) => {
  try {
    return response.status(200).json(await getAdminDashboardSummary({ user: request.user }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const adminFdrReportController = async (request, response, next) => {
  const parsed = reportQuerySchema.safeParse(request.query);
  if (!parsed.success) return validationError(response, parsed.error);
  try {
    return response.status(200).json(await listAdminFdrReport({
      user: request.user,
      query: parsed.data,
    }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const adminFdrReportExportController = async (request, response, next) => {
  const parsed = reportExportQuerySchema.safeParse(request.query);
  if (!parsed.success) return validationError(response, parsed.error);
  try {
    const { csv, rowCount } = await exportAdminFdrReport({
      user: request.user,
      query: parsed.data,
    });
    response.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="fdr-management-report.csv"',
      'Cache-Control': 'no-store',
    });
    return response.status(200).send(csv);
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const adminRiskBoardController = async (request, response, next) => {
  try {
    return response.status(200).json(await listAdminRiskBoard({
      user: request.user,
      query: request.query,
    }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};
