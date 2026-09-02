import { z } from 'zod';

import { CAPTURE_AGENT_IDS } from './config.js';
import { identifierText, proseText } from '../text/control-chars.js';

export const AcceptedWarningSchema = z.object({
  review_id: identifierText(),
  run_id: identifierText(),
  evaluator_ref: identifierText(),
  reason: proseText(z.string().trim().min(1)),
});
export type AcceptedWarning = z.infer<typeof AcceptedWarningSchema>;

export function normalizeAcceptedWarnings(warnings: readonly AcceptedWarning[]): AcceptedWarning[] {
  return [...warnings].sort(
    (a, b) =>
      a.run_id.localeCompare(b.run_id) ||
      a.evaluator_ref.localeCompare(b.evaluator_ref) ||
      a.reason.localeCompare(b.reason)
  );
}

export function normalizeAcceptedWarningsForReplay(value: unknown): unknown {
  const parsed = z.array(AcceptedWarningSchema).safeParse(value);
  return parsed.success ? normalizeAcceptedWarnings(parsed.data) : value;
}

export const AcceptedWarningsSchema = z
  .array(AcceptedWarningSchema)
  .min(1)
  .superRefine((warnings, ctx) => {
    const runIds = new Set<string>();
    const reviewIds = new Set<string>();
    for (const [index, warning] of warnings.entries()) {
      reviewIds.add(warning.review_id);
      if (runIds.has(warning.run_id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'run_id'],
          message: 'accepted warning run_ids must be unique',
        });
      }
      runIds.add(warning.run_id);
    }
    if (reviewIds.size > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'accepted warnings must belong to one pre-PR review',
      });
    }
  });

export const SummaryInputSchema = z.object({
  schema_version: z.literal(1),
  artifact_id: z.string().min(1),
  /**
   * The agent that invoked `capture summary` — runtime-resolved by the
   * CLI, never agent-supplied input. Readers treat absence as "inherit
   * `plan.agent`". `.optional()` with no null default so parsing never
   * grows a key the writer omitted — that would churn the artifact hash
   * (see the matching field on the checkpoint schemas).
   */
  agent: z.enum(CAPTURE_AGENT_IDS).optional(),
  outcome: z.string().min(1),
  tests_written: z.array(z.string()),
  tests_run: z.array(z.string()),
  open_items: z.array(z.string()),
  deferred_decisions: z.array(z.string()),
  accepted_warnings: AcceptedWarningsSchema.optional(),
  head_sha: z.string().min(1),
  ts: z.string().datetime(),
});

export type SummaryInput = z.infer<typeof SummaryInputSchema>;

/** Event-backed summary projection. Authoring uses {@link SummaryInputSchema}. */
export const SummarySchema = SummaryInputSchema.safeExtend({
  source_event_id: z.string().min(1),
});

export type Summary = z.infer<typeof SummarySchema>;
