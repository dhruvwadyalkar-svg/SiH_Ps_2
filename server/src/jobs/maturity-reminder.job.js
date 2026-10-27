import mongoose from 'mongoose';
import FDR from '../models/FDR.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  dateOnlyKey,
  differenceInDateDays,
} from '../utils/date-only.js';

const institutionRoles = ['institution_admin', 'institution_user'];
const officialRoles = ['aicte_admin', 'reviewer'];
const reminderEligibleStatuses = ['review_completed', 'approved'];
const replacementStatuses = ['submitted', 'under_review', 'correction_requested', 'review_completed', 'approved'];
const PAGE_SIZE = 250;
const MAX_RECORDS_PER_RUN = 5000;
const DEFAULT_INTERVALS = [30, 15, 7];
const DEFAULT_OVERDUE_DAYS = 90;

const validObjectId = (value) => mongoose.isValidObjectId(value);

export const getMaturityReminderConfig = (env = process.env) => {
  const days = (env.MATURITY_REMINDER_DAYS || DEFAULT_INTERVALS.join(','))
    .split(',')
    .map((value) => Number(value.trim()));
  const validDays = [...new Set(days.filter((value) => Number.isInteger(value) && value > 0 && value <= 365))]
    .sort((left, right) => right - left);
  const time = env.MATURITY_REMINDER_TIME || '09:00';
  const timezone = env.MATURITY_REMINDER_TIMEZONE || 'Asia/Kolkata';
  const [hour, minute] = time.split(':').map(Number);

  if (
    validDays.length === 0
    || validDays.length !== days.length
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    throw new Error('Invalid maturity reminder schedule configuration.');
  }
  new Intl.DateTimeFormat('en-US', { timeZone: timezone });

  const rawOfficials = (env.MATURITY_REMINDER_OFFICIAL_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (rawOfficials.some((value) => !validObjectId(value))) {
    throw new Error('Invalid configured maturity reminder official user ID.');
  }
  const configuredOfficials = rawOfficials.map((value) => new mongoose.Types.ObjectId(value).toString());

  return {
    enabled: env.MATURITY_REMINDERS_ENABLED === 'true',
    time,
    hour,
    minute,
    timezone,
    reminderDays: validDays,
    overdueEnabled: env.MATURITY_OVERDUE_REMINDER_ENABLED !== 'false',
    overdueMaxDays: DEFAULT_OVERDUE_DAYS,
    configuredOfficialUserIds: configuredOfficials,
  };
};

export const getReminderStage = ({ maturityDate, now, timezone, reminderDays, overdueEnabled, overdueMaxDays }) => {
  const maturityKey = dateOnlyKey(maturityDate);
  if (!maturityKey || Number.isNaN(now.getTime())) return null;

  const todayKey = dateKeyInTimeZone(now, timezone);
  const daysUntilMaturity = differenceInDateDays(maturityKey, todayKey);
  if (reminderDays.includes(daysUntilMaturity)) {
    return { type: 'maturity_reminder', stage: `${daysUntilMaturity}d`, daysUntilMaturity, maturityKey };
  }
  if (overdueEnabled && daysUntilMaturity < 0 && Math.abs(daysUntilMaturity) <= overdueMaxDays) {
    return { type: 'overdue_maturity', stage: 'overdue', daysUntilMaturity, maturityKey };
  }
  return null;
};

const getCandidateFilter = ({ todayKey, maxReminderDays, overdueEnabled, overdueMaxDays }) => {
  const earliest = overdueEnabled ? addDaysToDateKey(todayKey, -overdueMaxDays) : todayKey;
  const latest = addDaysToDateKey(todayKey, maxReminderDays);
  return {
    workflowStatus: { $in: reminderEligibleStatuses },
    financialStatus: { $in: ['active', 'matured'] },
    maturityDate: {
      $gte: new Date(`${earliest}T00:00:00.000Z`),
      $lte: new Date(`${latest}T23:59:59.999Z`),
    },
  };
};

const getPage = async (filter, offset) => FDR.find(filter)
  .select('_id institution reviewer fdrNumber maturityDate replacesFdr workflowStatus financialStatus')
  .sort({ maturityDate: 1, _id: 1 })
  .skip(offset)
  .limit(PAGE_SIZE);

const findReplacedIds = async (records) => {
  if (records.length === 0) return new Set();
  const replacements = await FDR.find({
    replacesFdr: { $in: records.map(({ _id }) => _id) },
    workflowStatus: { $in: replacementStatuses },
  }).select('replacesFdr').limit(PAGE_SIZE);
  return new Set(replacements.map(({ replacesFdr }) => String(replacesFdr)));
};

const getRecipientsByInstitution = async ({ records, configuredOfficialUserIds }) => {
  const institutionIds = [...new Set(records.map(({ institution }) => String(institution)).filter(Boolean))];
  const explicitlyAssignedIds = [
    ...configuredOfficialUserIds,
    ...records.map(({ reviewer }) => String(reviewer || '')).filter(validObjectId),
  ];
  const query = {
    isActive: true,
    $or: [
      { institution: { $in: institutionIds }, role: { $in: institutionRoles } },
      ...(explicitlyAssignedIds.length
        ? [{ _id: { $in: explicitlyAssignedIds }, role: { $in: officialRoles } }]
        : []),
    ],
  };
  const users = await User.find(query).select('_id institution role').limit(5000);
  const byInstitution = new Map();
  for (const user of users) {
    if (user.institution && institutionIds.includes(String(user.institution))) {
      const key = String(user.institution);
      if (!byInstitution.has(key)) byInstitution.set(key, []);
      byInstitution.get(key).push(user);
    }
  }
  const explicitlyAssigned = new Map(users.map((user) => [String(user._id), user]));
  return { byInstitution, explicitlyAssigned };
};

const saveReminder = async ({ recipient, record, stage, now }) => {
  const key = `maturity:${recipient._id}:${record._id}:${stage.maturityKey}:${stage.stage}`;
  const dueText = stage.daysUntilMaturity > 0
    ? `matures in ${stage.daysUntilMaturity} days`
    : `matured ${Math.abs(stage.daysUntilMaturity)} days ago`;
  try {
    const result = await Notification.updateOne(
      { deduplicationKey: key },
      {
        $setOnInsert: {
          recipient: recipient._id,
          institution: record.institution,
          fdr: record._id,
          type: stage.type,
          title: stage.type === 'overdue_maturity' ? 'FDR maturity follow-up' : 'FDR maturity reminder',
          message: `FDR ${record.fdrNumber} ${dueText} (${stage.maturityKey}).`,
          metadata: {
            fdrNumber: record.fdrNumber,
            maturityDate: stage.maturityKey,
            reminderStage: stage.stage,
          },
          deduplicationKey: key,
          readAt: null,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
};

export const runMaturityReminderJob = async ({
  now = new Date(),
  config = getMaturityReminderConfig(),
  logger = console,
} = {}) => {
  if (config.enabled === false) return { processed: 0, created: 0, failed: 0, skipped: 0 };

  const todayKey = dateKeyInTimeZone(now, config.timezone);
  const filter = getCandidateFilter({
    todayKey,
    maxReminderDays: Math.max(...config.reminderDays),
    overdueEnabled: config.overdueEnabled,
    overdueMaxDays: config.overdueMaxDays,
  });
  let processed = 0;
  let created = 0;
  let failed = 0;
  let skipped = 0;

  try {
    for (let offset = 0; offset < MAX_RECORDS_PER_RUN; offset += PAGE_SIZE) {
      const records = await getPage(filter, offset);
      if (records.length === 0) break;
      const replacedIds = await findReplacedIds(records);
      const { byInstitution, explicitlyAssigned } = await getRecipientsByInstitution({
        records,
        configuredOfficialUserIds: config.configuredOfficialUserIds,
      });

      for (const record of records) {
        processed += 1;
        try {
          const stage = getReminderStage({
            maturityDate: record.maturityDate,
            now,
            timezone: config.timezone,
            reminderDays: config.reminderDays,
            overdueEnabled: config.overdueEnabled,
            overdueMaxDays: config.overdueMaxDays,
          });
          if (
            !stage
            || !reminderEligibleStatuses.includes(record.workflowStatus)
            || !['active', 'matured'].includes(record.financialStatus)
            || ['released', 'expired'].includes(record.workflowStatus)
            || replacedIds.has(String(record._id))
          ) {
            skipped += 1;
            continue;
          }

          const recipients = new Map(
            (byInstitution.get(String(record.institution)) || []).map((user) => [String(user._id), user]),
          );
          for (const assignedId of [String(record.reviewer || ''), ...config.configuredOfficialUserIds]) {
            const user = explicitlyAssigned.get(assignedId);
            if (user) recipients.set(String(user._id), user);
          }
          for (const recipient of recipients.values()) {
            if (await saveReminder({ recipient, record, stage, now })) created += 1;
          }
        } catch (error) {
          failed += 1;
          logger.error('Maturity reminder record failed:', error.name || 'Error');
        }
      }
      if (records.length < PAGE_SIZE) break;
    }
  } catch (error) {
    failed += 1;
    logger.error('Maturity reminder job query failed:', error.name || 'Error');
  }

  logger.info('Maturity reminder run completed:', { processed, created, skipped, failed });
  return { processed, created, skipped, failed };
};

const getDateTimeParts = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
};

export const getNextReminderRun = (now, { hour, minute, timezone }) => {
  const local = getDateTimeParts(now, timezone);
  let targetDate = `${local.year}-${local.month}-${local.day}`;
  const targetTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const todayRun = zonedLocalTimeToUtc(targetDate, targetTime, timezone);
  if (todayRun > now) return todayRun;
  targetDate = addDaysToDateKey(targetDate, 1);
  return zonedLocalTimeToUtc(targetDate, targetTime, timezone);
};

const zonedLocalTimeToUtc = (dateKey, time, timezone) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const intended = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = intended;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getDateTimeParts(new Date(candidate), timezone);
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    candidate += intended - observed;
  }
  return new Date(candidate);
};

export const startMaturityReminderScheduler = ({ config = getMaturityReminderConfig(), logger = console } = {}) => {
  if (!config.enabled) return () => {};
  let timer;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const delay = Math.max(1000, getNextReminderRun(new Date(), config).getTime() - Date.now());
    timer = setTimeout(async () => {
      await runMaturityReminderJob({ config, logger });
      schedule();
    }, delay);
    timer.unref?.();
  };

  // Startup catch-up evaluates only today's due stages, never backfills stale daily notifications.
  void runMaturityReminderJob({ config, logger }).catch((error) => {
    logger.error('Maturity reminder startup catch-up failed:', error.name || 'Error');
  });
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};
