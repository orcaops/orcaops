import { z } from 'zod';

import { UuidV7Schema } from '../ids/uuidv7.js';
import { identifierText } from '../text/control-chars.js';

/**
 * Schemas for the repo-level **usage ledger** — the coding agent's own token
 * usage, kept separate from artifact event semantics (see `usage/ledger.ts`).
 *
 * The ledger has its OWN event types and record envelope (NOT the artifact
 * `EventTypeSchema`): usage is session-derived external state, recordable
 * before an artifact exists, rebuilt independently, and linked to artifacts at
 * capture. Token counts only — pricing is the cloud's job.
 */

/** Raw token counts, Claude-native field names. Tokens only, never USD. */
export const AgentUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    // Open, additive raw counters (provider-/billing-specific; never priced
    // here, sparse/omitted when empty). Same safe-counter discipline as the
    // scalar fields, so a negative or fractional counter can't pass schema.
    // Keys are provider-derived text on a hash-participating surface —
    // identifierText REJECTS forbidden control chars (never strips, so the
    // parse stays byte-identical for clean input).
    dimensions: z
      .record(identifierText(z.string().min(1)), z.number().int().nonnegative())
      .optional(),
  })
  .strict();
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

/**
 * How a snapshot's `delta_usage` was baselined:
 *  - `first_observation` — no same-session prior; `delta_usage` is NULL.
 *  - `prior_same_artifact` / `prior_same_source_plan` — delta vs a prior
 *    snapshot sharing `(agent, session_id, scope)`.
 *  - `checkpoint_open` — delta vs this checkpoint's open snapshot.
 *  - `whole_session` — delta measured from session-start (resumed leg /
 *    `--count-whole-session`).
 */
export const UsageBaselineKindSchema = z.enum([
  'first_observation',
  'prior_same_artifact',
  'prior_same_source_plan',
  'checkpoint_open',
  'whole_session',
]);
export type UsageBaselineKind = z.infer<typeof UsageBaselineKindSchema>;

/** Per-model cumulative usage plus its delta (NULL on a first observation),
 *  partitioned by the price-determining rate class (omitted when default). */
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

/** Payload of an `agent_usage_snapshot_recorded` ledger event. */
export const AgentUsageSnapshotPayloadSchema = z
  .object({
    snapshot_id: identifierText(z.string().min(1)),
    idempotency_key: identifierText(z.string().min(1)),
    agent: identifierText(z.string().min(1)),
    session_id: identifierText(z.string().min(1)),
    /** Nullable: a pre-capture plan-review snapshot has no artifact yet. */
    artifact_id: identifierText(z.string().min(1)).nullable(),
    /** Nullable: a snapshot may attach to a source plan instead of an artifact. */
    source_plan_ref_id: identifierText(z.string().min(1)).nullable(),
    lifecycle_event: identifierText(z.string().min(1)),
    checkpoint_n: z.number().int().nonnegative().nullable(),
    cumulative_usage: AgentUsageSchema,
    /** NULL on a first observation (never claims prior usage). */
    delta_usage: AgentUsageSchema.nullable(),
    baseline_kind: UsageBaselineKindSchema,
    model_breakdown: z.array(UsageModelBreakdownEntrySchema),
    record_count: z.number().int().nonnegative(),
    as_of: identifierText(z.string().min(1)),
  })
  .strict();
export type AgentUsageSnapshotPayload = z.infer<typeof AgentUsageSnapshotPayloadSchema>;

/** Payload of a `source_plan_linked` ledger event. */
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

/** Hard ceiling before a ledger reader allocates a declared sidecar buffer. */
export const MAX_USAGE_SIDECAR_BYTES = 8 * 1024 * 1024;

/**
 * On-disk ledger record envelope. Mirrors the artifact event log (inline OR
 * sidecar payload, per-line sha256 checksum) but with the ledger's own event
 * types — `.strict()` so a sidecar record can't masquerade as inline.
 */
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
