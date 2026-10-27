import { fdrCreateSchema, fdrIdSchema } from '../utils/fdr.validation.js';
import {
  releaseDecisionSchema,
  releaseQueueQuerySchema,
  releaseRequestSchema,
  reviewDecisionSchema,
  reviewQueueQuerySchema,
} from '../utils/fdr-workflow.validation.js';
import {
  createFdrRenewal,
  createReleaseRequest,
  decideFdrReview,
  decideReleaseRequest,
  FdrWorkflowError,
  getFdrReviewDetails,
  getReleaseRequest,
  listFdrReviewQueue,
  listReleaseRequests,
} from '../services/fdr-workflow.service.js';
import { FdrServiceError } from '../services/fdr.service.js';

const validationError = (response, error) =>
  response.status(400).json({
    error: 'Invalid request.',
    details: error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });

const handleError = (response, error) => {
  if (error instanceof FdrWorkflowError) {
    return response.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof FdrServiceError) {
    return response.status(error.status).json({ error: error.message });
  }
  return null;
};

export const getFdrReviewQueueController = async (request, response, next) => {
  const parsed = reviewQueueQuerySchema.safeParse(request.query);
  if (!parsed.success) return validationError(response, parsed.error);
  try {
    return response.status(200).json(await listFdrReviewQueue({ user: request.user, query: parsed.data }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const getFdrReviewDetailsController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid FDR ID.' });
  try {
    return response.status(200).json(await getFdrReviewDetails({ user: request.user, fdrId: parsedId.data }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const decideFdrReviewController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid FDR ID.' });
  const parsedBody = reviewDecisionSchema.safeParse(request.body);
  if (!parsedBody.success) return validationError(response, parsedBody.error);
  try {
    return response.status(200).json(await decideFdrReview({
      user: request.user,
      fdrId: parsedId.data,
      ...parsedBody.data,
    }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const createFdrRenewalController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid FDR ID.' });
  if (!request.file) return response.status(400).json({ error: 'A replacement PDF, JPEG, or PNG document is required.' });
  const parsedBody = fdrCreateSchema.safeParse(request.body);
  if (!parsedBody.success) return validationError(response, parsedBody.error);
  try {
    return response.status(201).json(await createFdrRenewal({
      user: request.user,
      fdrId: parsedId.data,
      payload: parsedBody.data,
      file: request.file,
    }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const createReleaseRequestController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.id);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid FDR ID.' });
  const parsedBody = releaseRequestSchema.safeParse(request.body);
  if (!parsedBody.success) return validationError(response, parsedBody.error);
  try {
    return response.status(201).json({
      request: await createReleaseRequest({
        user: request.user,
        fdrId: parsedId.data,
        ...parsedBody.data,
      }),
    });
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const listReleaseRequestsController = async (request, response, next) => {
  const parsed = releaseQueueQuerySchema.safeParse(request.query);
  if (!parsed.success) return validationError(response, parsed.error);
  try {
    return response.status(200).json(await listReleaseRequests({ user: request.user, query: parsed.data }));
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const getReleaseRequestController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.requestId);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid release request ID.' });
  try {
    return response.status(200).json({ request: await getReleaseRequest({ user: request.user, requestId: parsedId.data }) });
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};

export const decideReleaseRequestController = async (request, response, next) => {
  const parsedId = fdrIdSchema.safeParse(request.params.requestId);
  if (!parsedId.success) return response.status(400).json({ error: 'Invalid release request ID.' });
  const parsedBody = releaseDecisionSchema.safeParse(request.body);
  if (!parsedBody.success) return validationError(response, parsedBody.error);
  try {
    return response.status(200).json({
      request: await decideReleaseRequest({
        user: request.user,
        requestId: parsedId.data,
        ...parsedBody.data,
      }),
    });
  } catch (error) {
    if (handleError(response, error)) return;
    return next(error);
  }
};
