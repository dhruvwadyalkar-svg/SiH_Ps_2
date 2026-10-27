import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

router.get('/', (_request, response) => {
  const databaseStatus = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  response.status(200).json({
    status: 'ok',
    message: 'Backend is running',
    database: {
      status: databaseStatus[mongoose.connection.readyState] || 'unknown',
    },
  });
});

export default router;
