import FDR from '../models/FDR.js';
import { verifyStoredDocumentIntegrity } from '../services/document-integrity.service.js';

let isJobRunning = false;

export const getIntegrityMonitorConfig = (env = process.env) => {
  const enabled = env.INTEGRITY_MONITOR_ENABLED !== 'false';
  const intervalHours = Math.max(1, parseInt(env.INTEGRITY_MONITOR_INTERVAL_HOURS, 10) || 24);
  return {
    enabled,
    intervalMs: intervalHours * 60 * 60 * 1000,
  };
};

export const runIntegrityMonitorJob = async ({ systemUser = null } = {}) => {
  if (isJobRunning) {
    console.warn('[IntegrityMonitorJob] Job is already running. Skipping concurrent run.');
    return { skipped: true, reason: 'Job already running' };
  }

  isJobRunning = true;
  const startedAt = new Date();
  console.log(`[IntegrityMonitorJob] Starting automated document integrity scan at ${startedAt.toISOString()}...`);

  try {
    const candidates = await FDR.find({
      workflowStatus: { $nin: ['released', 'expired'] },
      financialStatus: { $in: ['active', 'matured'] },
      'documentMetadata.storageRef': { $exists: true, $ne: null },
      'documentMetadata.checksum': { $exists: true, $ne: null },
    })
      .select('_id fdrNumber institution')
      .limit(100);

    let verified = 0;
    let mismatch = 0;
    let unavailable = 0;

    for (const fdr of candidates) {
      try {
        const result = await verifyStoredDocumentIntegrity({
          fdrId: fdr._id,
          user: systemUser || { _id: null, role: 'aicte_admin' },
          trigger: 'scheduled',
        });
        if (result.status === 'verified') verified += 1;
        else if (result.status === 'mismatch') mismatch += 1;
        else unavailable += 1;
      } catch (err) {
        console.error(`[IntegrityMonitorJob] Error verifying FDR ${fdr.fdrNumber}:`, err.message);
        unavailable += 1;
      }
    }

    const durationMs = Date.now() - startedAt.getTime();
    console.log(
      `[IntegrityMonitorJob] Completed in ${durationMs}ms. Scanned: ${candidates.length}, Verified: ${verified}, Mismatch: ${mismatch}, Unavailable: ${unavailable}`,
    );

    return {
      success: true,
      scanned: candidates.length,
      verified,
      mismatch,
      unavailable,
      durationMs,
    };
  } finally {
    isJobRunning = false;
  }
};

export const startIntegrityMonitorScheduler = ({ config } = {}) => {
  const cfg = config || getIntegrityMonitorConfig();
  if (!cfg.enabled) {
    console.log('[IntegrityMonitorScheduler] Automated integrity monitor is disabled.');
    return null;
  }

  console.log(`[IntegrityMonitorScheduler] Scheduling integrity checks every ${cfg.intervalMs / (60 * 60 * 1000)} hours.`);
  const timer = setInterval(() => {
    runIntegrityMonitorJob().catch((err) => {
      console.error('[IntegrityMonitorJob] Uncaught error in scheduled run:', err);
    });
  }, cfg.intervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return timer;
};

