import { z } from 'zod';
import { fdrCreateSchema, fdrIdSchema } from './fdr.validation.js';

const page = z.coerce.number().int().min(1).max(10000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(20);
const reason = z.string().trim().min(5).max(2000);

export const reviewQueueQuerySchema = z
  .object({
    page,
    limit,
    workflowStatus: z.enum([
      'draft',
      'submitted',
      'under_review',
      'correction_requested',
      'review_completed',
      'approved',
      'rejected',
      'expired',
      'released',
    ]).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical', 'Low', 'Medium', 'High', 'Critical']).optional(),
    bank: z.string().trim().min(1).max(100).optional(),
    sortBy: z.enum(['risk_desc', 'risk_asc', 'urgency', 'date_desc', 'date_asc']).optional(),
  })
  .strict();

export const riskFindingReviewSchema = z
  .object({
    status: z.enum(['dismissed', 'reviewed', 'active']),
    reviewReason: z.string().trim().min(5).max(2000),
  })
  .strict();

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(['request_correction', 'reject_submission', 'complete_review']),
    reason,
  })
  .strict();

export const renewalSchema = fdrCreateSchema;

export const releaseRequestSchema = z
  .object({ reason })
  .strict();

export const releaseDecisionSchema = z
  .object({
    decision: z.enum(['request_information', 'approve_request', 'reject_request']),
    reason,
  })
  .strict();

export const releaseQueueQuerySchema = z
  .object({
    page,
    limit,
    status: z.enum(['submitted', 'information_requested', 'approved', 'rejected']).optional(),
  })
  .strict();

export const workflowFdrIdSchema = fdrIdSchema;
