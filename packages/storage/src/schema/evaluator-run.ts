import { z } from 'zod';

import {
  EvaluatorDispositionPayloadSchema,
  EvaluatorDispositionSchema,
  EvaluatorPhaseSchema,
  EvaluatorRunPayloadSchema,
  EvaluatorRunStatusSchema,
  EvaluatorSeveritySchema,
  EvaluatorVerdictSchema,
  IdSchema,
  isBlockingEligibleViolation,
} from '@orcaops/evaluator-protocol';

// ─────────────────────────────────────────────────────────────────────
// Protocol-aligned. The single canonical evaluator-run shape. Re-exports
// the protocol payload schemas + adds the storage-layer materialized
// shapes that mirror the SQLite + JSON projection.
// ─────────────────────────────────────────────────────────────────────

export {
  blockingEvaluatorFailureKind,
  EvaluatorDispositionPayloadSchema,
  EvaluatorDispositionSchema,
  EvaluatorRunPayloadSchema,
  isBlockingEvaluatorFailure,
} from '@orcaops/evaluator-protocol';
export type {
  BlockingEvaluatorFailureKind,
  EvaluatorDispositionPayload,
  EvaluatorDisposition,
  EvaluatorRunPayload,
} from '@orcaops/evaluator-protocol';

/**
 * Strict total order key for projection walks. The lexicographic tuple
 * `(source_event_index, local_kind_rank, local_index)` guarantees deterministic ordering across:
 *   - standalone `evaluator_run_recorded` /
 *     `evaluator_disposition_recorded` events
 *   - rows unfolded from `checkpoint_opened.payload.gate_audit`, which
 *     may share a timestamp with the parent event or each other
 *
 * Timestamps alone are insufficient — millisecond ties and embedded
 * rows inheriting a single parent `ts` would mis-order a
 * policy-exception disposition relative to its target run.
 */
export const OrderKeyComponentsSchema = z
  .object({
    source_event_index: z.number().int().nonnegative(),
    local_kind_rank: z.union([z.literal(0), z.literal(1)]),
    local_index: z.number().int().nonnegative(),
  })
  .strict();
export type OrderKeyComponents = z.infer<typeof OrderKeyComponentsSchema>;

/**
 * Materialized run shape — the projection rebuilder's output and the
 * SQLite mirror's row type. Carries every field of the persisted
 * `EvaluatorRunPayload` plus:
 *   - `disposition` materialized from the latest disposition row
 *     targeting this `run_id` (or `'unresolved'` if blocking-eligible
 *     with no disposition, or `null` if not blocking-eligible).
 *   - the three order-key components (always present; downstream
 *     consumers — block-state walk, digest collapse, cloud wire —
 *     sort exclusively by these, never by `ts`).
 */
export const MaterializedEvaluatorRunSchema = EvaluatorRunPayloadSchema.safeExtend({
  disposition: EvaluatorDispositionSchema.nullable(),
  source_event_index: z.number().int().nonnegative(),
  /** Always `0` for runs (runs sort before dispositions within the same source event). */
  local_kind_rank: z.literal(0),
  local_index: z.number().int().nonnegative(),
}).superRefine((row, ctx) => {
  // Disposition must be non-null iff blocking-eligible. Mirrors the
  // invariant doctor's structural-consistency audit recomputes.
  const blockingEligible = isBlockingEligibleViolation(row);
  if (blockingEligible && row.disposition === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['disposition'],
      message: 'blocking-eligible runs must carry a non-null materialized disposition',
    });
  }
  if (!blockingEligible && row.disposition !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['disposition'],
      message: 'non-blocking-eligible runs must carry `disposition: null`',
    });
  }
});
export type MaterializedEvaluatorRun = z.infer<typeof MaterializedEvaluatorRunSchema>;

/**
 * Materialized disposition shape — the projection rebuilder's
 * disposition rows. Carries every field of the persisted
 * `EvaluatorDispositionPayload` plus the order-key components.
 *
 * The materialized payload retains the disposition value verbatim
 * (`acknowledged | dismissed | policy-excepted`) — `unresolved` is
 * the materialized-only run-side value, never appears on disposition
 * rows themselves.
 */
export const MaterializedEvaluatorDispositionSchema = EvaluatorDispositionPayloadSchema.safeExtend({
  source_event_index: z.number().int().nonnegative(),
  /** Always `1` for dispositions (dispositions sort after runs within the same source event). */
  local_kind_rank: z.literal(1),
  local_index: z.number().int().nonnegative(),
});
export type MaterializedEvaluatorDisposition = z.infer<
  typeof MaterializedEvaluatorDispositionSchema
>;

/**
 * `evaluators.json` projection. The canonical shape: separate `runs[]`
 * and `dispositions[]` arrays (there is no single-array form).
 *
 * The projection rebuilder folds standalone `evaluator_run_recorded`
 * + `evaluator_disposition_recorded` events AND unfolds
 * `checkpoint_opened.gate_audit.runs[]` / `.dispositions[]` into
 * these two arrays. Both arrays are sorted by `order_key`; block-state
 * derivation walks the interleaved sort.
 */
export const EvaluatorLogSchema = z
  .object({
    schema_version: z.literal(1),
    artifact_id: IdSchema,
    runs: z.array(MaterializedEvaluatorRunSchema),
    dispositions: z.array(MaterializedEvaluatorDispositionSchema),
    /**
     * Event ID of the latest event applied to produce this projection.
     * Required and non-empty: both persisters write the rebuilder's output,
     * and both rebuilder return paths stamp an authoritative event id.
     */
    source_event_id: z.string().min(1),
  })
  .strict();
export type EvaluatorLog = z.infer<typeof EvaluatorLogSchema>;

/**
 * Re-export the protocol enums consumers reach for when working with
 * the new evaluator shapes — saves callers from importing both
 * `@orcaops/storage` and `@orcaops/evaluator-protocol`.
 */
export {
  EvaluatorPhaseSchema,
  EvaluatorRunStatusSchema,
  EvaluatorSeveritySchema,
  EvaluatorVerdictSchema,
};
