import { Router } from 'express';
import {
  listNotificationsController,
  markAllNotificationsReadController,
  markNotificationReadController,
  unreadNotificationCountController,
} from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listNotificationsController);
router.get('/unread-count', unreadNotificationCountController);
router.patch('/read-all', markAllNotificationsReadController);
router.patch('/:id/read', markNotificationReadController);

export default router;
