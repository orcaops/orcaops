import { z } from 'zod';

import {
  type EvaluatorFinding,
  EvaluatorFindingsUnreadableSchema,
  EvaluatorRunFindingsSchema,
  MAX_EVALUATOR_FINDINGS,
  MAX_FINDING_DETAIL_CHARS,
  MAX_FINDING_LOCATIONS,
  MAX_FINDING_TITLE_CHARS,
} from '@orcaops/evaluator-protocol';
import { stripTerminalFormatting } from '@orcaops/evaluator-protocol/terminal';

/**
 * What a caller hands storage about one evaluator run, beside the events that retain the run
 * itself. It never travels inside the authored payload: `orcaops.evaluator_run/v1` is strict and
 * is re-parsed on every thread rebuild, and the gate audit embedded in `checkpoint_opened` is the
 * same shape, so a finding carried there would make retained history fail its own rebuild.
 *
 * `findings` is the runner's own handover, kept verbatim so the three outcomes it distinguishes —
 * none offered, established, offered and unreadable — cannot collapse into each other on the way
 * to disk.
 */

const NonBlankSchema = z.string().min(1);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'must be a lowercase SHA-256 in hexadecimal',
});

/**
 * The basis the run was given. Every member is nullable and null means the caller did not have
 * it: an unnameable basis is recorded as unknown rather than filled with something that reads
 * like an identity. `producer_payload` is the bytes the producer emitted, which nothing in
 * today's runner hands over — `EvaluatorRunPayload` carries `body`, `raw` and `metrics` copied
 * out of them, not the bytes themselves.
 */
export const EvaluatorRunBasisSchema = z.strictObject({
  context_sha256: Sha256Schema.nullable(),
  base_sha: NonBlankSchema.nullable(),
  head_sha: NonBlankSchema.nullable(),
  evaluator_version: NonBlankSchema.nullable(),
  producer_payload: z.instanceof(Uint8Array).nullable(),
});
export type EvaluatorRunBasis = z.infer<typeof EvaluatorRunBasisSchema>;

/**
 * The bounds are the runner's to apply — `boundEvaluatorFindings` truncates and reports what it
 * cut, because a length may never decide a gate — and storage's to require, because a record that
 * exceeds one was not bounded and is not the runner's output. They are checked here rather than
 * in the protocol schema, which deliberately accepts what a producer wrote.
 */
function refuseUnbounded(record: { findings: readonly EvaluatorFinding[] }, ctx: z.RefinementCtx) {
  if (record.findings.length > MAX_EVALUATOR_FINDINGS)
    ctx.addIssue({
      code: 'custom',
      path: ['findings'],
      message: `a retained record holds at most ${MAX_EVALUATOR_FINDINGS} findings`,
    });
  record.findings.forEach((finding, index) => {
    if (finding.title.length > MAX_FINDING_TITLE_CHARS)
      ctx.addIssue({
        code: 'custom',
        path: ['findings', index, 'title'],
        message: `a retained title is at most ${MAX_FINDING_TITLE_CHARS} characters`,
      });
    if (finding.detail !== undefined && finding.detail.length > MAX_FINDING_DETAIL_CHARS)
      ctx.addIssue({
        code: 'custom',
        path: ['findings', index, 'detail'],
        message: `a retained detail is at most ${MAX_FINDING_DETAIL_CHARS} characters`,
      });
    if (finding.locations !== undefined && finding.locations.length > MAX_FINDING_LOCATIONS)
      ctx.addIssue({
        code: 'custom',
        path: ['findings', index, 'locations'],
        message: `a retained finding points at most at ${MAX_FINDING_LOCATIONS} places`,
      });
  });
}

/**
 * Terminal control is unsafe rather than incoherent, so the protocol's schemas accept it and
 * `scrubEvaluatorOutput` strips it at the trust boundary. A record that still carries some never
 * went through that scrub, so it is not the runner's output either, and it is refused rather than
 * reshaped: the retained bytes are what was handed over or they are nothing.
 *
 * `stripTerminalFormatting` is the scrub's own terminal half, reused so there is one rule.
 */
function refuseTerminalControl(value: unknown, ctx: z.RefinementCtx, path: PropertyKey[] = []) {
  if (typeof value === 'string') {
    if (stripTerminalFormatting(value) !== value)
      ctx.addIssue({
        code: 'custom',
        path,
        message: 'must carry no terminal control; hand over what the runner scrubbed',
      });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => refuseTerminalControl(item, ctx, [...path, index]));
    return;
  }
  if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      refuseTerminalControl(item, ctx, [...path, key]);
}

export const EvaluatorRunFindingsOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none') }),
  z.strictObject({
    status: z.literal('established'),
    record: EvaluatorRunFindingsSchema.superRefine((record, ctx) => {
      refuseUnbounded(record, ctx);
      refuseTerminalControl(record, ctx);
    }),
  }),
  z.strictObject({
    status: z.literal('unreadable'),
    record: EvaluatorFindingsUnreadableSchema.superRefine(refuseTerminalControl),
  }),
]);

export const EvaluatorRunEvidenceSchema = z.strictObject({
  run_id: NonBlankSchema,
  findings: EvaluatorRunFindingsOutcomeSchema,
  basis: EvaluatorRunBasisSchema,
});
export type EvaluatorRunEvidence = z.infer<typeof EvaluatorRunEvidenceSchema>;
