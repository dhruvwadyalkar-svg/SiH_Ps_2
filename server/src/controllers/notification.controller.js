import {
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NotificationServiceError,
} from '../services/notification.service.js';
import {
  notificationIdSchema,
  notificationListQuerySchema,
} from '../utils/phase9.validation.js';

const validationError = (response, error) => response.status(400).json({
  error: 'Invalid request.',
  details: error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  })),
});

const handleError = (response, error) => {
  if (!(error instanceof NotificationServiceError)) return false;
  response.status(error.status).json({ error: error.message });
  return true;
};

export const listNotificationsController = async (request, response, next) => {
  const parsed = notificationListQuerySchema.safeParse(request.query);
  if (!parsed.success) return validationError(response, parsed.error);
  try {
    return response.status(200).json(await listNotifications({
      userId: request.user._id,
      query: parsed.data,
    }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const unreadNotificationCountController = async (request, response, next) => {
  try {
    const unreadCount = await getUnreadNotificationCount(request.user._id);
    return response.status(200).json({ unreadCount });
  } catch (error) {
    return next(error);
  }
};

export const markNotificationReadController = async (request, response, next) => {
  const parsedId = notificationIdSchema.safeParse(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid notification ID.' });
  try {
    return response.status(200).json(await markNotificationRead({
      userId: request.user._id,
      notificationId: parsedId.data,
    }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const markAllNotificationsReadController = async (request, response, next) => {
  try {
    return response.status(200).json(await markAllNotificationsRead({ userId: request.user._id }));
  } catch (error) {
    return next(error);
  }
};
