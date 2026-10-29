import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';
import { getMaxUploadBytes } from '../services/document-storage.service.js';
import {
  checkDeadlinesController,
  createBankConfirmationController,
  downloadConfirmationEvidenceController,
  getBankConfirmationByIdController,
  getBankConfirmationSummaryController,
  listBankConfirmationsController,
  recordBankResponseController,
  recordBankSubmissionController,
  updateConfirmationStatusController,
  uploadConfirmationEvidenceController,
} from '../controllers/bank-confirmation.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getMaxUploadBytes(),
    files: 1,
  },
});

const router = Router();
router.use(authenticate);

// Specific routes before param routes
router.get('/summary', getBankConfirmationSummaryController);
router.post('/check-deadlines', authorizeRoles('aicte_admin', 'reviewer'), checkDeadlinesController);

// Collection routes
router.get('/', listBankConfirmationsController);
router.post(
  '/',
  authorizeRoles('institution_admin', 'institution_user', 'aicte_admin', 'reviewer'),
  upload.single('document'),
  createBankConfirmationController,
);

// Detail and action routes
router.get('/:id', getBankConfirmationByIdController);
router.patch(
  '/:id/status',
  authorizeRoles('aicte_admin', 'reviewer', 'institution_admin', 'institution_user'),
  updateConfirmationStatusController,
);
router.post(
  '/:id/submission',
  authorizeRoles('aicte_admin', 'reviewer'),
  upload.single('document'),
  recordBankSubmissionController,
);
router.post(
  '/:id/response',
  authorizeRoles('aicte_admin', 'reviewer'),
  upload.single('document'),
  recordBankResponseController,
);
router.post(
  '/:id/documents',
  authorizeRoles('aicte_admin', 'reviewer', 'institution_admin', 'institution_user'),
  upload.single('document'),
  uploadConfirmationEvidenceController,
);
router.get('/:id/documents/:docId', downloadConfirmationEvidenceController);

export default router;

