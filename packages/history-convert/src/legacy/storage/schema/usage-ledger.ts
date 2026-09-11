import { z } from 'zod';

import { UuidV7Schema } from '../ids/uuidv7.js';
import { identifierText } from '../text/control-chars.js';
export const AgentUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    dimensions: z
      .record(identifierText(z.string().min(1)), z.number().int().nonnegative())
      .optional(),
  })
  .strict();
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export const UsageBaselineKindSchema = z.enum([
  'first_observation',
  'prior_same_artifact',
  'prior_same_source_plan',
  'checkpoint_open',
  'whole_session',
]);
export type UsageBaselineKind = z.infer<typeof UsageBaselineKindSchema>;
export const UsageModelBreakdownEntrySchema = z
  .object({
    model: identifierText(z.string().min(1)),
    speed: identifierText(z.string().min(1)).optional(),
    service_tier: identifierText(z.string().min(1)).optional(),
    inference_geo: identifierText(z.string().min(1)).optional(),
    cumulative: AgentUsageSchema,
    delta: AgentUsageSchema.nullable(),
  })
  .strict();
export type UsageModelBreakdownEntry = z.infer<typeof UsageModelBreakdownEntrySchema>;
export const AgentUsageSnapshotPayloadSchema = z
  .object({
    snapshot_id: identifierText(z.string().min(1)),
    idempotency_key: identifierText(z.string().min(1)),
    agent: identifierText(z.string().min(1)),
    session_id: identifierText(z.string().min(1)),
    artifact_id: identifierText(z.string().min(1)).nullable(),
    source_plan_ref_id: identifierText(z.string().min(1)).nullable(),
    lifecycle_event: identifierText(z.string().min(1)),
    checkpoint_n: z.number().int().nonnegative().nullable(),
    cumulative_usage: AgentUsageSchema,
    delta_usage: AgentUsageSchema.nullable(),
    baseline_kind: UsageBaselineKindSchema,
    model_breakdown: z.array(UsageModelBreakdownEntrySchema),
    record_count: z.number().int().nonnegative(),
    as_of: identifierText(z.string().min(1)),
  })
  .strict();
export type AgentUsageSnapshotPayload = z.infer<typeof AgentUsageSnapshotPayloadSchema>;
export const SourcePlanLinkPayloadSchema = z
  .object({
    canonical_ref_id: identifierText(z.string().min(1)),
    artifact_id: identifierText(z.string().min(1)),
    linked_at: identifierText(z.string().min(1)),
    pinned_version: identifierText(z.string().min(1)).nullable(),
  })
  .strict();
export type SourcePlanLinkPayload = z.infer<typeof SourcePlanLinkPayloadSchema>;
export const UsageLedgerEventTypeSchema = z.enum([
  'agent_usage_snapshot_recorded',
  'source_plan_linked',
]);
export type UsageLedgerEventType = z.infer<typeof UsageLedgerEventTypeSchema>;
export const MAX_USAGE_SIDECAR_BYTES = 8 * 1024 * 1024;
export const InlineUsageRecordSchema = z
  .object({
    event_id: identifierText(UuidV7Schema),
    type: UsageLedgerEventTypeSchema,
    ts: identifierText(z.string().min(1)),
    schema_version: z.literal(1),
    idempotency_key: identifierText(z.string().min(1)),
    payload: z.unknown(),
    checksum: identifierText(z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();
export const SidecarUsageRecordSchema = z
  .object({
    event_id: identifierText(UuidV7Schema),
    type: UsageLedgerEventTypeSchema,
    ts: identifierText(z.string().min(1)),
    schema_version: z.literal(1),
    idempotency_key: identifierText(z.string().min(1)),
    sidecar_sha256: identifierText(z.string().regex(/^[0-9a-f]{64}$/)),
    sidecar_size: z.number().int().nonnegative().max(MAX_USAGE_SIDECAR_BYTES),
    checksum: identifierText(z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .strict();
export const UsageLedgerRecordSchema = z.union([InlineUsageRecordSchema, SidecarUsageRecordSchema]);
export type UsageLedgerRecord = z.infer<typeof UsageLedgerRecordSchema>;
