import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import authRoutes from './routes/auth.routes.js';
import fdrRoutes from './routes/fdr.routes.js';
import adminFdrRoutes from './routes/admin-fdr.routes.js';
import healthRoutes from './routes/health.routes.js';
import institutionRoutes, { adminInstitutionRouter } from './routes/institution.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import bankConfirmationRoutes from './routes/bank-confirmation.routes.js';

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  const envOrigin = process.env.FRONTEND_ORIGIN;
  if (!envOrigin || envOrigin.trim() === '*' || envOrigin.trim() === '') return true;
  const origins = envOrigin.split(',').map((o) => o.trim().toLowerCase());
  const lowerOrigin = origin.toLowerCase();
  return (
    origins.includes('*') ||
    origins.includes(lowerOrigin) ||
    lowerOrigin.endsWith('.vercel.app') ||
    lowerOrigin.includes('localhost')
  );
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }),
);
app.use(express.json({ limit: '100kb' }));

app.get('/', (_req, res) => res.json({ status: 'ok', message: 'AICTE FDR Portal Backend API is running.', healthEndpoint: '/api/health' }));
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/institutions', institutionRoutes);
app.use('/api/fdrs', fdrRoutes);
app.use('/api/bank-confirmations', bankConfirmationRoutes);
app.use('/api/admin', adminFdrRoutes);
app.use('/api/admin/institutions', adminInstitutionRouter);

app.use((error, _request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Invalid JSON request body.' });
  }

  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body is too large.' });
  }

  if (error.name === 'MulterError') {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Uploaded document exceeds the configured size limit.'
      : 'Invalid document upload request.';
    return response.status(status).json({ error: message });
  }

  console.error('Request failed:', error.name || 'Error');
  return response.status(500).json({ error: 'Internal server error.' });
});

export default app;
