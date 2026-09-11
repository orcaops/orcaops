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
} from '../../protocol/index.js';
export {
  blockingEvaluatorFailureKind,
  EvaluatorDispositionPayloadSchema,
  EvaluatorDispositionSchema,
  EvaluatorRunPayloadSchema,
  isBlockingEvaluatorFailure,
} from '../../protocol/index.js';
export type {
  BlockingEvaluatorFailureKind,
  EvaluatorDispositionPayload,
  EvaluatorDisposition,
  EvaluatorRunPayload,
} from '../../protocol/index.js';
export const OrderKeyComponentsSchema = z
  .object({
    source_event_index: z.number().int().nonnegative(),
    local_kind_rank: z.union([z.literal(0), z.literal(1)]),
    local_index: z.number().int().nonnegative(),
  })
  .strict();
export type OrderKeyComponents = z.infer<typeof OrderKeyComponentsSchema>;
export const MaterializedEvaluatorRunSchema = EvaluatorRunPayloadSchema.safeExtend({
  disposition: EvaluatorDispositionSchema.nullable(),
  source_event_index: z.number().int().nonnegative(),
  local_kind_rank: z.literal(0),
  local_index: z.number().int().nonnegative(),
}).superRefine((row, ctx) => {
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
export const MaterializedEvaluatorDispositionSchema = EvaluatorDispositionPayloadSchema.safeExtend({
  source_event_index: z.number().int().nonnegative(),
  local_kind_rank: z.literal(1),
  local_index: z.number().int().nonnegative(),
});
export type MaterializedEvaluatorDisposition = z.infer<
  typeof MaterializedEvaluatorDispositionSchema
>;
export const EvaluatorLogSchema = z
  .object({
    schema_version: z.literal(1),
    artifact_id: IdSchema,
    runs: z.array(MaterializedEvaluatorRunSchema),
    dispositions: z.array(MaterializedEvaluatorDispositionSchema),
    source_event_id: z.string().min(1),
  })
  .strict();
export type EvaluatorLog = z.infer<typeof EvaluatorLogSchema>;
export {
  EvaluatorPhaseSchema,
  EvaluatorRunStatusSchema,
  EvaluatorSeveritySchema,
  EvaluatorVerdictSchema,
};
