import { Router } from 'express';
import {
  adminDashboardSummaryController,
  adminFdrReportController,
  adminFdrReportExportController,
  adminRiskBoardController,
} from '../controllers/phase9-dashboard.controller.js';
import {
  decideFdrReviewController,
  decideReleaseRequestController,
  getFdrReviewDetailsController,
  getReleaseRequestController,
  getFdrReviewQueueController,
  listReleaseRequestsController,
  recalculateTrustScoreController,
  recordBankVerificationController,
  recordDuplicateReviewController,
  reviewRiskFindingController,
  recalculateRiskScoreController,
} from '../controllers/fdr-workflow.controller.js';
import {
  exportAuditLogsCsvController,
  getAuditLogDetailsController,
  listAuditLogsController,
  verifyAuditChainController,
} from '../controllers/audit-log.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';

const router = Router();

router.use(authenticate);
router.use(authorizeRoles('aicte_admin', 'reviewer'));
router.get('/dashboard/summary', adminDashboardSummaryController);
router.get('/dashboard/risk-board', adminRiskBoardController);
router.get('/reports/fdrs/export', adminFdrReportExportController);
router.get('/reports/fdrs', adminFdrReportController);
router.get('/fdrs/review-queue', getFdrReviewQueueController);
router.get('/fdrs/risk-board', adminRiskBoardController);
router.get('/fdrs/:id/review', getFdrReviewDetailsController);
router.post('/fdrs/:id/review', decideFdrReviewController);
router.post('/fdrs/:id/bank-verification', recordBankVerificationController);
router.post('/fdrs/:id/duplicate-review', recordDuplicateReviewController);
router.post('/fdrs/:id/trust-score/recalculate', recalculateTrustScoreController);
router.post('/fdrs/:id/risk-findings/:findingId/review', reviewRiskFindingController);
router.post('/fdrs/:id/risk-score/recalculate', recalculateRiskScoreController);
router.get('/release-requests', listReleaseRequestsController);
router.get('/release-requests/:requestId', getReleaseRequestController);
router.post('/release-requests/:requestId/decision', decideReleaseRequestController);

router.get('/audit-trail/export', exportAuditLogsCsvController);
router.post('/audit-trail/verify-chain', verifyAuditChainController);
router.get('/audit-trail/:id', getAuditLogDetailsController);
router.get('/audit-trail', listAuditLogsController);

export default router;
