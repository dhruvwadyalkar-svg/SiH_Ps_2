import {
  BankConfirmationServiceError,
  checkDeadlinesAndEscalate,
  createBankConfirmationRequest,
  downloadConfirmationEvidence,
  getBankConfirmationRequestById,
  getBankConfirmationSummary,
  listBankConfirmationRequests,
  recordBankResponse,
  recordBankSubmission,
  updateConfirmationStatus,
  uploadConfirmationEvidence,
} from '../services/bank-confirmation.service.js';

export const createBankConfirmationController = async (req, res) => {
  try {
    const fdrId = req.body.fdrId || req.body.fdr;
    if (!fdrId) {
      return res.status(400).json({ error: 'fdrId is required.' });
    }

    const confirmationRequest = await createBankConfirmationRequest({
      fdrId,
      user: req.user,
      payload: req.body,
      file: req.file,
    });

    return res.status(201).json({ confirmationRequest });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to create bank confirmation request.' });
  }
};

export const listBankConfirmationsController = async (req, res) => {
  try {
    const result = await listBankConfirmationRequests({
      user: req.user,
      query: req.query,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to list bank confirmation requests.' });
  }
};

export const getBankConfirmationSummaryController = async (req, res) => {
  try {
    const summary = await getBankConfirmationSummary({ user: req.user });
    return res.json({ summary });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to fetch bank confirmation summary.' });
  }
};

export const getBankConfirmationByIdController = async (req, res) => {
  try {
    const confirmationRequest = await getBankConfirmationRequestById({
      id: req.params.id,
      user: req.user,
    });
    return res.json({ confirmationRequest });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to retrieve bank confirmation request.' });
  }
};

export const updateConfirmationStatusController = async (req, res) => {
  try {
    const confirmationRequest = await updateConfirmationStatus({
      id: req.params.id,
      user: req.user,
      payload: req.body,
    });
    return res.json({ confirmationRequest });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to update confirmation status.' });
  }
};

export const recordBankSubmissionController = async (req, res) => {
  try {
    const confirmationRequest = await recordBankSubmission({
      id: req.params.id,
      user: req.user,
      payload: req.body,
      file: req.file,
    });
    return res.json({ confirmationRequest });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to record bank submission.' });
  }
};

export const recordBankResponseController = async (req, res) => {
  try {
    let discrepancies = req.body.discrepancies;
    if (typeof discrepancies === 'string') {
      try {
        discrepancies = JSON.parse(discrepancies);
      } catch {
        discrepancies = {};
      }
    }

    const confirmationRequest = await recordBankResponse({
      id: req.params.id,
      user: req.user,
      payload: { ...req.body, discrepancies },
      file: req.file,
    });
    return res.json({ confirmationRequest });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to record bank response.' });
  }
};

export const uploadConfirmationEvidenceController = async (req, res) => {
  try {
    const evidenceDocument = await uploadConfirmationEvidence({
      id: req.params.id,
      user: req.user,
      file: req.file,
      documentType: req.body.documentType,
    });
    return res.status(201).json({ evidenceDocument });
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to upload evidence document.' });
  }
};

export const downloadConfirmationEvidenceController = async (req, res) => {
  try {
    const { buffer, fileName, mimeType } = await downloadConfirmationEvidence({
      id: req.params.id,
      docId: req.params.docId,
      user: req.user,
    });

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    return res.send(buffer);
  } catch (error) {
    if (error instanceof BankConfirmationServiceError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error.message || 'Failed to download evidence document.' });
  }
};

export const checkDeadlinesController = async (req, res) => {
  try {
    const result = await checkDeadlinesAndEscalate();
    return res.json({ message: 'Deadline monitor scan completed.', ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to check deadlines.' });
  }
};

