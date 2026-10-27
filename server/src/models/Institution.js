import mongoose from 'mongoose';

const institutionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    institutionCode: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      uppercase: true,
    },
    contactEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid contact email.'],
    },
    contactPhone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'pending', 'suspended'],
      default: 'pending',
    },
  },
  { timestamps: true },
);

const Institution = mongoose.model('Institution', institutionSchema);

export default Institution;
