import { z } from 'zod';

export const PULL_CACHE_SCHEMA_VERSION = 1;

export const PullCacheRecordSchema = z.object({
  schema_version: z.literal(PULL_CACHE_SCHEMA_VERSION),
  external_id: z.string().min(1),
  slug: z.string().min(1),
  version_number: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string().min(1),
  content_hash: z.string().min(1),
  source_ref: z.string().nullable(),
  base_url: z.string().min(1),
  org_id: z.string().min(1),
  pulled_at: z.string().min(1),
});
export type PullCacheRecord = z.infer<typeof PullCacheRecordSchema>;

export interface PullCacheMatch {
  record: PullCacheRecord;
  namespace: string;
}

export const REVIEW_PULL_CACHE_SCHEMA_VERSION = 1;

export const ReviewPullRecordSchema = z
  .object({
    schema_version: z.literal(REVIEW_PULL_CACHE_SCHEMA_VERSION),
    target: z.enum(['candidate', 'proposal']),
    external_id: z.string().min(1),
    version_id: z.string().min(1).nullable(),
    version_number: z.number().int().positive().nullable(),
    proposal_id: z.string().min(1).nullable(),
    base_version_number: z.number().int().positive().nullable(),
    content_hash: z.string().min(1),
    body: z.string().min(1),
    base_url: z.string().min(1),
    org_id: z.string().min(1),
    pulled_at: z.string().min(1),
  })
  .superRefine((record, context) => {
    if (record.target === 'candidate') {
      if (record.version_id === null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_id'],
          message: "target 'candidate' requires a non-null version_id",
        });
      if (record.version_number === null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_number'],
          message: "target 'candidate' requires a non-null version_number",
        });
      if (record.proposal_id !== null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposal_id'],
          message: "target 'candidate' must not carry a proposal_id",
        });
    } else {
      if (record.proposal_id === null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proposal_id'],
          message: "target 'proposal' requires a non-null proposal_id",
        });
      if (record.version_id !== null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_id'],
          message: "target 'proposal' must not carry a version_id",
        });
      if (record.version_number !== null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['version_number'],
          message: "target 'proposal' must not carry a version_number",
        });
    }
  });
export type ReviewPullRecord = z.infer<typeof ReviewPullRecordSchema>;
