import { z } from 'zod';

import { EvaluatorVerdictSchema } from './common.js';

/**
 * Standard result envelope produced by:
 *   - the command engine on stdout (single JSON object), AND
 *   - the LLM engine when `output_format: json` (structured output
 *     parsed from the response body).
 *
 * The envelope is the fixed protocol contract. A spec's optional
 * `engine.output_schema`, when set, validates the OPTIONAL `raw`
 * field — **never** the envelope itself.
 *
 * `metrics` is an evaluator-defined map of key/value pairs (e.g.,
 * `{ files_scanned: 42, lines_changed: 117 }`). Secret-shaped keys are
 * redacted before the map enters `EvaluatorRunPayload.metrics`.
 */
export const EvaluatorResultEnvelopeSchema = z
  .object({
    schema: z.literal('orcaops.evaluator_result/v1'),
    verdict: EvaluatorVerdictSchema,
    body: z.string(),
    raw: z.unknown().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
  })
  .strict();
export type EvaluatorResultEnvelope = z.infer<typeof EvaluatorResultEnvelopeSchema>;
