import app from './app.js';
import connectDB from './config/db.js';
import { getMaturityReminderConfig, startMaturityReminderScheduler } from './jobs/maturity-reminder.job.js';

const port = Number(process.env.PORT) || 3000;

const startServer = async () => {
  try {
    await connectDB();

    const reminderConfig = getMaturityReminderConfig();
    if (reminderConfig.enabled) {
      startMaturityReminderScheduler({ config: reminderConfig });
    }

    app.listen(port, () => {
      console.log(`Backend server listening on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start backend:', error.name);
    process.exit(1);
  }
};

startServer();
