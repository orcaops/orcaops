import { z } from 'zod';

import { IdSchema } from './common.js';

/**
 * One factual statement an evaluator makes about the work it inspected.
 *
 * A retained finding becomes a claim — "a factual statement or finding, with
 * its verification provenance" — with an observation of the run behind it.
 * The producer states WHAT it found; the runner establishes HOW (engine,
 * evaluator, context, provider, time). Nothing here restates what the runner
 * already knows, and nothing here carries a provenance the producer would
 * have to assert rather than observe.
 *
 * Two kinds of rule act on a finding, and they act differently:
 *
 *   - **Shape** — an unknown key, a wrong type, an incoherent location, a
 *     duplicate key. Refused. The runner records that the findings could not
 *     be read; the verdict and the gate are untouched.
 *   - **Bounds** — how much prose and how many entries. Applied by
 *     {@link boundEvaluatorFindings}, which truncates and reports what it
 *     cut. A bound never refuses, because a refusal that destroyed a verdict
 *     would let a length decide a gate.
 *
 * Identifier lengths are the exception: they refuse, because a shortened
 * path, key or id denotes something other than what the producer named.
 */

/** Truncation bounds. Exceeding one costs content and a notice, never the result. */
export const MAX_EVALUATOR_FINDINGS = 100;
export const MAX_FINDING_TITLE_CHARS = 500;
export const MAX_FINDING_DETAIL_CHARS = 4096;
export const MAX_FINDING_LOCATIONS = 10;

/** Identifier bounds. These refuse: a shortened identifier is a different one. */
export const MAX_FINDING_KEY_CHARS = 200;
export const MAX_FINDING_PATH_CHARS = 1024;
export const MAX_FINDING_ID_CHARS = 200;

/** The marker `boundRedactedText` already writes on a truncated diagnostic. */
export const FINDING_TRUNCATION_MARKER = '…[truncated]';

/**
 * C0, DEL, C1 and the Unicode line separators. Refused in every identifier:
 * a path or a key that carries one denotes nothing a reader can act on, and
 * an id is compared byte for byte.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f) return true;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Everything that ends a line somewhere. `title` is rendered as one line by
 * every consumer, so a producer must not be able to reshape a digest row, a
 * search hit or a terminal table by embedding one of these.
 *
 * Terminal escapes are NOT here: an ANSI sequence is unsafe rather than
 * incoherent, and `scrubEvaluatorOutput` strips it at the trust boundary,
 * exactly as it does for `body`.
 */
const LINE_BREAKING_CODE_POINTS = new Set([
  0x0000, 0x000a, 0x000b, 0x000c, 0x000d, 0x0085, 0x2028, 0x2029,
]);

function breaksLine(value: string): boolean {
  for (const char of value) {
    if (LINE_BREAKING_CODE_POINTS.has(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * Recurrence key: the producer's answer to "is this the same thing I said
 * last time?", recognised by storage as `(artifact_id, evaluator_ref, key)`.
 *
 * The pattern refuses a leading `/`, `~` and every backslash, so an absolute
 * POSIX path, a home-relative path and a Windows path cannot be keys, and it
 * refuses a `..` segment. Those are the instabilities a schema can catch; a
 * key built from a timestamp or a run id is refused by nothing, and the
 * author documentation is what forbids it.
 *
 * Exported so the SDK can answer "would this be a usable key?" for an author
 * building one out of a path or a tag, instead of restating the rule and
 * drifting from it.
 */
export const FindingKeySchema = z
  .string()
  .min(1)
  .max(MAX_FINDING_KEY_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, {
    message:
      'must start with a letter or digit and contain only letters, digits, `.`, `_`, `:`, `/` and `-`',
  })
  .refine((value) => value.split('/').every((segment) => !/^\.+$/.test(segment)), {
    message: 'must not contain a `.` or `..` segment',
  });

const FindingTitleSchema = z
  .string()
  .min(1)
  .refine((value) => !breaksLine(value), { message: 'must be a single line' })
  .refine((value) => value.trim().length > 0, { message: 'must not be blank' });

/**
 * An identifier the producer copied out of its context. Blank and
 * control-bearing values are refused rather than carried into a lookup
 * column that nothing can match.
 */
const NonBlankIdSchema = IdSchema.max(MAX_FINDING_ID_CHARS)
  .refine((value) => value.trim().length > 0, { message: 'must not be blank' })
  .refine((value) => !hasControlCharacter(value), {
    message: 'must not contain control characters',
  });

/**
 * A full git object id. An unconstrained string would collect `HEAD`,
 * `working tree` and branch names, which are exactly the non-identities a
 * snapshot-bound claim may not rest on.
 */
const FindingRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
  message: 'must be a full 40- or 64-character lowercase git object id',
});

function isRepositoryRelativePath(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (value.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  // Every all-dot segment goes, not just `..`: `...` is a traversal spelling
  // on some filesystems and names nothing worth pointing a reader at.
  return value.split('/').every((segment) => segment.length > 0 && !/^\.+$/.test(segment));
}

/**
 * A file, optionally a line or line range, optionally the revision it was
 * read at. Absent `revision` means the finding names a path in whatever tree
 * the run saw, which is not an identified input.
 */
export const FindingFileLocationSchema = z
  .object({
    kind: z.literal('file'),
    path: z.string().min(1).max(MAX_FINDING_PATH_CHARS).refine(isRepositoryRelativePath, {
      message:
        'must be a repository-relative POSIX path with no `.`-only segment, no backslash and no leading `~`',
    }),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    revision: FindingRevisionSchema.optional(),
  })
  .strict()
  .superRefine((location, ctx) => {
    if (location.end_line === undefined) return;
    if (location.start_line === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['end_line'],
        message: '`end_line` requires `start_line`',
      });
      return;
    }
    if (location.end_line < location.start_line) {
      ctx.addIssue({
        code: 'custom',
        path: ['end_line'],
        message: '`end_line` must not precede `start_line`',
      });
    }
  });

export const FindingPlanStepLocationSchema = z
  .object({
    kind: z.literal('plan-step'),
    step_id: NonBlankIdSchema,
  })
  .strict();

/**
 * The criterion id is exact on its own within the artifact, so this does not
 * repeat `step_id`: a redundant parent is a field that can disagree with the
 * criterion it names.
 */
export const FindingAcceptanceCriterionLocationSchema = z
  .object({
    kind: z.literal('acceptance-criterion'),
    criterion_id: NonBlankIdSchema,
  })
  .strict();

/**
 * A continuing requirement or decision, by exact revision id. No field of
 * today's `EvaluatorContext` carries one, so no producer can populate these
 * yet; they are in the shape now because the shape is fixed now, and because
 * a revision is named exactly or not at all.
 */
export const FindingRequirementLocationSchema = z
  .object({
    kind: z.literal('requirement'),
    revision_id: NonBlankIdSchema,
  })
  .strict();

export const FindingDecisionLocationSchema = z
  .object({
    kind: z.literal('decision'),
    revision_id: NonBlankIdSchema,
  })
  .strict();

/**
 * A discriminated union rather than one object of optional fields, so a
 * location is always exactly one kind of pointer and can never be empty or
 * incoherent. "Points at nothing" is the absence of `locations`, not an empty
 * location.
 */
export const EvaluatorFindingLocationSchema = z.discriminatedUnion('kind', [
  FindingFileLocationSchema,
  FindingPlanStepLocationSchema,
  FindingAcceptanceCriterionLocationSchema,
  FindingRequirementLocationSchema,
  FindingDecisionLocationSchema,
]);
export type EvaluatorFindingLocation = z.infer<typeof EvaluatorFindingLocationSchema>;

/**
 * The location kinds that name something the work is expected to satisfy. A
 * file is not one of them: a path is where the producer looked, not what it
 * graded.
 */
export const EXPECTATION_LOCATION_KINDS: readonly EvaluatorFindingLocation['kind'][] = [
  'plan-step',
  'acceptance-criterion',
  'requirement',
  'decision',
];

/**
 * The producer's conclusion about the expectation this finding points at, in
 * this run. The plan's own vocabulary, kept separate from execution errors,
 * skipped checks and missing inputs.
 *
 * "Not assessed", the fourth conclusion, has no value here on purpose: it is
 * the absence of a finding, and absence may never be read as a conclusion at
 * all. `supported` is how a producer says a criterion is now met, which no
 * consumer may infer from silence.
 */
export const EvaluatorFindingConclusionSchema = z.enum(['supported', 'contradicted', 'unresolved']);
export type EvaluatorFindingConclusion = z.infer<typeof EvaluatorFindingConclusionSchema>;

export const EvaluatorFindingSchema = z
  .object({
    key: FindingKeySchema.optional(),
    title: FindingTitleSchema,
    detail: z.string().min(1).optional(),
    locations: z.array(EvaluatorFindingLocationSchema).min(1).optional(),
    conclusion: EvaluatorFindingConclusionSchema.optional(),
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (finding.conclusion === undefined) return;
    const namesExpectation =
      finding.locations?.some((location) => EXPECTATION_LOCATION_KINDS.includes(location.kind)) ??
      false;
    if (!namesExpectation) {
      ctx.addIssue({
        code: 'custom',
        path: ['conclusion'],
        message:
          '`conclusion` requires at least one expectation location (plan-step, acceptance-criterion, requirement or decision)',
      });
    }
  });
export type EvaluatorFinding = z.infer<typeof EvaluatorFindingSchema>;

/**
 * No maximum length: the count is a bound, and bounds truncate. The input
 * that carries the array is already bounded — a command engine's
 * `max_output_bytes`, a markdown block's own character cap.
 */
export const EvaluatorFindingListSchema = z.array(EvaluatorFindingSchema);

/**
 * The three answers a producer's findings can give, from either path that
 * carries them. Kept as one type so a markdown block and an envelope field
 * cannot drift into different vocabularies.
 *
 * `absent` offered none. `unreadable` offered some that could not be
 * established: the caller keeps the verdict, the run status and the gate
 * exactly as they would have been, and retains the reason on its own record.
 */
export type FindingsRead =
  | { status: 'absent' }
  | { status: 'ok'; findings: readonly EvaluatorFinding[] }
  | { status: 'unreadable'; reason: string };

/**
 * Keys are unique within one result. Two findings claiming one identity in a
 * single run would leave storage to pick, and there is no honest way to pick.
 */
export function refineUniqueFindingKeys(
  findings: readonly EvaluatorFinding[],
  ctx: z.RefinementCtx
): void {
  const seen = new Map<string, number>();
  findings.forEach((finding, index) => {
    if (finding.key === undefined) return;
    const first = seen.get(finding.key);
    if (first === undefined) {
      seen.set(finding.key, index);
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['findings', index, 'key'],
      message: `duplicate finding key "${finding.key}" (also at findings[${first}])`,
    });
  });
}

/**
 * What {@link boundEvaluatorFindings} cut. Retained beside the findings, so a
 * reader is never shown a shortened set as if it were the whole one.
 *
 * Refused when it records nothing, so "nothing was cut" has one spelling: the
 * absence of a notice.
 */
export const EvaluatorFindingsNoticeSchema = z
  .object({
    findings_dropped: z.number().int().nonnegative(),
    locations_dropped: z.number().int().nonnegative(),
    titles_shortened: z.number().int().nonnegative(),
    details_shortened: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (notice) =>
      notice.findings_dropped +
        notice.locations_dropped +
        notice.titles_shortened +
        notice.details_shortened >
      0,
    { message: 'a notice must record something that was cut' }
  );
export type EvaluatorFindingsNotice = z.infer<typeof EvaluatorFindingsNoticeSchema>;

export interface BoundedEvaluatorFindings {
  findings: EvaluatorFinding[];
  notice?: EvaluatorFindingsNotice;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= FINDING_TRUNCATION_MARKER.length) return FINDING_TRUNCATION_MARKER.slice(0, max);
  return `${text.slice(0, max - FINDING_TRUNCATION_MARKER.length)}${FINDING_TRUNCATION_MARKER}`;
}

/**
 * Apply the truncation bounds, reporting what was cut.
 *
 * Run this AFTER scrubbing, never before: redaction can lengthen a string,
 * and a secret straddling the cut would otherwise survive as an unmatched
 * prefix. `redactSecretsAndBound` orders the same two steps the same way.
 */
export function boundEvaluatorFindings(
  findings: readonly EvaluatorFinding[]
): BoundedEvaluatorFindings {
  const kept = findings.slice(0, MAX_EVALUATOR_FINDINGS);
  let locations_dropped = 0;
  let titles_shortened = 0;
  let details_shortened = 0;

  const bounded = kept.map((finding) => {
    const next: EvaluatorFinding = { ...finding };
    if (next.title.length > MAX_FINDING_TITLE_CHARS) {
      next.title = truncate(next.title, MAX_FINDING_TITLE_CHARS);
      titles_shortened += 1;
    }
    if (next.detail !== undefined && next.detail.length > MAX_FINDING_DETAIL_CHARS) {
      next.detail = truncate(next.detail, MAX_FINDING_DETAIL_CHARS);
      details_shortened += 1;
    }
    if (next.locations !== undefined && next.locations.length > MAX_FINDING_LOCATIONS) {
      locations_dropped += next.locations.length - MAX_FINDING_LOCATIONS;
      const ranked = next.locations.map((location, index) => ({ location, index }));
      if (next.conclusion !== undefined) {
        ranked.sort(
          (left, right) =>
            Number(EXPECTATION_LOCATION_KINDS.includes(right.location.kind)) -
              Number(EXPECTATION_LOCATION_KINDS.includes(left.location.kind)) ||
            left.index - right.index
        );
      }
      next.locations = ranked
        .slice(0, MAX_FINDING_LOCATIONS)
        .sort((left, right) => left.index - right.index)
        .map(({ location }) => location);
    }
    return next;
  });

  const findings_dropped = findings.length - kept.length;
  if (findings_dropped + locations_dropped + titles_shortened + details_shortened === 0) {
    return { findings: bounded };
  }
  return {
    findings: bounded,
    notice: { findings_dropped, locations_dropped, titles_shortened, details_shortened },
  };
}

/** Literal carried by the markdown findings block an LLM evaluator may emit. */
export const FINDINGS_BLOCK_SCHEMA = 'orcaops.evaluator_findings/v1';

/**
 * Content of an `orcaops-findings` markdown block. `findings: []` is accepted
 * here and collapsed by the consumer, which treats it as no findings; the
 * schema keeps what the producer wrote.
 */
export const EvaluatorFindingsBlockSchema = z
  .object({
    schema: z.literal(FINDINGS_BLOCK_SCHEMA),
    findings: EvaluatorFindingListSchema,
  })
  .strict()
  .superRefine((block, ctx) => refineUniqueFindingKeys(block.findings, ctx));
export type EvaluatorFindingsBlock = z.infer<typeof EvaluatorFindingsBlockSchema>;

/** Literal of the supplemental record the runner hands to storage. */
export const RUN_FINDINGS_SCHEMA = 'orcaops.evaluator_run_findings/v1';

/**
 * Findings established for one run, handed over for storage to write in the
 * same settlement as the run event.
 *
 * Deliberately minimal. `artifact_id`, `evaluator_ref` and timestamps belong
 * to the run event, which owns them; a second copy is a second place for them
 * to disagree. There is no operation id either — the capture settlement
 * supplies its own receipt and ties this record to it inside the transaction
 * that writes the run.
 *
 * At least one finding: a record asserting zero findings says nothing the
 * absence of the record does not already say.
 */
export const EvaluatorRunFindingsSchema = z
  .object({
    schema: z.literal(RUN_FINDINGS_SCHEMA),
    run_id: NonBlankIdSchema,
    findings: EvaluatorFindingListSchema.min(1),
    notice: EvaluatorFindingsNoticeSchema.optional(),
  })
  .strict()
  .superRefine((record, ctx) => refineUniqueFindingKeys(record.findings, ctx));
export type EvaluatorRunFindings = z.infer<typeof EvaluatorRunFindingsSchema>;

/** Literal of the record written when a run's findings could not be read. */
export const FINDINGS_UNREADABLE_SCHEMA = 'orcaops.evaluator_findings_unreadable/v1';

/**
 * The run supplied findings and they could not be established.
 *
 * This is not a finding and not a verdict. The run keeps the verdict and the
 * gate it would have had, and this record says, in the same settlement, that
 * something was offered and could not be read — so a reader never mistakes
 * unreadable output for a check that found nothing.
 *
 * `source` is a closed pair because there are exactly two places findings
 * arrive from. A third would be a new retained meaning, which is worth a
 * deliberate change rather than a new string.
 */
export const EvaluatorFindingsUnreadableSchema = z
  .object({
    schema: z.literal(FINDINGS_UNREADABLE_SCHEMA),
    run_id: NonBlankIdSchema,
    source: z.enum(['markdown-block', 'envelope']),
    detail: z.string().min(1).max(MAX_FINDING_DETAIL_CHARS),
  })
  .strict();
export type EvaluatorFindingsUnreadable = z.infer<typeof EvaluatorFindingsUnreadableSchema>;

/**
 * What the runner hands storage about one run's findings. Exactly three
 * outcomes, so "none supplied" and "supplied but unreadable" can never
 * collapse into each other.
 */
export type EvaluatorRunFindingsOutcome =
  | { status: 'none' }
  | { status: 'established'; record: EvaluatorRunFindings }
  | { status: 'unreadable'; record: EvaluatorFindingsUnreadable };
