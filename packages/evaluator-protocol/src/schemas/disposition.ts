import { z } from 'zod';

import { IdSchema, WrittenDispositionSchema } from './common.js';

/**
 * Payload schema for the `evaluator_disposition_recorded` event.
 *
 * A disposition resolves a specific `EvaluatorRun.run_id`. The
 * original run is immutable; the disposition references it. `reason`
 * is required, non-empty — disposition writes that drop the audit
 * trail are not permitted.
 *
 * Note: the `unresolved` materialized value is **never** written as
 * an event payload (it's derived from "blocking-eligible AND no
 * matching disposition row"). The schema's enum constrains writes
 * to `acknowledged | dismissed | policy-excepted`.
 */
export const EvaluatorDispositionPayloadSchema = z
  .object({
    schema: z.literal('orcaops.evaluator_disposition/v1'),
    disposition_id: IdSchema,
    artifact_id: IdSchema,
    run_id: IdSchema,
    evaluator_ref: z.string().min(1),
    disposition: WrittenDispositionSchema,
    reason: z.string().min(1),
    agent_session_id: z.string().nullable(),
    ts: z.string().datetime(),
  })
  .strict();
export type EvaluatorDispositionPayload = z.infer<typeof EvaluatorDispositionPayloadSchema>;
