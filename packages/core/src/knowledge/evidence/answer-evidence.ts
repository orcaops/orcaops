// Previously recorded assessments, shown under the expectation they judged with their own basis.
//
// §7 allows exactly this and nothing more: "previously recorded assessments can be shown with
// their own basis, not as satisfaction of unspecified software". So every assessment here carries
// the software it identified or its explicit absence, the method, the environment, the evidence it
// weighed and the two counters it stamped, and beside that its relevance to the question this
// answer was asked with. A reader that wanted a conclusion has to look at `relevance.outcome`
// first, which is the point.
//
// **A question that named no software can make nothing apply.** That is not a degenerate case: it
// is the ordinary lookup, and it is why a certification question has to name the version it wants
// certified before any assessment here can answer it.
import type { ExpectationRevisionRef } from '@orcaops/storage';
import type { ProjectKnowledgeContextAssessment } from '@orcaops/storage/history/database';

import {
  type AssessedBasis,
  type AssessedSoftware,
  type AssessmentCheckState,
  type AssessmentEvidenceRef,
  type AssessmentMethod,
  type AssessmentRelevance,
  assessmentRelevance,
  implementationText,
  type PriorReportStanding,
  priorReportStanding,
  type RelevanceDimension,
} from './relevance.js';

/** What this answer was asked about, beside the scope and boundary its basis already names. */
export interface KnowledgeContextQuestion {
  /**
   * The software the question is about. `null` means nobody named any, which is not the same as
   * naming none: an assessment of unidentified software matches the second and never the first.
   */
  readonly software: AssessedSoftware | null;
  /** The project's intent counter at this read, or null when this read did not name it. */
  readonly intentCounter: number | null;
}

/** One assessment under the identity it judged, with the basis it judged on. */
export interface KnowledgeContextAssessment {
  readonly assessment_id: string;
  /** The exact revision of this identity it concluded about, and about no other. */
  readonly expectation: ExpectationRevisionRef;
  readonly conclusion: string;
  readonly assessed_by: string | null;
  readonly assessed_by_basis: string;
  readonly method: AssessmentMethod;
  /** The software it identified, or its explicit absence, with the conditions it judged under. */
  readonly implementation: AssessedSoftware;
  readonly evidence: readonly AssessmentEvidenceRef[];
  /** Never conclusions: what became of a check is a state of the check. */
  readonly check_states: readonly AssessmentCheckState[];
  readonly exception_ids: readonly string[];
  readonly coverage_limits: readonly string[];
  /** What it observed. Its staleness is judged against these, never against when it was written. */
  readonly observed_write_sequence: number;
  readonly observed_intent_counter: number;
  /** When this history committed it, which is a different number from the two above. */
  readonly write_sequence: number;
  readonly relevance: AssessmentRelevance;
}

/**
 * How much of one identity's evidence an answer carries.
 *
 * An identity can hold any number of assessments, and each carries its whole basis, so an unbounded
 * evidence block is the one part of an answer whose size nothing in the read decides.
 */
export interface KnowledgeContextEvidenceBounds {
  /** How many assessments of one identity, newest first. */
  readonly maxAssessments: number;
  /** How many bytes those assessments may take together. */
  readonly maxBytes: number;
}

export interface KnowledgeContextEvidence {
  /** Oldest first, so the reasons read in the order somebody reached them. */
  readonly assessments: readonly KnowledgeContextAssessment[];
  /** Ids of assessments of this identity published after the boundary. Named, never hidden. */
  readonly later: readonly string[];
  /** Ids the bounds left out, oldest first. Named, never silently dropped. */
  readonly omitted: readonly string[];
  /** What each later assessment did to the report before it. Never refutation. */
  readonly succession: readonly PriorReportStanding[];
  /** What this evidence establishes about the question, and what it does not. */
  readonly statement: string;
  /**
   * What would have to be established to answer this question, from what stopped the assessments
   * here applying. Empty when one applies.
   */
  readonly needed: readonly string[];
}

const basisOf = (held: ProjectKnowledgeContextAssessment): AssessedBasis => ({
  assessment_id: held.assessment.assessmentId,
  expectation: held.expectation,
  conclusion: held.assessment.conclusion,
  implementation: held.assessment.implementation,
  method: {
    name: held.assessment.method.name,
    configuration_sha256: held.assessment.method.configurationSha256,
  },
  exception_ids: held.assessment.exceptionIds,
  evidence: held.assessment.evidence,
  check_states: held.assessment.checkStates,
  observed_write_sequence: held.assessment.observedWriteSequence,
  observed_intent_counter: held.assessment.observedIntentCounter,
  write_sequence: held.assessment.writeSequence,
});

const surfaced = (
  held: ProjectKnowledgeContextAssessment,
  basis: AssessedBasis,
  relevance: AssessmentRelevance
): KnowledgeContextAssessment => ({
  assessment_id: basis.assessment_id,
  expectation: held.expectation,
  conclusion: basis.conclusion,
  assessed_by: held.assessment.assessedBy,
  assessed_by_basis: held.assessment.assessedByBasis,
  method: basis.method,
  implementation: basis.implementation,
  evidence: basis.evidence,
  check_states: basis.check_states,
  exception_ids: basis.exception_ids,
  coverage_limits: held.assessment.coverageLimits,
  observed_write_sequence: basis.observed_write_sequence,
  observed_intent_counter: basis.observed_intent_counter,
  write_sequence: basis.write_sequence,
  relevance,
});

const revisionKey = (ref: ExpectationRevisionRef) =>
  `${ref.kind}:${ref.entity_id}:${ref.revision_id}`;

/**
 * How one later assessment stands beside the one before it, per expectation revision.
 *
 * Consecutive pairs only: an assessment answers to the report it followed, and comparing every
 * pair would report the same rule N squared times without adding a fact.
 */
function successionOf(held: readonly ProjectKnowledgeContextAssessment[]): PriorReportStanding[] {
  const byExpectation = new Map<string, ProjectKnowledgeContextAssessment[]>();
  for (const entry of held) {
    const key = revisionKey(entry.expectation);
    byExpectation.set(key, [...(byExpectation.get(key) ?? []), entry]);
  }
  const standings: PriorReportStanding[] = [];
  for (const run of byExpectation.values())
    for (let index = 1; index < run.length; index += 1) {
      const prior = run[index - 1];
      const later = run[index];
      if (prior === undefined || later === undefined) continue;
      standings.push(priorReportStanding(basisOf(prior), basisOf(later)));
    }
  return standings;
}

const SOFTWARE_NOT_NAMED =
  'the software it judged, which this question did not name: no assessment is read as ' +
  'satisfaction of unspecified software';

/** What a question with no assessment of a revision in force would have to be answered by. */
function neededOfQuestion(
  question: KnowledgeContextQuestion,
  inForce: readonly ExpectationRevisionRef[]
): string[] {
  return [
    inForce.length === 0
      ? 'a revision of this identity in force at this read to conclude about'
      : `a conclusion about revision(s) ${inForce.map((ref) => ref.revision_id).join(', ')}`,
    question.software === null
      ? SOFTWARE_NOT_NAMED
      : `software ${implementationText(question.software)}`,
  ];
}

function reestablish(
  entry: KnowledgeContextAssessment,
  dimension: RelevanceDimension,
  question: KnowledgeContextQuestion
): string {
  if (dimension === 'intent')
    return (
      `the project's intent changed since this assessment; reassess against the expectation as it ` +
      `stands now, or record that the expectation is unchanged`
    );
  if (dimension === 'software')
    return (
      `${implementationText(entry.implementation)} was assessed, and this question is about ` +
      `${question.software === null ? 'no identified software' : implementationText(question.software)}`
    );
  const detail = entry.relevance.dimensions.find((held) => held.dimension === dimension)?.detail;
  return `${dimension} differs — ${detail ?? 'reassess under the basis this question names'}`;
}

/**
 * What an assessment that names a revision in force would have to re-establish, dimension by
 * dimension. Asking again for the revision and the software such an assessment already names would
 * ask for what it already gives; what is missing is the part of its basis that moved.
 */
function neededOfAssessments(
  question: KnowledgeContextQuestion,
  assessments: readonly KnowledgeContextAssessment[]
): string[] {
  const needed: string[] = [];
  for (const entry of assessments) {
    for (const dimension of entry.relevance.changed)
      needed.push(`assessment ${entry.assessment_id}: ${reestablish(entry, dimension, question)}`);
    if (entry.relevance.unstated.includes('software')) needed.push(SOFTWARE_NOT_NAMED);
  }
  return [...new Set(needed)];
}

/**
 * How many of the assessments an answer carries, counted from the newest.
 *
 * Newest first, because an older judgment of the same identity is the one a reader can most afford
 * to fetch by name; and whole assessments only, because half a basis is a conclusion without what
 * it rests on.
 */
function carried(
  assessments: readonly KnowledgeContextAssessment[],
  bounds: KnowledgeContextEvidenceBounds | undefined
): number {
  if (bounds === undefined) return assessments.length;
  let bytes = 0;
  let kept = 0;
  for (let index = assessments.length - 1; index >= 0; index -= 1) {
    if (kept >= bounds.maxAssessments) break;
    bytes += Buffer.byteLength(JSON.stringify(assessments[index]), 'utf8');
    if (bytes > bounds.maxBytes) break;
    kept += 1;
  }
  return kept;
}

function statementFor(
  question: KnowledgeContextQuestion,
  assessments: readonly KnowledgeContextAssessment[],
  applying: readonly KnowledgeContextAssessment[],
  omitted: readonly string[]
): string {
  const asked =
    question.software === null
      ? 'This question named no software'
      : `This question is about ${implementationText(question.software)}`;
  const left =
    omitted.length === 0
      ? ''
      : ` ${omitted.length} older assessment(s) of this identity are not carried here, so this ` +
        `answer says nothing about what they judged; they are named in its limits.`;
  if (assessments.length === 0 && omitted.length === 0)
    return (
      `${asked}, and this history holds no assessment of any revision of this identity. There is ` +
      `no applicable assessment, which is not a satisfaction claim and not a defect.`
    );
  if (assessments.length === 0)
    return `${asked}, and this answer carries none of this identity's assessments.${left}`;
  if (applying.length === 0)
    return (
      `${asked}. ${assessments.length} assessment(s) name a revision of this identity and none ` +
      `applies to it, so there is no applicable assessment. Each is preserved with its own basis ` +
      `and says what it judged; none of them is a present conclusion here, and none of them is a ` +
      `defect in the work being done now.${left}`
    );
  return (
    `${asked}. ${applying.length} of ${assessments.length} assessment(s) apply to it, each ` +
    `concluding about the exact revision and software it names.${left}`
  );
}

/**
 * The assessments of one identity, judged against the question this answer was asked with.
 *
 * `inForce` is the revisions of the identity this read treats as governing. An assessment of any
 * other revision is `historical`: it is carried, with its own basis, so a reader can see what was
 * judged and when, and it is never read as a conclusion about a revision it did not judge.
 */
export function knowledgeContextEvidence(input: {
  readonly assessments: readonly ProjectKnowledgeContextAssessment[];
  readonly later: readonly string[];
  readonly inForce: readonly ExpectationRevisionRef[];
  readonly question: KnowledgeContextQuestion;
  readonly bounds?: KnowledgeContextEvidenceBounds;
}): KnowledgeContextEvidence {
  const surfacedAll = input.assessments.map((held) => {
    const basis = basisOf(held);
    return surfaced(
      held,
      basis,
      assessmentRelevance(basis, {
        implementation: input.question.software,
        expectations: input.inForce,
        // The lookup names no exceptions, method or evidence of its own. Each stays `unknown`,
        // which is never a match, rather than being defaulted into agreement with whatever the
        // assessment happened to record.
        exception_ids: null,
        method: null,
        evidence: null,
        intent_counter: input.question.intentCounter,
      })
    );
  });
  const from = surfacedAll.length - carried(surfacedAll, input.bounds);
  const assessments = surfacedAll.slice(from);
  const omitted = surfacedAll.slice(0, from).map((entry) => entry.assessment_id);
  const applying = assessments.filter((entry) => entry.relevance.outcome === 'applies');
  // Only an assessment that concluded about a revision in force can say what would have to be
  // re-established; where none does, the question is all there is to name.
  const naming = assessments.filter(
    (entry) => entry.relevance.outcome === 'insufficient_for_a_new_claim'
  );
  return {
    assessments,
    later: input.later,
    omitted,
    succession: successionOf(input.assessments.slice(from)),
    statement: statementFor(input.question, assessments, applying, omitted),
    needed:
      applying.length > 0
        ? []
        : naming.length > 0
          ? neededOfAssessments(input.question, naming)
          : neededOfQuestion(input.question, input.inForce),
  };
}
