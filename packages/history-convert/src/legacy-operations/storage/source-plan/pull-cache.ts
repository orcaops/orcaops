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
export const PathPointerSchema = z.object({
  external_id: z.string().min(1),
  version_number: z.number().int().positive(),
});
