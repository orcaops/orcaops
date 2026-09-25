import { z } from 'zod';

/**
 * Durable record of one non-blocking pre-PR evaluator attempt. Legacy events
 * contain only head_sha + ts and are interpreted as passing. New events carry
 * the exact run set and the fingerprints needed to bind warning review.
 *
 * NOT a finalization signal: `revisePlan` finalizes on `summary_captured`
 * only. pre-pr is a repeatable gate before summary, so a passing pre-pr
 * does not freeze plan revision — the marker simply becomes stale and the
 * check re-runs. The event exists to back the advisory next-step hint.
 */
const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What the integration authority check found, carried on the review it was made for.
 *
 * Identities and reasons only, never a rule's wording: this payload is authored, so the secret gate
 * reads it before it is written, and a rule whose words look like a credential would otherwise
 * refuse the pass outright. `revoked` is always empty on a retained marker — a pass with revoked
 * authority refuses and mints none — and is present so the field states both halves of the check.
 *
 * Optional and independent of the review fields above: an event written before this check existed
 * carries none of it, and its absence is not a claim that the check found nothing.
 */
const AuthorityFindingsSchema = z.object({
  moved: z.array(
    z.object({
      key: z.string().min(1),
      selected_revision_id: z.string().min(1),
      governing_revision_ids: z.array(z.string().min(1)),
      role: z.string().min(1),
      effects: z.array(z.string().min(1)),
    })
  ),
  revoked: z.array(z.string().min(1)),
});

export const PrePrCheckedPayloadSchema = z
  .object({
    head_sha: z.string().min(1),
    ts: z.string().datetime(),
    outcome: z.enum(['passed', 'needs_attention']).optional(),
    evaluator_set_fingerprint: FingerprintSchema.optional(),
    review_context_fingerprint: FingerprintSchema.optional(),
    run_ids: z.array(z.string().min(1)).optional(),
    authority: AuthorityFindingsSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    const reviewFields = [
      payload.outcome,
      payload.evaluator_set_fingerprint,
      payload.review_context_fingerprint,
      payload.run_ids,
    ];
    const present = reviewFields.filter((field) => field !== undefined).length;
    if (present !== 0 && present !== reviewFields.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'new pre-PR review fields must be supplied together',
      });
    }
    if (payload.run_ids && new Set(payload.run_ids).size !== payload.run_ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['run_ids'],
        message: 'pre-PR review run_ids must be unique',
      });
    }
  });
export type PrePrCheckedPayload = z.infer<typeof PrePrCheckedPayloadSchema>;
export type PrePrCheckedAuthorityFindings = z.infer<typeof AuthorityFindingsSchema>;
export type PrePrCheckedWritePayload = {
  head_sha: string;
  outcome: 'passed' | 'needs_attention';
  evaluator_set_fingerprint: string;
  review_context_fingerprint: string;
  run_ids: string[];
  authority?: PrePrCheckedAuthorityFindings;
};

export function prePrCheckedOutcome(
  payload: Pick<PrePrCheckedPayload, 'outcome'>
): 'passed' | 'needs_attention' {
  return payload.outcome ?? 'passed';
}
