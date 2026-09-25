// Whether a previously recorded assessment answers the question being asked, dimension by
// dimension.
//
// An assessment is a judgment about exact expectation revisions, against identified software,
// under named conditions, by a named method, on named evidence. Change any of those and it is a
// judgment about a different question. This module says which, and it is the only place that
// decides: a surface that compared a release string itself would decide it differently the next
// time somebody wrote one.
//
// **Nothing here is a defect, and nothing here blocks.** The outcomes are `applies`, `historical`
// and `insufficient_for_a_new_claim`; two of the three say the assessment is not a present
// conclusion about this question, and none of them says the software is wrong. An older failing
// assessment against another version is `historical` or `insufficient`, exactly as a passing one
// is, because what makes an assessment answer a question is its basis and never its conclusion.
//
// It is pure over its two arguments, so the same assessment and the same question always give the
// same answer, and freezing one into a JSON envelope changes nothing.
import type { ExpectationRevisionRef } from '@orcaops/storage';

/** One identified input, as both the contract and the assessment reader spell one. */
export interface AssessedInput {
  readonly kind: string;
  readonly identity: string;
}

/**
 * The software a judgment is about, with the conditions it is about it under, or its explicit
 * absence. It is the contract's own `SelectedImplementation` read structurally, so a record the
 * store decoded and one a command line named reach this the same way.
 */
export type AssessedSoftware =
  | {
      readonly kind: 'selected';
      readonly inputs: readonly AssessedInput[];
      readonly environment: string | null;
    }
  | { readonly kind: 'none_selected' };

/** A method and the configuration that made it what it was, as the contract records both. */
export interface AssessmentMethod {
  readonly name: string;
  readonly configuration_sha256: string | null;
}

/** An observation or an earlier assessment an assessment weighed, and how it weighed it. */
export interface AssessmentEvidenceRef {
  readonly kind: string;
  readonly id: string;
  readonly role: string;
}

/** What became of a check. Never a conclusion, here or in the store. */
export interface AssessmentCheckState {
  readonly check: string;
  readonly state: string;
}

/**
 * One assessment's judgment about one expectation revision, with the basis it rests on.
 *
 * `write_sequence` is when this history committed the assessment; `observed_write_sequence` and
 * `observed_intent_counter` are what the assessment itself read. They are three separate numbers
 * and nothing here collapses them: an assessment's staleness is judged against what it stamped,
 * and when it was written says nothing about what it saw.
 */
export interface AssessedBasis {
  readonly assessment_id: string;
  /** The exact revision this judgment is about, and the conclusion it reached about that one. */
  readonly expectation: ExpectationRevisionRef;
  readonly conclusion: string;
  /** The software it judged and the conditions it judged them under, or their explicit absence. */
  readonly implementation: AssessedSoftware;
  readonly method: AssessmentMethod;
  readonly exception_ids: readonly string[];
  readonly evidence: readonly AssessmentEvidenceRef[];
  readonly check_states: readonly AssessmentCheckState[];
  readonly observed_write_sequence: number;
  readonly observed_intent_counter: number;
  readonly write_sequence: number;
}

/**
 * The question an assessment is measured against. Every part but the expectations is nullable, and
 * `null` means the question named none — which is `unknown`, never a match. A question that named
 * no software cannot make any assessment apply, because reading one as satisfaction of unspecified
 * software is the claim the whole contract refuses.
 */
export interface AssessmentRelevanceQuestion {
  /** The software and conditions asked about, or null when the question names none. */
  readonly implementation: AssessedSoftware | null;
  /** The expectation revisions in force for this question. Empty means none is. */
  readonly expectations: readonly ExpectationRevisionRef[];
  /** The exceptions in force, or null when the question names none. */
  readonly exception_ids: readonly string[] | null;
  /** The method asked for, or null when the question names none. */
  readonly method: AssessmentMethod | null;
  /** The evidence in force, or null when the question names none. */
  readonly evidence: readonly AssessmentEvidenceRef[] | null;
  /** The project's intent counter now, or null when the question does not name it. */
  readonly intent_counter: number | null;
}

/**
 * `expectations` is whether the assessment concluded about a revision this question names, and
 * `intent` is whether the project's recorded intent has advanced since the assessment stamped the
 * counter it observed — the contract's conservative eligibility signal, kept apart from the exact
 * revision comparison because it says that something changed and never which thing.
 */
export type RelevanceDimension =
  | 'expectations'
  | 'intent'
  | 'software'
  | 'conditions'
  | 'exceptions'
  | 'method'
  | 'evidence';

const DIMENSIONS: readonly RelevanceDimension[] = [
  'expectations',
  'intent',
  'software',
  'conditions',
  'exceptions',
  'method',
  'evidence',
];

/** `unknown` is a dimension nobody supplied. It is never read as a match and never as a waiver. */
export type DimensionMatch = 'matches' | 'differs' | 'unknown';

export interface AssessmentRelevanceDimension {
  readonly dimension: RelevanceDimension;
  readonly match: DimensionMatch;
  /** What differs, or what nobody named. Null only when the dimension matches. */
  readonly detail: string | null;
}

/**
 * - `applies`: every dimension matches, so the assessment's conclusion is about this question.
 * - `historical`: it concluded about an expectation revision this question does not name. It is
 *   preserved and shown under its own expectation, and it is never a present conclusion here.
 * - `insufficient_for_a_new_claim`: it concluded about an expectation this question names, and
 *   part of its basis differs or was never named. That is a verification gap, not a defect.
 */
export type AssessmentRelevanceOutcome = 'applies' | 'historical' | 'insufficient_for_a_new_claim';

export interface AssessmentRelevance {
  readonly assessment_id: string;
  readonly outcome: AssessmentRelevanceOutcome;
  readonly dimensions: readonly AssessmentRelevanceDimension[];
  /** The dimensions that differ, in the order above. What changed, by name. */
  readonly changed: readonly RelevanceDimension[];
  /** The dimensions the question placed no constraint on. Never read as agreement. */
  readonly unstated: readonly RelevanceDimension[];
  /** The software the assessment judged: an identity a person or a runner supplied, not a time. */
  readonly software_snapshot: AssessedSoftware;
  readonly statement: string;
}

const revisionKey = (ref: ExpectationRevisionRef) =>
  `${ref.kind}:${ref.entity_id}:${ref.revision_id}`;

type SelectedInputs = Extract<AssessedSoftware, { kind: 'selected' }>['inputs'];

const inputText = (inputs: SelectedInputs) =>
  inputs
    .map((input) => `${input.kind} ${input.identity}`)
    .sort()
    .join(', ');

const sameSet = (left: readonly string[], right: readonly string[]) => {
  const l = [...left].sort();
  const r = [...right].sort();
  return l.length === r.length && l.every((value, index) => value === r[index]);
};

const named = (values: readonly string[]) => (values.length === 0 ? 'none' : values.join(', '));

const matches = (dimension: RelevanceDimension): AssessmentRelevanceDimension => ({
  dimension,
  match: 'matches',
  detail: null,
});

const differs = (dimension: RelevanceDimension, detail: string): AssessmentRelevanceDimension => ({
  dimension,
  match: 'differs',
  detail,
});

const unknown = (dimension: RelevanceDimension, detail: string): AssessmentRelevanceDimension => ({
  dimension,
  match: 'unknown',
  detail,
});

function expectationsDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  if (question.expectations.length === 0)
    return unknown(
      'expectations',
      'This question names no expectation revision in force, so nothing says whether this ' +
        'assessment is about it.'
    );
  const asked = question.expectations.map(revisionKey);
  if (asked.includes(revisionKey(basis.expectation))) return matches('expectations');
  return differs(
    'expectations',
    `It concluded about revision ${basis.expectation.revision_id}; this question is about ` +
      `${question.expectations.map((ref) => ref.revision_id).join(', ')}.`
  );
}

function intentDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  if (question.intent_counter === null)
    return unknown('intent', 'This question names no current intent counter.');
  if (question.intent_counter <= basis.observed_intent_counter) return matches('intent');
  return differs(
    'intent',
    `Recorded intent has changed ${question.intent_counter - basis.observed_intent_counter} ` +
      `time(s) since this assessment observed counter ${basis.observed_intent_counter}. That is a ` +
      `conservative signal that expectations moved; it does not say which one.`
  );
}

function softwareDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  const asked = question.implementation;
  if (asked === null)
    return unknown(
      'software',
      'This question named no software, so no assessment here is read as satisfaction of it.'
    );
  const judged = basis.implementation;
  if (asked.kind === 'none_selected' && judged.kind === 'none_selected') return matches('software');
  if (asked.kind === 'none_selected')
    return differs(
      'software',
      `This question is about no identified software; the assessment judged ` +
        `${implementationText(judged)}.`
    );
  if (judged.kind === 'none_selected')
    return differs(
      'software',
      `The assessment identified no software; this question is about ${inputText(asked.inputs)}.`
    );
  const held = judged.inputs.map((input) => `${input.kind}:${input.identity}`);
  const wanted = asked.inputs.map((input) => `${input.kind}:${input.identity}`);
  return sameSet(held, wanted)
    ? matches('software')
    : differs(
        'software',
        `The assessment judged ${inputText(judged.inputs)}; this question is about ` +
          `${inputText(asked.inputs)}.`
      );
}

/**
 * Conditions live inside the contract's selected implementation, so an assessment that identified
 * no software recorded no conditions either and this stays unknown rather than matching by default.
 */
function conditionsDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  const asked = question.implementation;
  if (asked === null) return unknown('conditions', 'This question named no conditions.');
  if (asked.kind === 'none_selected' || basis.implementation.kind === 'none_selected')
    return unknown(
      'conditions',
      'Conditions are recorded with identified software, and one side here identified none.'
    );
  if (asked.environment === basis.implementation.environment) return matches('conditions');
  return differs(
    'conditions',
    `The assessment judged under ${basis.implementation.environment ?? 'no recorded environment'}; ` +
      `this question is about ${asked.environment ?? 'no recorded environment'}.`
  );
}

function exceptionsDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  if (question.exception_ids === null)
    return unknown('exceptions', 'This question names no exceptions in force.');
  return sameSet(basis.exception_ids, question.exception_ids)
    ? matches('exceptions')
    : differs(
        'exceptions',
        `The assessment was made with exception(s) ${named([...basis.exception_ids].sort())} in ` +
          `force; this question names ${named([...question.exception_ids].sort())}.`
      );
}

function methodDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  const asked = question.method;
  if (asked === null) return unknown('method', 'This question names no method.');
  if (
    asked.name === basis.method.name &&
    asked.configuration_sha256 === basis.method.configuration_sha256
  )
    return matches('method');
  return differs(
    'method',
    `The assessment used ${basis.method.name} ` +
      `(configuration ${basis.method.configuration_sha256 ?? 'unrecorded'}); this question is ` +
      `about ${asked.name} (configuration ${asked.configuration_sha256 ?? 'unrecorded'}).`
  );
}

const evidenceKey = (ref: AssessmentEvidenceRef) => `${ref.kind}:${ref.id}`;

function evidenceDimension(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevanceDimension {
  const asked = question.evidence;
  if (asked === null) return unknown('evidence', 'This question names no evidence in force.');
  return sameSet(basis.evidence.map(evidenceKey), asked.map(evidenceKey))
    ? matches('evidence')
    : differs(
        'evidence',
        `The assessment weighed ${named(basis.evidence.map(evidenceKey).sort())}; this question ` +
          `names ${named(asked.map(evidenceKey).sort())}.`
      );
}

const JUDGES: Readonly<
  Record<
    RelevanceDimension,
    (basis: AssessedBasis, question: AssessmentRelevanceQuestion) => AssessmentRelevanceDimension
  >
> = {
  expectations: expectationsDimension,
  intent: intentDimension,
  software: softwareDimension,
  conditions: conditionsDimension,
  exceptions: exceptionsDimension,
  method: methodDimension,
  evidence: evidenceDimension,
};

/**
 * What stops an assessment applying.
 *
 * A dimension that **differs** always does: the assessment judged something else. A dimension the
 * question left **unstated** does not, with one exception — the software. The question places no
 * constraint on the method or the evidence, so an assessment's own method is part of the basis it
 * answers with; but a question that named no software has no software for an assessment to be
 * about, and letting one apply there is precisely the satisfaction claim against unspecified
 * software §8 refuses.
 */
const blocksApplying = (entry: AssessmentRelevanceDimension): boolean =>
  entry.match === 'differs' || (entry.dimension === 'software' && entry.match === 'unknown');

function statementFor(
  basis: AssessedBasis,
  outcome: AssessmentRelevanceOutcome,
  dimensions: readonly AssessmentRelevanceDimension[]
): string {
  const blocking = dimensions.filter(blocksApplying);
  const details = blocking.map((entry) => `${entry.dimension}: ${entry.detail ?? ''}`).join(' ');
  if (outcome === 'applies')
    return (
      `Every part of this assessment's basis that this question constrains is the one it asks ` +
      `about, so its conclusion (${basis.conclusion}) is about this question.`
    );
  if (outcome === 'historical')
    return (
      `This assessment concluded ${basis.conclusion} about another expectation revision, so it is ` +
      `historical here: it is preserved with its own basis and shown under the revision it ` +
      `judged, and it is not a conclusion about this question. ${details}`
    );
  return (
    `This assessment concluded ${basis.conclusion} about this expectation under a different ` +
    `basis, so it is insufficient for a new claim: that is a verification gap, not an ` +
    `established defect, and it neither blocks work nor starts corrective work. ${details}`
  );
}

/**
 * Whether this assessment answers this question, dimension by dimension.
 *
 * The outcome turns on the basis and never on the conclusion: an assessment that found a
 * contradiction against release 0.2.1 is exactly as `historical` for a question about 0.3.0 as one
 * that found support, which is what "old evidence is not a new defect" means when it is code.
 */
export function assessmentRelevance(
  basis: AssessedBasis,
  question: AssessmentRelevanceQuestion
): AssessmentRelevance {
  const dimensions = DIMENSIONS.map((dimension) => JUDGES[dimension](basis, question));
  const expectations = dimensions[0] as AssessmentRelevanceDimension;
  const outcome: AssessmentRelevanceOutcome =
    expectations.match !== 'matches'
      ? 'historical'
      : dimensions.some(blocksApplying)
        ? 'insufficient_for_a_new_claim'
        : 'applies';
  return {
    assessment_id: basis.assessment_id,
    outcome,
    dimensions,
    changed: dimensions
      .filter((entry) => entry.match === 'differs')
      .map((entry) => entry.dimension),
    unstated: dimensions
      .filter((entry) => entry.match === 'unknown')
      .map((entry) => entry.dimension),
    software_snapshot: basis.implementation,
    statement: statementFor(basis, outcome, dimensions),
  };
}

/**
 * What a later assessment did to the report before it. None of these members is refutation, and
 * that is the rule rather than an omission: a run establishes what it observed and nothing else,
 * a check that was skipped or errored establishes less than that, and a fix at a later snapshot is
 * not evidence that the earlier report was false about its own inputs.
 */
export type PriorReportEffect =
  /** It judged other software, other conditions or another method. */
  | 'observed_another_basis'
  /** It judged the same basis at a later time. */
  | 'observed_the_same_basis_later'
  /** It reached no conclusion, so it bears on the earlier report not at all. */
  | 'observed_nothing';

export interface PriorReportStanding {
  readonly prior_assessment_id: string;
  readonly later_assessment_id: string;
  readonly expectation: ExpectationRevisionRef;
  readonly effect: PriorReportEffect;
  /** The earlier conclusion, unchanged. A later assessment never rewrites it. */
  readonly prior_conclusion: string;
  readonly later_conclusion: string;
  readonly statement: string;
}

const NO_CONCLUSION: readonly string[] = ['unresolved', 'not_assessed'];

/**
 * How a later assessment of the same expectation stands beside an earlier one.
 *
 * Callers pass two assessments of the same expectation revision, oldest first. The answer says
 * what the later one observed; it never says the earlier one was wrong, because nothing an
 * assessment can record would establish that.
 */
export function priorReportStanding(
  prior: AssessedBasis,
  later: AssessedBasis
): PriorReportStanding {
  const question: AssessmentRelevanceQuestion = {
    implementation: later.implementation,
    expectations: [later.expectation],
    exception_ids: later.exception_ids,
    method: later.method,
    evidence: null,
    intent_counter: null,
  };
  const relevance = assessmentRelevance(prior, question);
  const sameBasis = !relevance.changed.some(
    (dimension) => dimension === 'software' || dimension === 'conditions' || dimension === 'method'
  );
  const idle = NO_CONCLUSION.includes(later.conclusion);
  const effect: PriorReportEffect = idle
    ? 'observed_nothing'
    : sameBasis
      ? 'observed_the_same_basis_later'
      : 'observed_another_basis';
  return {
    prior_assessment_id: prior.assessment_id,
    later_assessment_id: later.assessment_id,
    expectation: prior.expectation,
    effect,
    prior_conclusion: prior.conclusion,
    later_conclusion: later.conclusion,
    statement: successionStatement(prior, later, effect),
  };
}

function successionStatement(
  prior: AssessedBasis,
  later: AssessedBasis,
  effect: PriorReportEffect
): string {
  const idleChecks = later.check_states.map((state) => `${state.check} (${state.state})`);
  const unheld =
    idleChecks.length === 0 ? '' : ` Its check(s) ${idleChecks.join(', ')} established nothing.`;
  const kept =
    `The earlier report stands as a report about its own inputs: ` +
    `${implementationText(prior.implementation)}, concluding ${prior.conclusion}.`;
  if (effect === 'observed_nothing')
    return (
      `The later assessment reached no conclusion (${later.conclusion}), so it establishes ` +
      `nothing about this expectation and refutes nothing.${unheld} ${kept}`
    );
  if (effect === 'observed_another_basis')
    return (
      `The later assessment observed ${implementationText(later.implementation)} and concluded ` +
      `${later.conclusion}. It establishes only what it observed; a result at another basis is ` +
      `not evidence that the earlier report was wrong.${unheld} ${kept}`
    );
  return (
    `The later assessment observed the same basis at a later time and concluded ` +
    `${later.conclusion}. It establishes only what that run observed, and never refutes the ` +
    `earlier report.${unheld} ${kept}`
  );
}

export const implementationText = (implementation: AssessedSoftware): string =>
  implementation.kind === 'none_selected'
    ? 'no identified software'
    : `${inputText(implementation.inputs)}` +
      `${implementation.environment === null ? '' : ` under ${implementation.environment}`}`;
