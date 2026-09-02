import { z } from 'zod';

import {
  EvaluatorPhaseSchema,
  EvaluatorRunErrorSchema,
  EvaluatorRunStatusSchema,
  EvaluatorSeveritySchema,
  EvaluatorVerdictSchema,
  IdSchema,
  LlmTokenUsageSchema,
  WrittenDispositionSchema,
} from './common.js';

/**
 * Embedded delta-from-parent shapes used inside `checkpoint_opened`
 * event payloads (`payload.gate_audit.runs[]` and `.dispositions[]`).
 *
 * Embedded rows omit fields that the rebuilder derives: these shapes
 * deliberately drop the fields that the projection rebuilder can
 * synthesize from the parent `checkpoint_opened` event (artifact_id,
 * package_id / evaluator_id, checkpoint_n, agent_session_id, the
 * constant `schema` field). The rebuilder fills those in before
 * promoting the row into the normal `runs[]` / `dispositions[]`
 * projection arrays.
 *
 * Same cross-field invariants as the standalone payloads — verdict
 * non-null iff completed; error set iff errored.
 */
export const GateAuditRunSchema = z
  .object({
    run_id: IdSchema,
    evaluator_ref: z.string().min(1),
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
    if (run.phase !== 'checkpoint-open') {
      ctx.addIssue({
        code: 'custom',
        path: ['phase'],
        message: 'gate_audit runs must carry `phase: "checkpoint-open"`',
      });
    }
  });
export type GateAuditRun = z.infer<typeof GateAuditRunSchema>;

export const GateAuditDispositionSchema = z
  .object({
    disposition_id: IdSchema,
    run_id: IdSchema,
    evaluator_ref: z.string().min(1),
    disposition: WrittenDispositionSchema,
    reason: z.string().min(1),
    ts: z.string().datetime(),
  })
  .strict();
export type GateAuditDisposition = z.infer<typeof GateAuditDispositionSchema>;

/**
 * Full gate_audit payload embedded under
 * `checkpoint_opened.payload.gate_audit`. Both arrays default to
 * empty (a successful open whose dry-run produced no runs has an
 * empty audit, but the field stays present so the rebuilder can
 * unconditionally walk `runs` / `dispositions`).
 */
export const GateAuditPayloadSchema = z
  .object({
    runs: z.array(GateAuditRunSchema).default([]),
    dispositions: z.array(GateAuditDispositionSchema).default([]),
  })
  .strict();
export type GateAuditPayload = z.infer<typeof GateAuditPayloadSchema>;
