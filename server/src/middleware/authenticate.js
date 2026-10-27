import jwt from 'jsonwebtoken';
import { loadCurrentUser } from '../services/auth.service.js';
import { isValidUserId, verifyAccessToken } from '../utils/auth.js';

const { JsonWebTokenError } = jwt;

const unauthorized = (response) => response.status(401).json({ error: 'Authentication required.' });

const getBearerToken = (header) => {
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] || null;
};

export const authenticate = async (request, response, next) => {
  const token = getBearerToken(request.get('authorization'));
  if (!token) {
    return unauthorized(response);
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof JsonWebTokenError) {
      return unauthorized(response);
    }

    return next(error);
  }

  if (typeof claims === 'string' || !isValidUserId(claims.sub)) {
    return unauthorized(response);
  }

  try {
    const user = await loadCurrentUser(claims.sub);
    if (!user || !user.isActive) {
      return unauthorized(response);
    }

    request.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
};
