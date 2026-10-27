import { z } from 'zod';

const allowedWorkflowStatuses = ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'expired', 'released'];

const isValidDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    return false;
  }

  const datePart = value.slice(0, 10);
  return new Date(`${datePart}T00:00:00.000Z`).toISOString().slice(0, 10) === datePart;
};

const dateStringSchema = z
  .string()
  .trim()
  .refine(isValidDate, { message: 'A valid ISO date or date-time is required.' })
  .transform((value) => new Date(value));

const fdrNumberSchema = z.string().trim().min(3).max(100).transform((value) => value.toUpperCase());
const bankNameSchema = z.string().trim().min(2).max(200);
const branchSchema = z.string().trim().min(2).max(200);
const amountSchema = z.coerce.number().finite().positive();
const currencySchema = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
    z.string().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter code.'),
  )
  .default('INR');

export const fdrCreateSchema = z
  .object({
    fdrNumber: fdrNumberSchema,
    bankName: bankNameSchema,
    branch: branchSchema,
    amount: amountSchema,
    currency: currencySchema,
    issueDate: dateStringSchema,
    maturityDate: dateStringSchema,
  })
  .strict()
  .refine((value) => value.maturityDate > value.issueDate, {
    path: ['maturityDate'],
    message: 'Maturity date must be later than issue date.',
  });

export const updateFdrSchema = z
  .object({
    fdrNumber: fdrNumberSchema.optional(),
    bankName: bankNameSchema.optional(),
    branch: branchSchema.optional(),
    amount: amountSchema.optional(),
    currency: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
      z.string().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter code.'),
    ).optional(),
    issueDate: dateStringSchema.optional(),
    maturityDate: dateStringSchema.optional(),
    workflowStatus: z.literal('submitted').optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one allowed update field.',
  });

export const listFdrQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    workflowStatus: z.enum(allowedWorkflowStatuses).optional(),
    fromDate: dateStringSchema.optional(),
    toDate: dateStringSchema.optional(),
  })
  .strict()
  .refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, {
    path: ['toDate'],
    message: 'toDate must be on or after fromDate.',
  });

export const fdrIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid FDR ID.');
