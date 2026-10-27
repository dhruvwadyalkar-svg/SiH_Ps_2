import { Router } from 'express';
import { institutionDashboardSummaryController } from '../controllers/phase9-dashboard.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRoles } from '../middleware/authorizeRoles.js';

const router = Router();

router.use(authenticate, authorizeRoles('institution_admin', 'institution_user'));
router.get('/summary', institutionDashboardSummaryController);

export default router;
