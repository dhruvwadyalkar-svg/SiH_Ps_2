import { Router } from 'express';
import {
  getOwnInstitutionController,
  getInstitutionReviewDetailsController,
  listInstitutionsController,
  reviewInstitutionStatusController,
  updateOwnInstitutionController,
} from '../controllers/institution.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';

const router = Router();

router.use(authenticate);
router
  .route('/me')
  .all(authorizeRoles('institution_admin', 'institution_user'))
  .get(getOwnInstitutionController)
  .patch(updateOwnInstitutionController);

export const adminInstitutionRouter = Router();
adminInstitutionRouter.use(authenticate);
adminInstitutionRouter.use(authorizeRoles('aicte_admin', 'reviewer'));
adminInstitutionRouter.get('/', listInstitutionsController);
adminInstitutionRouter.get('/:institutionId', getInstitutionReviewDetailsController);
adminInstitutionRouter.patch(
  '/:institutionId/status',
  authorizeRoles('aicte_admin', 'reviewer'),
  reviewInstitutionStatusController,
);

export default router;
