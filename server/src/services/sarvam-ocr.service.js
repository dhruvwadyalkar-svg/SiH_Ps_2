import { createHash } from 'node:crypto';
import { SarvamAIClient } from 'sarvamai';
import { fdrExtractionSchemaJson } from '../utils/fdr-extraction.schema.js';

const apiBaseUrl = 'https://api.sarvam.ai/doc-ai/v1/job';
const requestTimeoutMs = 30_000;
const maxExtractAttempts = 3;
const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const terminalStatuses = new Set(['completed', 'partially_completed', 'failed', 'rejected']);
const testJobPrefix = 'phase11-synthetic:';

const isDeterministicTestProviderEnabled = () =>
  process.env.NODE_ENV === 'test' && process.env.SARVAM_TEST_MODE === 'true';

export class SarvamOcrError extends Error {
  constructor(errorCode, status, message) {
    super(message);
    this.errorCode = errorCode;
    this.status = status;
  }
}

const getApiKey = () => {
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  if (!apiKey) {
    throw new SarvamOcrError('not_configured', 503, 'OCR service is not configured.');
  }
  return apiKey;
};

const getClient = () =>
  new SarvamAIClient({
    apiSubscriptionKey: getApiKey(),
    timeoutInSeconds: requestTimeoutMs / 1000,
    maxRetries: 2,
  });

const delay = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const providerErrorForStatus = (status) => {
  if (status === 401 || status === 403) {
    return new SarvamOcrError('invalid_api_key', 503, 'OCR provider authentication failed.');
  }
  if (status === 429) {
    return new SarvamOcrError('rate_limited', 503, 'OCR provider is temporarily rate-limited.');
  }
  if (status === 413) {
    return new SarvamOcrError('document_too_large', 422, 'The document exceeds Sarvam Document AI limits.');
  }
  if (status === 400) {
    return new SarvamOcrError('document_rejected', 422, 'Sarvam could not accept this document for extraction.');
  }
  if (status >= 500) {
    return new SarvamOcrError('provider_unavailable', 503, 'OCR provider is temporarily unavailable.');
  }
  return new SarvamOcrError('provider_error', 502, 'OCR provider request failed.');
};

const providerErrorForException = (error) => {
  if (error instanceof SarvamOcrError) {
    return error;
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') {
    return new SarvamOcrError('provider_timeout', 504, 'OCR provider request timed out.');
  }
  if (Number.isInteger(error?.statusCode)) {
    return providerErrorForStatus(error.statusCode);
  }
  return new SarvamOcrError('provider_unavailable', 503, 'OCR provider is temporarily unavailable.');
};

const createExtractRequest = ({ document, fileName, mimeType }) => {
  const formData = new FormData();
  formData.append('file', new Blob([document], { type: mimeType }), fileName);
  formData.append('schema', fdrExtractionSchemaJson);
  formData.append('language', 'en-IN');
  formData.append('output_format', 'json');
  return formData;
};

const parseJobResponse = (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.job_id !== 'string' ||
    value.job_id.length === 0 ||
    typeof value.status !== 'string'
  ) {
    throw new SarvamOcrError('malformed_response', 502, 'OCR provider returned an invalid job response.');
  }

  const status = value.status.toLowerCase();
  if (!['pending', 'queued', 'running', 'processing', 'in_progress', ...terminalStatuses].includes(status)) {
    throw new SarvamOcrError('malformed_response', 502, 'OCR provider returned an unsupported job status.');
  }

  return { jobId: value.job_id, status };
};

const submitExtraction = async ({ document, fileName, mimeType }) => {
  if (isDeterministicTestProviderEnabled()) {
    const digest = createHash('sha256').update(document).digest('hex').slice(0, 24);
    return { jobId: `${testJobPrefix}${digest}`, status: 'queued' };
  }

  const apiKey = getApiKey();
  let lastError;

  for (let attempt = 0; attempt < maxExtractAttempts; attempt += 1) {
    try {
      const response = await fetch(`${apiBaseUrl}/extract`, {
        method: 'POST',
        headers: { 'api-subscription-key': apiKey },
        body: createExtractRequest({ document, fileName, mimeType }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (!response.ok) {
        if (retryableStatuses.has(response.status) && attempt < maxExtractAttempts - 1) {
          await delay(250 * (attempt + 1));
          continue;
        }
        throw providerErrorForStatus(response.status);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new SarvamOcrError('malformed_response', 502, 'OCR provider returned an invalid job response.');
      }
      return parseJobResponse(payload);
    } catch (error) {
      lastError = providerErrorForException(error);
      if (lastError.errorCode === 'provider_timeout' && attempt < maxExtractAttempts - 1) {
        await delay(250 * (attempt + 1));
        continue;
      }
      if (lastError.errorCode === 'provider_unavailable' && attempt < maxExtractAttempts - 1) {
        await delay(250 * (attempt + 1));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new SarvamOcrError('provider_unavailable', 503, 'OCR provider is temporarily unavailable.');
};

const getJobStatus = async (jobId) => {
  if (isDeterministicTestProviderEnabled() && jobId.startsWith(testJobPrefix)) {
    return { status: 'completed' };
  }

  let response;
  try {
    response = await getClient().docAi.getStatus(jobId, {
      timeoutInSeconds: requestTimeoutMs / 1000,
      maxRetries: 2,
    });
  } catch (error) {
    throw providerErrorForException(error);
  }

  if (
    !response ||
    typeof response.job_id !== 'string' ||
    response.job_id !== jobId ||
    typeof response.status !== 'string'
  ) {
    throw new SarvamOcrError('malformed_response', 502, 'OCR provider returned an invalid status response.');
  }

  const status = response.status.toLowerCase();
  if (!['pending', 'queued', 'running', 'processing', 'in_progress', ...terminalStatuses].includes(status)) {
    throw new SarvamOcrError('malformed_response', 502, 'OCR provider returned an unsupported job status.');
  }
  return { status };
};

const getJobResults = async (jobId) => {
  if (isDeterministicTestProviderEnabled() && jobId.startsWith(testJobPrefix)) {
    return {
      fdr_number: 'SYNTHETIC-E2E-FDR',
      bank_name: 'Synthetic Test Bank',
      branch_name: 'Synthetic Test Branch',
      deposit_amount: 250000,
      currency: 'INR',
      issue_date: '2026-01-01',
      maturity_date: '2027-01-01',
      institution_name: 'Synthetic Test Institution',
    };
  }

  let response;
  try {
    response = await getClient().docAi.getResults(jobId, { format: 'json' }, {
      timeoutInSeconds: requestTimeoutMs / 1000,
      maxRetries: 2,
    });
  } catch (error) {
    throw providerErrorForException(error);
  }

  if (!response || response.type !== 'extract' || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
    throw new SarvamOcrError('malformed_response', 502, 'OCR provider returned invalid extraction results.');
  }
  return response.result;
};

export const sarvamOcrService = {
  submitExtraction,
  getJobStatus,
  getJobResults,
};
