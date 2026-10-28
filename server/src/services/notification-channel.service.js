export const SUPPORTED_MESSAGE_LOCALES = [
  'en',
  'hi',
  'mr',
  'ta',
  'te',
  'kn',
  'gu',
  'bn',
];

export const MESSAGE_TEMPLATES = {
  en: {
    '90d': {
      title: 'FDR Maturity Notice (90 days)',
      body: ({ fdrNumber, maturityDate, daysUntilMaturity }) =>
        `FDR ${fdrNumber} is scheduled to mature in ${daysUntilMaturity} days (${maturityDate}). Please prepare renewal or release requirements in advance.`,
    },
    '30d': {
      title: 'FDR Approaching Maturity (30 days)',
      body: ({ fdrNumber, maturityDate, daysUntilMaturity }) =>
        `FDR ${fdrNumber} matures in ${daysUntilMaturity} days (${maturityDate}). Official review and institution renewal/release action should be initiated.`,
    },
    '7d': {
      title: 'Urgent: FDR Maturity within 7 days',
      body: ({ fdrNumber, maturityDate, daysUntilMaturity }) =>
        `Urgent: FDR ${fdrNumber} matures in ${daysUntilMaturity} days (${maturityDate}). Designated officer attention required to ensure continuity.`,
    },
    overdue: {
      title: 'Notice: Overdue FDR Instrument',
      body: ({ fdrNumber, maturityDate, daysOverdue }) =>
        `Notice: FDR ${fdrNumber} matured ${daysOverdue} days ago (${maturityDate}) and is awaiting administrative renewal, replacement, or release action.`,
    },
  },
  hi: {
    '90d': {
      title: 'एफडीआर परिपक्वता सूचना (90 दिन)',
      body: ({ fdrNumber, maturityDate, daysUntilMaturity }) =>
        `एफडीआर ${fdrNumber} ${daysUntilMaturity} दिनों में (${maturityDate}) परिपक्व होने वाला है। कृपया नवीनीकरण अथवा विमुक्ति की तैयारी करें।`,
    },
    '30d': {
      title: 'एफडीआर परिपक्वता निकट (30 दिन)',
      body: ({ fdrNumber, maturityDate, daysUntilMaturity }) =>
        `एफडीआर ${fdrNumber} ${daysUntilMaturity} दिनों में (${maturityDate}) परिपक्व हो रहा है। आधिकारिक समीक्षा एवं संस्थागत कार्यवाही आवश्यक है।`,
    },
    '7d': {
      title: 'अति आवश्यक: एफडीआर परिपक्वता 7 दिन में',
      body: ({ fdrNumber, maturityDate, daysUntilMaturity }) =>
        `अति आवश्यक: एफडीआर ${fdrNumber} ${daysUntilMaturity} दिनों में (${maturityDate}) परिपक्व होगा। नामित अधिकारी का ध्यान अपेक्षित है।`,
    },
    overdue: {
      title: 'सूचना: परिपक्व (अतिदेय) एफडीआर',
      body: ({ fdrNumber, maturityDate, daysOverdue }) =>
        `सूचना: एफडीआर ${fdrNumber} ${daysOverdue} दिन पूर्व (${maturityDate}) परिपक्व हो चुका है एवं प्रशासनिक कार्यवाही हेतु प्रतीक्षारत है।`,
    },
  },
};

export const getLocalizedMessage = ({ stage, fdrNumber, maturityDate, daysUntilMaturity, locale = 'en' }) => {
  const normLocale = (locale || 'en').toLowerCase().slice(0, 2);
  const localeMap = MESSAGE_TEMPLATES[normLocale] || MESSAGE_TEMPLATES.en;
  const stageTemplate = localeMap[stage] || MESSAGE_TEMPLATES.en[stage] || MESSAGE_TEMPLATES.en['30d'];

  const daysOverdue = daysUntilMaturity < 0 ? Math.abs(daysUntilMaturity) : 0;
  return {
    title: stageTemplate.title,
    message: stageTemplate.body({ fdrNumber, maturityDate, daysUntilMaturity, daysOverdue }),
    locale: MESSAGE_TEMPLATES[normLocale] ? normLocale : 'en',
  };
};

export const getNotificationChannelsConfig = (env = process.env) => ({
  inApp: true, // Always available
  email: {
    enabled: env.EMAIL_NOTIFICATIONS_ENABLED === 'true' && Boolean(env.SMTP_HOST && env.SMTP_USER),
    configured: Boolean(env.SMTP_HOST && env.SMTP_USER),
    host: env.SMTP_HOST || null,
  },
  sms: {
    enabled: env.SMS_NOTIFICATIONS_ENABLED === 'true' && Boolean(env.SMS_PROVIDER_API_KEY),
    configured: Boolean(env.SMS_PROVIDER_API_KEY),
  },
  whatsapp: {
    enabled: env.WHATSAPP_NOTIFICATIONS_ENABLED === 'true' && Boolean(env.WHATSAPP_API_KEY),
    configured: Boolean(env.WHATSAPP_API_KEY),
  },
});

export const dispatchNotification = async ({
  channel,
  recipient,
  title,
  message,
  metadata = {},
  config = getNotificationChannelsConfig(),
}) => {
  if (channel === 'in_app') {
    return { channel: 'in_app', status: 'delivered', recipientId: recipient._id };
  }

  if (channel === 'email') {
    if (!config.email.enabled) {
      return {
        channel: 'email',
        status: 'disabled',
        reason: 'Email notifications are not enabled or SMTP credentials not configured.',
      };
    }
    // In production with credentials, email provider sends here
    return { channel: 'email', status: 'queued', to: recipient.email };
  }

  if (channel === 'sms') {
    if (!config.sms.enabled) {
      return {
        channel: 'sms',
        status: 'disabled',
        reason: 'SMS notifications are not enabled or SMS credentials not configured.',
      };
    }
    return { channel: 'sms', status: 'queued', to: recipient.phone };
  }

  if (channel === 'whatsapp') {
    if (!config.whatsapp.enabled) {
      return {
        channel: 'whatsapp',
        status: 'disabled',
        reason: 'WhatsApp notifications are not enabled or WhatsApp credentials not configured.',
      };
    }
    return { channel: 'whatsapp', status: 'queued', to: recipient.phone };
  }

  return { channel, status: 'unsupported' };
};

export const notificationChannelService = {
  SUPPORTED_MESSAGE_LOCALES,
  MESSAGE_TEMPLATES,
  getLocalizedMessage,
  getNotificationChannelsConfig,
  dispatchNotification,
};

export default notificationChannelService;

