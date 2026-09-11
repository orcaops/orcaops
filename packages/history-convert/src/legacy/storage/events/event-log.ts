import { z } from 'zod';

import { UuidV7Schema } from '../ids/uuidv7.js';
export const EventTypeSchema = z.enum([
  'plan_captured',
  'plan_revised',
  'checkpoint_opened',
  'checkpoint_closed',
  'checkpoint_abandoned',
  'evaluator_run_recorded',
  'evaluator_disposition_recorded',
  'pre_pr_checked',
  'block_acknowledged',
  'block_dismissed',
  'summary_captured',
  'git_import_enriched',
  'branch_lineage_updated',
  'pin_displaced',
]);
export type EventType = z.infer<typeof EventTypeSchema>;
export const InlineEventRecordSchema = z
  .object({
    event_id: UuidV7Schema,
    type: EventTypeSchema,
    ts: z.string().datetime(),
    schema_version: z.literal(1),
    idempotency_key: z.string().min(1),
    payload: z.unknown(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const SidecarEventRecordSchema = z
  .object({
    event_id: UuidV7Schema,
    type: EventTypeSchema,
    ts: z.string().datetime(),
    schema_version: z.literal(1),
    idempotency_key: z.string().min(1),
    sidecar_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sidecar_size: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const EventRecordSchema = z.union([InlineEventRecordSchema, SidecarEventRecordSchema]);
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type InlineEventRecord = z.infer<typeof InlineEventRecordSchema>;
export type SidecarEventRecord = z.infer<typeof SidecarEventRecordSchema>;
