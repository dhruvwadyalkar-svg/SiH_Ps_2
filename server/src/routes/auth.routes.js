import { rateLimit } from 'express-rate-limit';
import { Router } from 'express';
import {
  currentUserController,
  loginController,
  registerInstitutionController,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again later.' },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again later.' },
});

router.post('/register-institution', registrationLimiter, registerInstitutionController);
router.post('/login', loginLimiter, loginController);
router.get('/me', authenticate, currentUserController);

export default router;
