import { z } from 'zod';

import { EvaluatorVerdictSchema } from './common.js';
import {
  EvaluatorFindingListSchema,
  type FindingsRead,
  refineUniqueFindingKeys,
} from './finding.js';

/**
 * Superseded result envelope. The runner no longer runs a producer that
 * emits it; `inspectResultEnvelopeProtocol` reports it as `superseded` so the
 * failure names the required update instead of a malformed envelope.
 *
 * It is NOT how retained history is read: the envelope never reaches disk,
 * because the runner copies `body`, `raw` and `metrics` into
 * `orcaops.evaluator_run/v1` and retains that. It stays exported because the
 * SDK, the core, js and demo packs, the CLI fixtures and `eval schema` still
 * emit and parse it until their slices land, and because negotiation needs
 * the literal to recognise. It can be removed once the release is complete.
 *
 * A spec's optional `engine.output_schema`, when set, validates the OPTIONAL
 * `raw` field — **never** the envelope itself.
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

/** The envelope literal a producer must emit for this release to run it. */
export const CURRENT_RESULT_ENVELOPE_SCHEMA = 'orcaops.evaluator_result/v2';

/** Literals this release replaced, in the order they were published. */
export const SUPERSEDED_RESULT_ENVELOPE_SCHEMAS: readonly string[] = [
  'orcaops.evaluator_result/v1',
];

/**
 * Current result envelope produced by:
 *   - the command engine on stdout (single JSON object), AND
 *   - the LLM engine when `output_format: json` (structured output
 *     parsed from the response body).
 *
 * `v1` plus the OPTIONAL `findings` array. Verdict and gate meanings are
 * unchanged: a valid result may carry no findings under any verdict, may
 * carry findings under any verdict, and findings never decide the gate.
 * `findings: []` and an absent `findings` mean the same thing.
 */
export const EvaluatorResultEnvelopeV2Schema = z
  .object({
    schema: z.literal(CURRENT_RESULT_ENVELOPE_SCHEMA),
    verdict: EvaluatorVerdictSchema,
    body: z.string(),
    raw: z.unknown().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    findings: EvaluatorFindingListSchema.optional(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.findings === undefined) return;
    refineUniqueFindingKeys(envelope.findings, ctx);
  });
export type EvaluatorResultEnvelopeV2 = z.infer<typeof EvaluatorResultEnvelopeV2Schema>;

/**
 * Longest `schema` value the negotiation path will look at. Nothing
 * legitimate is this long, and a negotiation path is not where a producer's
 * blob belongs; an over-long value falls through to the strict parse, whose
 * field-path message is the better diagnostic.
 */
const MAX_SCHEMA_LITERAL_CHARS = 200;

/**
 * What the runner learned from a result's `schema` literal, before any strict
 * parse.
 *
 * `superseded` and `unknown` are separate because the message differs: the
 * first can name the version the producer speaks and the one it needs, the
 * second can only name what this release reads. `undeclared` is not a
 * negotiation failure — it is a malformed envelope, and the caller should let
 * the strict parse produce the diagnostic.
 */
export type ResultEnvelopeProtocol =
  | { status: 'current' }
  | { status: 'superseded'; schema: string }
  | { status: 'unknown'; schema: string }
  | { status: 'undeclared' };

/**
 * Read a parsed result's protocol version without validating it.
 *
 * Every string this returns is producer-controlled; callers scrub and bound
 * it before it is persisted or shown, as they already do for every other
 * evaluator diagnostic.
 */
export function inspectResultEnvelopeProtocol(value: unknown): ResultEnvelopeProtocol {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'undeclared' };
  }
  const declared = (value as Record<string, unknown>).schema;
  if (typeof declared !== 'string' || declared.length === 0) {
    return { status: 'undeclared' };
  }
  if (declared === CURRENT_RESULT_ENVELOPE_SCHEMA) return { status: 'current' };
  if (declared.length > MAX_SCHEMA_LITERAL_CHARS) return { status: 'undeclared' };
  if (SUPERSEDED_RESULT_ENVELOPE_SCHEMAS.includes(declared)) {
    return { status: 'superseded', schema: declared };
  }
  return { status: 'unknown', schema: declared };
}

/**
 * Version line of `@orcaops/evaluator-sdk` that emits the current envelope.
 * The coordinated release sets it; the design note records why it moves with
 * the protocol package rather than independently.
 */
export const REQUIRED_EVALUATOR_SDK_VERSION_LINE = '0.2.x';

/**
 * The one wording of the unsupported-protocol failure, so the command engine
 * and the LLM engine cannot drift into telling an author two different
 * things.
 *
 * It names the fix in the author's terms — which package, which version line,
 * and that the pack must be rebuilt — because the literal alone tells someone
 * who did not write the protocol nothing they can act on.
 */
export function unsupportedResultProtocolMessage(
  protocol: Extract<ResultEnvelopeProtocol, { status: 'superseded' | 'unknown' }>
): string {
  const produced =
    protocol.status === 'superseded'
      ? `this evaluator produced \`${protocol.schema}\`, which this release no longer runs`
      : `this evaluator produced \`${protocol.schema}\`, which this release does not recognise`;
  return (
    `${produced}. Upgrade @orcaops/evaluator-sdk to ${REQUIRED_EVALUATOR_SDK_VERSION_LINE} and ` +
    `rebuild the pack so it emits \`${CURRENT_RESULT_ENVELOPE_SCHEMA}\`; a hand-written envelope ` +
    'needs only its `schema` value changed.'
  );
}

/**
 * The envelope validated with its `findings` left unread, so a producer's
 * findings can fail without taking the verdict with them.
 */
const ResultEnvelopeV2ShellSchema = z
  .object({
    schema: z.literal(CURRENT_RESULT_ENVELOPE_SCHEMA),
    verdict: EvaluatorVerdictSchema,
    body: z.string(),
    raw: z.unknown().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    findings: z.unknown().optional(),
  })
  .strict();

const FindingsFieldSchema = z
  .object({ findings: EvaluatorFindingListSchema })
  .superRefine((value, ctx) => refineUniqueFindingKeys(value.findings, ctx));

export type ResultEnvelopeRead =
  | { status: 'invalid'; issue: string }
  | {
      status: 'ok';
      envelope: Omit<EvaluatorResultEnvelopeV2, 'findings'>;
      findings: FindingsRead;
    };

/**
 * Read a current-version envelope in two steps, so the two failures stay
 * apart: an envelope that is wrong in any other field is `invalid` and the
 * caller records an error run, exactly as it does today, while findings that
 * fail on their own leave the verdict, the run status and the gate untouched
 * and are reported as `unreadable`.
 *
 * Call only after `inspectResultEnvelopeProtocol` reported `current`; a
 * superseded or unknown literal is the unsupported-protocol failure and has
 * its own message.
 */
export function readResultEnvelope(value: unknown): ResultEnvelopeRead {
  const shell = ResultEnvelopeV2ShellSchema.safeParse(value);
  if (!shell.success) {
    const issue = shell.error.issues[0];
    return { status: 'invalid', issue: `${issue.path.join('.') || '<root>'}: ${issue.message}` };
  }
  const { findings, ...envelope } = shell.data;
  if (findings === undefined) {
    return { status: 'ok', envelope, findings: { status: 'absent' } };
  }
  const parsed = FindingsFieldSchema.safeParse({ findings });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 'ok',
      envelope,
      findings: {
        status: 'unreadable',
        reason: `${issue.path.join('.') || 'findings'}: ${issue.message}`,
      },
    };
  }
  return { status: 'ok', envelope, findings: { status: 'ok', findings: parsed.data.findings } };
}
