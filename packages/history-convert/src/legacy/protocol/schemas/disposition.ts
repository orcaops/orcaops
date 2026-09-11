import { z } from 'zod';

import { IdSchema, WrittenDispositionSchema } from './common.js';
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
