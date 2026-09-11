import { z } from 'zod';
const FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const PrePrCheckedPayloadSchema = z
  .object({
    head_sha: z.string().min(1),
    ts: z.string().datetime(),
    outcome: z.enum(['passed', 'needs_attention']).optional(),
    evaluator_set_fingerprint: FingerprintSchema.optional(),
    review_context_fingerprint: FingerprintSchema.optional(),
    run_ids: z.array(z.string().min(1)).optional(),
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
export type PrePrCheckedWritePayload = {
  head_sha: string;
  outcome: 'passed' | 'needs_attention';
  evaluator_set_fingerprint: string;
  review_context_fingerprint: string;
  run_ids: string[];
};
export function prePrCheckedOutcome(
  payload: Pick<PrePrCheckedPayload, 'outcome'>
): 'passed' | 'needs_attention' {
  return payload.outcome ?? 'passed';
}
