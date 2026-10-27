import { loginUser, registerInstitution } from '../services/auth.service.js';
import { serializeUser } from '../utils/auth.js';
import { loginSchema, registerInstitutionSchema } from '../utils/auth.validation.js';

const sendValidationError = (response, issues) =>
  response.status(400).json({
    error: 'Invalid request.',
    details: issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  });

const isDuplicateKeyError = (error) => error?.code === 11000;

export const registerInstitutionController = async (request, response, next) => {
  const parsed = registerInstitutionSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendValidationError(response, parsed.error.issues);
  }

  try {
    const result = await registerInstitution(parsed.data);
    return response.status(201).json({
      message: 'Institution registration submitted for review.',
      institution: {
        id: String(result.institution._id),
        name: result.institution.name,
        institutionCode: result.institution.institutionCode,
        status: result.institution.status,
      },
      user: serializeUser(result.user),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return response.status(409).json({
        error: 'An institution code or email is already registered.',
      });
    }

    return next(error);
  }
};

export const loginController = async (request, response, next) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendValidationError(response, parsed.error.issues);
  }

  try {
    const result = await loginUser(parsed.data);
    if (!result) {
      return response.status(401).json({ error: 'Invalid email or password.' });
    }

    return response.status(200).json({
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
    });
  } catch (error) {
    return next(error);
  }
};

export const currentUserController = (request, response) => {
  return response.status(200).json({ user: serializeUser(request.user) });
};
