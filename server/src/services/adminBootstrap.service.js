import bcrypt from 'bcryptjs';
import User from '../models/User.js';

export const provisionInitialAdmin = async (profile) => {
  const existingUser = await User.findOne({ email: profile.email });
  if (existingUser) {
    if (existingUser.role === 'aicte_admin') {
      return 'already-exists';
    }

    throw new Error('The configured administrator email is assigned to another role.');
  }

  const administrator = new User({
    fullName: profile.fullName,
    email: profile.email,
    passwordHash: await bcrypt.hash(profile.password, 12),
    role: 'aicte_admin',
  });
  await administrator.save();
  return 'created';
};
