import Notification from '../models/Notification.js';

export class NotificationServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const safeNotification = (notification) => ({
  id: String(notification._id),
  type: notification.type,
  title: notification.title,
  message: notification.message,
  metadata: {
    fdrNumber: notification.metadata?.fdrNumber || null,
    maturityDate: notification.metadata?.maturityDate || null,
    reminderStage: notification.metadata?.reminderStage || null,
  },
  fdrId: notification.fdr ? String(notification.fdr) : null,
  institutionId: notification.institution ? String(notification.institution) : null,
  createdAt: notification.createdAt,
  readAt: notification.readAt,
});

export const listNotifications = async ({ userId, query }) => {
  const filter = { recipient: userId };
  if (query.unreadOnly) filter.readAt = null;
  const [total, records, unreadCount] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.find(filter)
      .select('type title message metadata fdr institution createdAt readAt')
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Notification.countDocuments({ recipient: userId, readAt: null }),
  ]);
  return {
    notifications: records.map(safeNotification),
    unreadCount,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
};

export const getUnreadNotificationCount = async (userId) =>
  Notification.countDocuments({ recipient: userId, readAt: null });

export const markNotificationRead = async ({ userId, notificationId, now = new Date() }) => {
  const result = await Notification.updateOne(
    { _id: notificationId, recipient: userId, readAt: null },
    { $set: { readAt: now } },
  );
  if (result.matchedCount === 0) {
    const existing = await Notification.findOne({ _id: notificationId, recipient: userId }).select('readAt');
    if (!existing) throw new NotificationServiceError(404, 'Notification not found.');
    return { id: String(notificationId), readAt: existing.readAt };
  }
  return { id: String(notificationId), readAt: now };
};

export const markAllNotificationsRead = async ({ userId, now = new Date() }) => {
  const result = await Notification.updateMany(
    { recipient: userId, readAt: null },
    { $set: { readAt: now } },
  );
  return { modifiedCount: result.modifiedCount };
};
