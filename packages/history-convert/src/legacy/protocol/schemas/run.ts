import { z } from 'zod';

import {
  EvaluatorPhaseSchema,
  EvaluatorRunErrorSchema,
  EvaluatorRunStatusSchema,
  EvaluatorSeveritySchema,
  EvaluatorVerdictSchema,
  IdSchema,
  LlmTokenUsageSchema,
} from './common.js';
export const EvaluatorRunPayloadSchema = z
  .object({
    schema: z.literal('orcaops.evaluator_run/v1'),
    run_id: IdSchema,
    artifact_id: IdSchema,
    evaluator_ref: z.string().min(1),
    package_id: z.string().min(1),
    evaluator_id: z.string().min(1),
    phase: EvaluatorPhaseSchema,
    severity: EvaluatorSeveritySchema,
    run_status: EvaluatorRunStatusSchema,
    verdict: EvaluatorVerdictSchema.nullable(),
    body: z.string(),
    raw: z.unknown().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    provider: z.enum(['claude', 'codex']).optional(),
    model: z.string().min(1).optional(),
    tokens: LlmTokenUsageSchema.optional(),
    cost_usd: z.number().nonnegative().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    checkpoint_n: z.number().int().positive().optional(),
    error: EvaluatorRunErrorSchema.optional(),
    ts: z.string().datetime(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.run_status === 'completed') {
      if (run.verdict === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict'],
          message: '`verdict` must be non-null when `run_status === "completed"`',
        });
      }
      if (run.error !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: '`error` must be absent when `run_status === "completed"`',
        });
      }
    } else {
      if (run.verdict !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict'],
          message: `\`verdict\` must be null when run_status is "${run.run_status}"`,
        });
      }
      if (run.run_status === 'error' && run.error === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['error'],
          message: '`error` is required when `run_status === "error"`',
        });
      }
    }
  });
export type EvaluatorRunPayload = z.infer<typeof EvaluatorRunPayloadSchema>;
export function isBlockingEligibleViolation(
  run: Pick<EvaluatorRunPayload, 'severity' | 'run_status' | 'verdict'>
): boolean {
  return run.severity === 'block' && run.run_status === 'completed' && run.verdict === 'violation';
}
export type BlockingEvaluatorFailureKind = 'violation' | 'error';
export function blockingEvaluatorFailureKind(run: {
  severity: string;
  run_status: string;
  verdict: string | null;
}): BlockingEvaluatorFailureKind | null {
  if (run.severity !== 'block') return null;
  if (run.run_status === 'error') return 'error';
  return run.run_status === 'completed' && run.verdict === 'violation' ? 'violation' : null;
}
export function isBlockingEvaluatorFailure(run: {
  severity: string;
  run_status: string;
  verdict: string | null;
}): boolean {
  return blockingEvaluatorFailureKind(run) !== null;
}
