import { z } from 'zod';

import { semanticAnchorAttemptSchema } from '../semanticAnchorGenerations.js';
import { revisionId, text, version } from './request.js';
import { semanticGenerationId, semanticResultSchema } from './semantic-records.js';

const counters = z.strictObject({ writeSequence: version, intentChangeCounter: version });
export const semanticCommandOutputSchema = z
  .strictObject({
    schema_version: z.literal(3),
    ok: z.boolean(),
    project_id: revisionId,
    review_id: revisionId,
    run_id: text,
    operation_id: revisionId,
    generation_id: semanticGenerationId,
    attempt_revision_id: revisionId,
    attempt: z.union([z.literal(1), z.literal(2)]),
    accepted: z.boolean(),
    status: z.enum(['PENDING', 'VALID', 'REJECTED']),
    replayed: z.boolean(),
    receipt: z.strictObject({
      scope: z.literal('ORIGINAL_OPERATION'),
      committed_counters: counters,
      result: semanticResultSchema,
    }),
    history: z.discriminatedUnion('status', [
      z.strictObject({
        status: z.literal('AVAILABLE'),
        diagnostics: semanticAnchorAttemptSchema.shape.diagnostics,
        warnings: semanticAnchorAttemptSchema.shape.warnings,
        model: z
          .strictObject({
            relativePath: text,
            sha256: z.string().regex(/^[0-9a-f]{64}$/u),
            byteLength: version,
          })
          .nullable(),
        observed_counters: counters,
      }),
      z.strictObject({
        status: z.literal('UNAVAILABLE'),
        code: text,
        message: text,
        recovery: text,
      }),
    ]),
  })
  .superRefine((value, context) => {
    const result = value.receipt.result;
    if (
      value.ok !== (value.accepted && value.history.status === 'AVAILABLE') ||
      value.accepted !== result.accepted ||
      value.status !== result.status ||
      value.review_id !== result.reviewId ||
      value.run_id !== result.runId ||
      value.generation_id !== result.generationId ||
      value.attempt_revision_id !== result.attemptRevisionId ||
      value.attempt !== result.attemptNumber
    )
      context.addIssue({
        code: 'custom',
        message: 'Semantic output must retain the original operation result',
      });
  });
export type SemanticCommandOutput = z.infer<typeof semanticCommandOutputSchema>;

export function formatSemanticCommandOutput(result: SemanticCommandOutput): string {
  const heading = `semantic submission ${result.status.toLowerCase()} (operation ${result.operation_id}, generation ${result.generation_id}, ${result.replayed ? 'original receipt replay' : 'committed'}); history ${result.history.status.toLowerCase()}`;
  const detail =
    result.history.status === 'UNAVAILABLE'
      ? [`${result.history.code}: ${result.history.message}`, result.history.recovery]
      : [...result.history.diagnostics, ...result.history.warnings].map(
          (item) => `${item.code}: ${item.message}`
        );
  return `${[heading, ...detail].join('\n')}\n`;
}
