import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const parseExpirySeconds = (value) => {
  const match = /^([1-9]\d*)(s|m|h)$/.exec(value);
  if (!match) {
    throw new Error('JWT_EXPIRES_IN must be a duration such as 15m and no longer than 1h.');
  }

  const amount = Number(match[1]);
  const secondsPerUnit = { s: 1, m: 60, h: 3600 }[match[2]];
  const seconds = amount * secondsPerUnit;

  if (seconds > 3600) {
    throw new Error('JWT_EXPIRES_IN must be no longer than 1h.');
  }

  return seconds;
};

export const getJwtConfig = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters.');
  }

  return {
    secret,
    expiresInSeconds: parseExpirySeconds(process.env.JWT_EXPIRES_IN || '15m'),
  };
};

export const createAccessToken = (user) => {
  const { secret, expiresInSeconds } = getJwtConfig();
  const token = jwt.sign(
    { role: user.role },
    secret,
    {
      algorithm: 'HS256',
      subject: String(user._id),
      expiresIn: expiresInSeconds,
    },
  );

  return { token, expiresInSeconds };
};

export const verifyAccessToken = (token) => {
  const { secret } = getJwtConfig();
  return jwt.verify(token, secret, { algorithms: ['HS256'] });
};

export const serializeUser = (user) => ({
  id: String(user._id),
  fullName: user.fullName,
  email: user.email,
  role: user.role,
  institution: user.institution
    ? {
        id: String(user.institution._id),
        name: user.institution.name,
        institutionCode: user.institution.institutionCode,
        status: user.institution.status,
      }
    : null,
});

export const isValidUserId = (userId) => mongoose.isValidObjectId(userId);
