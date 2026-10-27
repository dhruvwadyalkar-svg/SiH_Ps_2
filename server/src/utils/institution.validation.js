import Institution from '../models/Institution.js';
import { z } from 'zod';

export const institutionStatuses = Institution.schema.path('status').enumValues;

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z.string().trim().min(6).max(30);
const addressSchema = z.string().trim().min(5).max(500);
const nameSchema = z.string().trim().min(2).max(150);

export const institutionProfileUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    contactEmail: emailSchema.optional(),
    contactPhone: phoneSchema.optional(),
    address: addressSchema.optional(),
  })
  .strict()
  .refine((profile) => Object.keys(profile).length > 0, {
    message: 'Provide at least one permitted profile field.',
  });

export const institutionListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    status: z.enum(institutionStatuses).optional(),
  })
  .strict();

export const institutionIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const institutionStatusUpdateSchema = z
  .object({
    status: z.enum(institutionStatuses),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
