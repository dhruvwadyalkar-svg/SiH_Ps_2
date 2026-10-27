import { Router } from 'express';
import {
  adminDashboardSummaryController,
  adminFdrReportController,
  adminFdrReportExportController,
} from '../controllers/phase9-dashboard.controller.js';
import {
  decideFdrReviewController,
  decideReleaseRequestController,
  getFdrReviewDetailsController,
  getReleaseRequestController,
  getFdrReviewQueueController,
  listReleaseRequestsController,
} from '../controllers/fdr-workflow.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';

const router = Router();

router.use(authenticate);
router.use(authorizeRoles('aicte_admin', 'reviewer'));
router.get('/dashboard/summary', adminDashboardSummaryController);
router.get('/reports/fdrs/export', adminFdrReportExportController);
router.get('/reports/fdrs', adminFdrReportController);
router.get('/fdrs/review-queue', getFdrReviewQueueController);
router.get('/fdrs/:id/review', getFdrReviewDetailsController);
router.post('/fdrs/:id/review', decideFdrReviewController);
router.get('/release-requests', listReleaseRequestsController);
router.get('/release-requests/:requestId', getReleaseRequestController);
router.post('/release-requests/:requestId/decision', decideReleaseRequestController);

export default router;
