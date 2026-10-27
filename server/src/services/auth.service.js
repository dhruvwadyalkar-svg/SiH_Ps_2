import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Institution from '../models/Institution.js';
import User from '../models/User.js';
import { createAccessToken, serializeUser } from '../utils/auth.js';

const passwordHashCost = 12;

export const registerInstitution = async ({ institution: profile, user: userProfile }) => {
  const passwordHash = await bcrypt.hash(userProfile.password, passwordHashCost);
  const session = await mongoose.startSession();
  let createdInstitution;
  let createdUser;

  try {
    await session.withTransaction(async () => {
      const institution = new Institution({
        ...profile,
        institutionCode: profile.institutionCode.toUpperCase(),
        status: 'pending',
      });
      await institution.save({ session });

      const user = new User({
        fullName: userProfile.fullName,
        email: userProfile.email,
        passwordHash,
        role: 'institution_user',
        institution: institution._id,
      });
      await user.save({ session });

      createdInstitution = institution;
      createdUser = user;
    });
  } finally {
    await session.endSession();
  }

  return { institution: createdInstitution, user: createdUser };
};

export const loginUser = async ({ email, password }) => {
  const user = await User.findOne({ email })
    .select('+passwordHash')
    .populate('institution', 'name institutionCode status');
  if (!user || !user.isActive) {
    return null;
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return null;
  }

  const { token, expiresInSeconds } = createAccessToken(user);
  return {
    accessToken: token,
    expiresIn: expiresInSeconds,
    user: serializeUser(user),
  };
};

export const loadCurrentUser = async (id) => {
  return User.findById(id)
    .select('fullName email role institution isActive')
    .populate('institution', 'name institutionCode status');
};
