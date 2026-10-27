import mongoose from 'mongoose';

let dbStatus = 'disconnected';

export const getDbStatus = () => dbStatus;

export const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('MONGODB_URI is not defined. Add it to your environment before starting the backend.');
  }

  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    dbStatus = 'connected';
    console.log(
      `MongoDB connected successfully to database "${mongoose.connection.name}" on host "${mongoose.connection.host}"`,
    );
  });

  mongoose.connection.on('error', (error) => {
    dbStatus = 'error';
    console.error('MongoDB connection error:', error.name);
  });

  mongoose.connection.on('disconnected', () => {
    dbStatus = 'disconnected';
    console.warn('MongoDB disconnected');
  });

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
      autoIndex: true,
    });

    dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    return mongoose.connection;
  } catch (error) {
    dbStatus = 'error';
    console.error('Failed to connect to MongoDB:', error.name);
    throw error;
  }
};

export default connectDB;
