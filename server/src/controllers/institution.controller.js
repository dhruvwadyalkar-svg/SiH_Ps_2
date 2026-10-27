import {
  getInstitutionForUser,
  getInstitutionReviewDetails,
  InstitutionServiceError,
  listInstitutions,
  reviewInstitutionStatus,
  serializeInstitution,
  updateInstitutionProfile,
} from '../services/institution.service.js';
import {
  institutionIdSchema,
  institutionListQuerySchema,
  institutionProfileUpdateSchema,
  institutionStatusUpdateSchema,
} from '../utils/institution.validation.js';

const sendValidationError = (response, issues) =>
  response.status(400).json({
    error: 'Invalid request.',
    details: issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });

const sendServiceError = (response, error) => {
  if (error instanceof InstitutionServiceError) {
    return response.status(error.status).json({ error: error.message });
  }

  return null;
};

const getOwnInstitutionId = (request) => {
  const association = request.user.institution;
  if (!association) {
    return null;
  }
  return typeof association === 'object' ? association._id : association;
};

export const getOwnInstitutionController = async (request, response, next) => {
  try {
    const institution = await getInstitutionForUser(getOwnInstitutionId(request));
    return response.status(200).json({ institution: serializeInstitution(institution) });
  } catch (error) {
    if (sendServiceError(response, error)) return;
    return next(error);
  }
};

export const updateOwnInstitutionController = async (request, response, next) => {
  const parsed = institutionProfileUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendValidationError(response, parsed.error.issues);
  }

  const institutionId = getOwnInstitutionId(request);
  if (!institutionId) {
    return response.status(404).json({ error: 'No institution is associated with this user.' });
  }

  try {
    const institution = await updateInstitutionProfile(institutionId, parsed.data, request.user._id);
    return response.status(200).json({ institution: serializeInstitution(institution) });
  } catch (error) {
    if (sendServiceError(response, error)) return;
    return next(error);
  }
};

export const listInstitutionsController = async (request, response, next) => {
  const parsed = institutionListQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return sendValidationError(response, parsed.error.issues);
  }

  try {
    return response.status(200).json(await listInstitutions(parsed.data));
  } catch (error) {
    return next(error);
  }
};

export const getInstitutionReviewDetailsController = async (request, response, next) => {
  const parsedId = institutionIdSchema.safeParse(request.params.institutionId);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid institution ID.' });
  }

  try {
    return response.status(200).json(await getInstitutionReviewDetails(parsedId.data));
  } catch (error) {
    if (sendServiceError(response, error)) return;
    return next(error);
  }
};

export const reviewInstitutionStatusController = async (request, response, next) => {
  const parsedId = institutionIdSchema.safeParse(request.params.institutionId);
  if (!parsedId.success) {
    return response.status(400).json({ error: 'Invalid institution ID.' });
  }

  const parsedBody = institutionStatusUpdateSchema.safeParse(request.body);
  if (!parsedBody.success) {
    return sendValidationError(response, parsedBody.error.issues);
  }

  try {
    const institution = await reviewInstitutionStatus(
      parsedId.data,
      parsedBody.data,
      request.user,
    );
    return response.status(200).json({ institution: serializeInstitution(institution) });
  } catch (error) {
    if (sendServiceError(response, error)) return;
    return next(error);
  }
};
