import { z } from 'zod';

import { UuidV7Schema } from '../ids/uuidv7.js';

export const EventTypeSchema = z.enum([
  'plan_captured',
  /**
   * Plan revision: full-supersede payload that replaces the latest
   * plan. Event payload carries the complete new `plan_steps`
   * (each with stable UUIDv7 step_id), the server-computed
   * `step_lineage` diff, the agent's `rationale`, the
   * `prior_plan_event_id` token, and the new `revision_n`. Latest
   * `plan_captured | plan_revised` event wins in the projection.
   */
  'plan_revised',
  /**
   * Two-phase checkpoint lifecycle.
   * `checkpoint_opened` declares which plan step_ids a cp will cover;
   * `checkpoint_closed` finalizes the open at `n`;
   * `checkpoint_abandoned` cancels the open at `n` without claiming any
   * work, releasing its declared step_ids.
   *
   * There is no legacy ordinal-step-number reader.
   */
  'checkpoint_opened',
  'checkpoint_closed',
  'checkpoint_abandoned',
  /**
   * The persisted shape carries `run_status`,
   * `verdict`, and `error` as distinct fields; dispositions are NOT
   * folded into this payload. Payload schema:
   * `EvaluatorRunPayloadSchema` (re-exported from
   * `@orcaops/evaluator-protocol`).
   */
  'evaluator_run_recorded',
  /**
   * A separate event keyed to a specific
   * `run_id`, recording the human/agent disposition
   * (acknowledged | dismissed | policy-excepted). Materialized
   * back onto the targeted run by the projection rebuilder.
   * Payload schema: `EvaluatorDispositionPayloadSchema`
   * (re-exported from `@orcaops/evaluator-protocol`).
   */
  'evaluator_disposition_recorded',
  'pre_pr_checked',
  'block_acknowledged',
  'block_dismissed',
  'summary_captured',
  'git_import_enriched',
  /**
   * Branch lineage append: emitted by `orcaops lineage` after rebase /
   * merge / squash. Payload is a single `BranchLineageEntry`
   * ({ branch, head_sha, ts, event: 'rebased' | 'merged' }) appended
   * to artifact.json.branch_lineage. The initial 'created' entry is
   * seeded by `plan_captured`, not by this event type.
   */
  'branch_lineage_updated',
  /**
   * Pin lifecycle event. Logged on the **previously-pinned**
   * artifact when a pin is overwritten while that artifact is still
   * `active` or `blocked`. The `summarized` overwrite case is silent
   * (no event). Payload shape:
   *   { displaced_by_artifact_id: string,
   *     shell_key: ShellKey,
   *     reason?: 'auto-on-capture-plan' | 'explicit-checkout' }
   * Doctor surfaces these on still-active artifacts ("was A
   * abandoned?"); search indexing folds in their reasons.
   */
  'pin_displaced',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Inline event record (payload stored directly in the line). Most
 * captures are this shape; only oversized payloads (>8KB canonical
 * JSON) cross over into the sidecar variant.
 *
 * `.strict()` is load-bearing: it rejects records carrying sidecar
 * fields, so the `EventRecordSchema` union picks the correct variant.
 * Without strict, a sidecar record would parse as Inline (with sidecar
 * fields stripped), and the checksum recompute would silently fail
 * because it would be missing the sidecar fields the writer included.
 */
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

/**
 * Sidecar event record. Payload lives at `sidecars/<event_id>.json`;
 * the line carries the hash + size of that file so on-read corruption
 * detection works against either tampering vector.
 *
 * `.strict()` per the same rationale as `InlineEventRecordSchema`.
 */
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

/**
 * Canonical JSON byte-budget for inline payloads. Above this, the
 * payload spills to a sidecar file. 8 KB matches the architecture spec.
 */
export const INLINE_PAYLOAD_BUDGET_BYTES = 8 * 1024;

export interface AppendEventInput {
  type: EventType;
  /** ISO timestamp; caller controls (lets tests pin exact values). */
  ts: string;
  idempotency_key: string;
  /**
   * Arbitrary JSON-shaped payload. Persisted inline iff its canonical
   * JSON byte length is <= `INLINE_PAYLOAD_BUDGET_BYTES`; otherwise
   * spilled to `<sidecarsDir>/<event_id>.json`.
   */
  payload: unknown;
  /**
   * Optional event_id override. Defaults to a freshly-minted UUIDv7.
   * Exposed for deterministic test fixtures; production callers should
   * never set this.
   */
  event_id?: string;
}
