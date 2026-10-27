import { z } from 'zod';

export const fdrExtractionSchema = {
  type: 'object',
  properties: {
    fdr_number: {
      type: 'string',
      description: 'Fixed Deposit Receipt reference number printed on the document. Return it as printed, without guessing unreadable characters.',
    },
    bank_name: {
      type: 'string',
      description: 'Issuing bank name printed on the receipt. Do not infer the bank from a logo or unrelated text.',
    },
    branch_name: {
      type: 'string',
      description: 'Issuing branch name or identifier printed on the receipt, if present.',
    },
    deposit_amount: {
      type: 'number',
      description: 'Numeric principal deposit amount printed on the receipt, excluding interest and other totals.',
    },
    currency: {
      type: 'string',
      description: 'Currency code for the principal deposit amount, such as INR, only when supported by the document.',
    },
    issue_date: {
      type: 'string',
      description: 'Receipt issue date printed on the document, formatted as YYYY-MM-DD. Omit if absent or unreadable.',
    },
    maturity_date: {
      type: 'string',
      description: 'Deposit maturity date printed on the document, formatted as YYYY-MM-DD. Omit if absent or unreadable.',
    },
    institution_name: {
      type: 'string',
      description: 'Institution or depositor name explicitly printed on the receipt. Do not infer it from the document owner.',
    },
  },
};

export const fdrExtractionSchemaJson = JSON.stringify(fdrExtractionSchema);

const nullableText = z.string().trim().nullable().optional();
const extractedAmount = z
  .preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.union([
      z.number().finite(),
      z.string().trim().regex(/^\d+(?:,\d{3})*(?:\.\d+)?$/).transform((value) => Number(value.replaceAll(',', ''))),
      z.null(),
    ]),
  )
  .optional()
  .refine((value) => value === undefined || value === null || (Number.isFinite(value) && value >= 0));
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  })
  .nullable()
  .optional();

const extractedFieldsSchema = z.object({
  fdr_number: nullableText,
  bank_name: nullableText,
  branch_name: nullableText,
  deposit_amount: extractedAmount,
  currency: nullableText,
  issue_date: isoDate,
  maturity_date: isoDate,
  institution_name: nullableText,
});

export const parseExtractedFdrFields = (value) => {
  const parsed = extractedFieldsSchema.safeParse(value);
  if (!parsed.success) {
    return { success: false };
  }

  const fields = Object.fromEntries(
    Object.entries(parsed.data).map(([field, fieldValue]) => [
      field,
      typeof fieldValue === 'string' && fieldValue.length === 0 ? null : fieldValue ?? null,
    ]),
  );

  return { success: true, data: fields };
};

const textValue = (value) => (typeof value === 'string' && value.trim() ? value : null);
const normalizedText = (value) =>
  textValue(value)?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN') || null;
const normalizedFdrNumber = (value) =>
  textValue(value)?.normalize('NFKC').trim().replace(/\s+/g, '').toLocaleUpperCase('en-IN') || null;
const normalizedDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const compareValue = (submitted, extracted, normalize) => {
  const normalizedExtracted = normalize(extracted);
  if (normalizedExtracted === null) {
    return 'missing_or_unreadable';
  }

  const normalizedSubmitted = normalize(submitted);
  if (normalizedSubmitted === null) {
    return 'not_comparable';
  }

  return normalizedSubmitted === normalizedExtracted ? 'match' : 'mismatch';
};

export const compareFdrFields = ({ submitted, extracted, institutionName }) => ({
  fdr_number: {
    status: compareValue(submitted.fdrNumber, extracted.fdr_number, normalizedFdrNumber),
  },
  bank_name: {
    status: compareValue(submitted.bankName, extracted.bank_name, normalizedText),
  },
  branch_name: {
    status: compareValue(submitted.branch, extracted.branch_name, normalizedText),
  },
  deposit_amount: {
    status: compareValue(submitted.amount, extracted.deposit_amount, (value) =>
      value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : null,
    ),
  },
  currency: {
    status: compareValue(submitted.currency, extracted.currency, (value) =>
      textValue(value)?.trim().toLocaleUpperCase('en-IN') || null,
    ),
  },
  issue_date: {
    status: compareValue(submitted.issueDate, extracted.issue_date, normalizedDate),
  },
  maturity_date: {
    status: compareValue(submitted.maturityDate, extracted.maturity_date, normalizedDate),
  },
  institution_name: {
    status: compareValue(institutionName, extracted.institution_name, normalizedText),
  },
});
