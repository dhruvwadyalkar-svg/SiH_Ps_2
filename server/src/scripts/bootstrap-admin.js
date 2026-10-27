import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import { provisionInitialAdmin } from '../services/adminBootstrap.service.js';
import { bootstrapAdminSchema } from '../utils/auth.validation.js';

const requiredEnvironment = {
  fullName: process.env.ADMIN_NAME,
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
};

const parsed = bootstrapAdminSchema.safeParse(requiredEnvironment);
if (!parsed.success) {
  console.error('Bootstrap refused: set valid ADMIN_NAME, ADMIN_EMAIL, and ADMIN_PASSWORD values.');
  process.exitCode = 1;
} else {
  try {
    await connectDB();

    const result = await provisionInitialAdmin(parsed.data);
    if (result === 'already-exists') {
      console.log('AICTE administrator already exists; no changes were made.');
    } else {
      console.log('Initial AICTE administrator created.');
    }
  } catch (error) {
    if (error?.code === 11000) {
      console.error('Bootstrap refused: the configured email is already in use.');
    } else if (error?.message === 'The configured administrator email is assigned to another role.') {
      console.error('Bootstrap refused: the configured email is already assigned to another role.');
    } else {
      console.error('Administrator bootstrap failed. Check the database and environment configuration.');
    }
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
