import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';
import {
  createFdrController,
  downloadFdrDocumentController,
  getFdrController,
  getFdrExtractionController,
  getFdrForensicsController,
  listFdrController,
  requestFdrExtractionController,
  runFdrForensicsController,
  updateFdrController,
} from '../controllers/fdr.controller.js';
import { getMaxUploadBytes } from '../services/document-storage.service.js';
import {
  createFdrRenewalController,
  createReleaseRequestController,
} from '../controllers/fdr-workflow.controller.js';
import {
  getFdrIntegrityHistoryController,
  getIntegritySummaryController,
  investigateIntegrityAlertController,
  listIntegrityRecordsController,
  runBulkIntegrityCheckController,
  verifyDocumentIntegrityController,
} from '../controllers/audit-log.controller.js';

const extractionRoles = ['institution_admin', 'institution_user', 'aicte_admin', 'reviewer'];

const userKey = (request) =>
  request.user?._id ? `user:${request.user._id}` : `ip:${ipKeyGenerator(request.ip)}`;
const extractionRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: userKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many OCR requests. Try again later.' },
});
const extractionPollingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: userKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many OCR status checks. Try again shortly.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getMaxUploadBytes(),
    files: 1,
  },
});

const router = Router();
router.use(authenticate);

router.post('/', authorizeRoles('institution_admin', 'institution_user'), upload.single('document'), createFdrController);
router.get('/', authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'), listFdrController);

router.get(
  '/integrity/summary',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  getIntegritySummaryController,
);
router.get(
  '/integrity/records',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  listIntegrityRecordsController,
);
router.post(
  '/integrity/check-all',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  runBulkIntegrityCheckController,
);

router.get(
  '/:id',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  getFdrController,
);
router.patch(
  '/:id',
  authorizeRoles('institution_admin', 'institution_user'),
  updateFdrController,
);
router.get(
  '/:id/document',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  downloadFdrDocumentController,
);
router.post(
  '/:id/extract',
  authorizeRoles(...extractionRoles),
  extractionRequestLimiter,
  requestFdrExtractionController,
);
router.get(
  '/:id/extraction',
  authorizeRoles(...extractionRoles),
  extractionPollingLimiter,
  getFdrExtractionController,
);
router.post(
  '/:id/forensics',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  runFdrForensicsController,
);
router.get(
  '/:id/forensics',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  getFdrForensicsController,
);
router.post(
  '/:id/renewal',
  authorizeRoles('institution_admin', 'institution_user'),
  upload.single('document'),
  createFdrRenewalController,
);
router.post(
  '/:id/release-requests',
  authorizeRoles('institution_admin', 'institution_user'),
  createReleaseRequestController,
);
router.post(
  '/:id/verify-integrity',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  verifyDocumentIntegrityController,
);
router.get(
  '/:id/integrity-history',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  getFdrIntegrityHistoryController,
);
router.post(
  '/:id/integrity-alerts/:alertId/investigate',
  authorizeRoles('aicte_admin', 'reviewer'),
  investigateIntegrityAlertController,
);

export default router;
