import { z } from 'zod';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(12)
  .max(72)
  .refine((password) => Buffer.byteLength(password, 'utf8') <= 72);

const institutionProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    institutionCode: z.string().trim().min(2).max(50),
    contactEmail: emailSchema,
    contactPhone: z.string().trim().min(6).max(30),
    address: z.string().trim().min(5).max(500),
  })
  .strict();

const newInstitutionUserSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const registerInstitutionSchema = z
  .object({
    institution: institutionProfileSchema,
    user: newInstitutionUserSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(72).refine((password) => Buffer.byteLength(password, 'utf8') <= 72),
  })
  .strict();

export const bootstrapAdminSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();
