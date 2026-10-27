import { z } from 'zod';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID.');
const pageSchema = z.coerce.number().int().min(1).max(10000).default(1);

export const notificationListQuerySchema = z.object({
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z.enum(['true', 'false']).transform((value) => value === 'true').default('false'),
}).strict();

export const notificationIdSchema = objectIdSchema;

const workflowStatuses = [
  'draft',
  'submitted',
  'under_review',
  'correction_requested',
  'review_completed',
  'approved',
  'rejected',
  'expired',
  'released',
];

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

export const reportQuerySchema = z.object({
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  workflowStatus: z.enum(workflowStatuses).optional(),
  maturityFrom: dateSchema.optional(),
  maturityTo: dateSchema.optional(),
  institutionId: objectIdSchema.optional(),
}).strict().refine(
  (value) => !value.maturityFrom || !value.maturityTo || value.maturityFrom <= value.maturityTo,
  { path: ['maturityTo'], message: 'maturityTo must be on or after maturityFrom.' },
);

export const reportExportQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  workflowStatus: z.enum(workflowStatuses).optional(),
  maturityFrom: dateSchema.optional(),
  maturityTo: dateSchema.optional(),
  institutionId: objectIdSchema.optional(),
}).strict().refine(
  (value) => !value.maturityFrom || !value.maturityTo || value.maturityFrom <= value.maturityTo,
  { path: ['maturityTo'], message: 'maturityTo must be on or after maturityFrom.' },
);
