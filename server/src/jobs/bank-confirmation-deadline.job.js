import { checkDeadlinesAndEscalate } from '../services/bank-confirmation.service.js';

let isJobRunning = false;

export const getConfirmationDeadlineConfig = (env = process.env) => {
  const enabled = env.CONFIRMATION_DEADLINE_JOB_ENABLED !== 'false';
  const intervalHours = Math.max(1, parseInt(env.CONFIRMATION_DEADLINE_INTERVAL_HOURS, 10) || 1);
  return {
    enabled,
    intervalMs: intervalHours * 60 * 60 * 1000,
  };
};

export const runBankConfirmationDeadlineJob = async () => {
  if (isJobRunning) {
    console.warn('[BankConfirmationDeadlineJob] Job already running. Skipping.');
    return { skipped: true, reason: 'Job already running' };
  }

  isJobRunning = true;
  const startedAt = new Date();
  console.log(`[BankConfirmationDeadlineJob] Starting deadline check at ${startedAt.toISOString()}...`);

  try {
    const result = await checkDeadlinesAndEscalate({ now: startedAt });
    const durationMs = Date.now() - startedAt.getTime();
    console.log(
      `[BankConfirmationDeadlineJob] Finished in ${durationMs}ms. Processed: ${result.processedCount}, Upcoming warnings: ${result.upcomingWarnings}, Escalated overdue: ${result.escalatedOverdue}`,
    );
    return { success: true, ...result, durationMs };
  } catch (err) {
    console.error('[BankConfirmationDeadlineJob] Error checking confirmation deadlines:', err.message);
    return { success: false, error: err.message };
  } finally {
    isJobRunning = false;
  }
};

export const startConfirmationDeadlineScheduler = (env = process.env) => {
  const config = getConfirmationDeadlineConfig(env);
  if (!config.enabled) {
    console.log('[BankConfirmationDeadlineJob] Scheduled deadline monitor is disabled via configuration.');
    return null;
  }

  const initialDelayMs = 15000;
  const initialTimeout = setTimeout(() => {
    runBankConfirmationDeadlineJob().catch(() => {});
  }, initialDelayMs);

  const intervalId = setInterval(() => {
    runBankConfirmationDeadlineJob().catch(() => {});
  }, config.intervalMs);

  return {
    stop: () => {
      clearTimeout(initialTimeout);
      clearInterval(intervalId);
    },
  };
};

export default {
  getConfirmationDeadlineConfig,
  runBankConfirmationDeadlineJob,
  startConfirmationDeadlineScheduler,
};

