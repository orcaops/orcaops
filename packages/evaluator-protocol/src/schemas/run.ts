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

/**
 * Payload schema for the `evaluator_run_recorded` event (and the row
 * shape persisted to `evaluator_runs.ndjson` projection + SQLite).
 *
 * This is the raw run shape with **no `disposition` field** —
 * dispositions are written as separate
 * `evaluator_disposition_recorded` events and materialized into the
 * `EvaluatorRun` view by the projection rebuilder.
 *
 * Cross-field invariant:
 *   verdict is non-null iff run_status === 'completed';
 *   error is set iff run_status === 'error'.
 */
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

    // LLM-only fields (absent on command-engine runs)
    provider: z.enum(['claude', 'codex']).optional(),
    model: z.string().min(1).optional(),
    tokens: LlmTokenUsageSchema.optional(),
    cost_usd: z.number().nonnegative().optional(),

    // Engine-side execution metrics
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

/**
 * True iff a run is eligible to block capture progression: a
 * block-severity, fully-completed evaluator with a `violation`
 * verdict. This is the canonical export.
 *
 * Storage uses it inside the EvaluatorRun schema's `superRefine` to
 * enforce the materialization invariant ("blocking-eligible
 * violations must carry a non-null disposition"). The CLI bridge
 * uses it to decide whether a checkpoint-open gate or a pre-pr
 * dispatch needs to halt the lifecycle. Both layers read the same
 * three fields; both must agree on the predicate.
 */
export function isBlockingEligibleViolation(
  run: Pick<EvaluatorRunPayload, 'severity' | 'run_status' | 'verdict'>
): boolean {
  return run.severity === 'block' && run.run_status === 'completed' && run.verdict === 'violation';
}

export type BlockingEvaluatorFailureKind = 'violation' | 'error';

/**
 * Classify the two evaluator outcomes that stop lifecycle progression.
 * Violations can be dispositioned; infrastructure errors can only be cleared
 * by a later successful run for the same evaluator.
 */
export function blockingEvaluatorFailureKind(run: {
  severity: string;
  run_status: string;
  verdict: string | null;
}): BlockingEvaluatorFailureKind | null {
  if (run.severity !== 'block') return null;
  if (run.run_status === 'error') return 'error';
  return run.run_status === 'completed' && run.verdict === 'violation' ? 'violation' : null;
}

/**
 * True when lifecycle progression must stop. Infrastructure errors from a
 * block-severity evaluator fail closed but are not policy findings, so they
 * cannot be acknowledged, dismissed, or policy-excepted. Completed
 * violations retain the existing disposition workflow.
 */
export function isBlockingEvaluatorFailure(run: {
  severity: string;
  run_status: string;
  verdict: string | null;
}): boolean {
  return blockingEvaluatorFailureKind(run) !== null;
}
