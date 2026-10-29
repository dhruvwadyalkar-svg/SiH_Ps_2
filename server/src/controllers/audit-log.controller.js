import {
  AuditServiceError,
  exportAuditLogsCsv,
  getAuditLogDetails,
  listAuditLogs,
  verifyAuditChainIntegrity,
} from '../services/audit-log.service.js';
import {
  DocumentIntegrityError,
  getFdrIntegrityHistory,
  investigateIntegrityAlert,
  listIntegrityRecords,
  runBulkIntegrityCheck,
  verifyStoredDocumentIntegrity,
} from '../services/document-integrity.service.js';

export const listAuditLogsController = async (req, res) => {
  try {
    const result = await listAuditLogs({ user: req.user, query: req.query });
    return res.json(result);
  } catch (error) {
    if (error instanceof AuditServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Audit list error:', error);
    return res.status(500).json({ error: 'Failed to retrieve audit trail records.' });
  }
};

export const getAuditLogDetailsController = async (req, res) => {
  try {
    const result = await getAuditLogDetails({ user: req.user, logId: req.params.id });
    return res.json(result);
  } catch (error) {
    if (error instanceof AuditServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Audit details error:', error);
    return res.status(500).json({ error: 'Failed to retrieve audit event details.' });
  }
};

export const verifyAuditChainController = async (req, res) => {
  try {
    const result = await verifyAuditChainIntegrity();
    return res.json(result);
  } catch (error) {
    console.error('Audit chain verification error:', error);
    return res.status(500).json({ error: 'Audit chain verification failed.' });
  }
};

export const exportAuditLogsCsvController = async (req, res) => {
  try {
    const csvContent = await exportAuditLogsCsv({ user: req.user, query: req.query });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="aicte-audit-trail-${Date.now()}.csv"`);
    return res.send(csvContent);
  } catch (error) {
    if (error instanceof AuditServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Audit export error:', error);
    return res.status(500).json({ error: 'Failed to export audit report.' });
  }
};

export const verifyDocumentIntegrityController = async (req, res) => {
  try {
    const result = await verifyStoredDocumentIntegrity({ fdrId: req.params.id, user: req.user });
    return res.json(result);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Document integrity check error:', error);
    return res.status(500).json({ error: 'Document integrity verification failed.' });
  }
};

export const listIntegrityRecordsController = async (req, res) => {
  try {
    const result = await listIntegrityRecords({ user: req.user, query: req.query });
    return res.json(result);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('List integrity records error:', error);
    return res.status(500).json({ error: 'Failed to retrieve integrity monitor records.' });
  }
};

export const getIntegritySummaryController = async (req, res) => {
  try {
    const result = await listIntegrityRecords({ user: req.user, query: { limit: 1 } });
    return res.json(result.summary);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Get integrity summary error:', error);
    return res.status(500).json({ error: 'Failed to retrieve integrity summary.' });
  }
};

export const getFdrIntegrityHistoryController = async (req, res) => {
  try {
    const result = await getFdrIntegrityHistory({ fdrId: req.params.id, user: req.user });
    return res.json(result);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Get integrity history error:', error);
    return res.status(500).json({ error: 'Failed to retrieve integrity history.' });
  }
};

export const investigateIntegrityAlertController = async (req, res) => {
  try {
    const result = await investigateIntegrityAlert({
      fdrId: req.params.id,
      alertId: req.params.alertId,
      user: req.user,
      payload: req.body || {},
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Investigate alert error:', error);
    return res.status(500).json({ error: 'Failed to record alert investigation.' });
  }
};

export const runBulkIntegrityCheckController = async (req, res) => {
  try {
    const result = await runBulkIntegrityCheck({
      user: req.user,
      fdrIds: req.body?.fdrIds,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof DocumentIntegrityError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Bulk integrity check error:', error);
    return res.status(500).json({ error: 'Bulk integrity verification failed.' });
  }
};


