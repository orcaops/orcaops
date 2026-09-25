// What the record says about one expectation revision's evidence at a knowledge boundary.
//
// Expectation lookup shows a previously recorded assessment with its own basis — the software it
// identified, the evidence it weighed and the conclusion it reached about this revision — never as
// satisfaction of unspecified software. An assessment with no implementation selected says so in
// the answer rather than being hidden, because a reader that dropped it would turn the absence of
// an identified input into the absence of an assessment.
//
// The filter is on the input: an assessment published after the boundary is left out of the answer
// and named in `later` beside it. That is a field of this reader's own rather than the resolver's
// `later_annotations`, which `coverage` carries: those are typed on `KnowledgeRecordKind`, which
// has no `assessment` member, and adding one is a change to the resolution contract. So
// `coverage.later` is empty here, and an expectation with a newer assessment still never reads
// like one with none.
import { type ProjectReadView } from './connection.js';
import {
  assessmentColumns,
  type AssessmentSelection,
  decodeAssessment,
  type ProjectAssessmentRow,
} from './knowledge-assessments.js';
import { type KnowledgeReadCoverage, knowledgeReadCoverage } from './knowledge-read-boundary.js';
import { type ExpectationRevisionRef } from '../../schema/knowledge-contract.js';
import { type KnowledgeReadRequest } from '../../schema/knowledge-resolution.js';

export interface ProjectExpectationAssessment extends ProjectAssessmentRow {
  /** What this assessment concluded about this expectation, and about no other. */
  readonly conclusion: string;
  readonly writeSequence: number;
  /** The exceptions in force when it judged, which are part of the basis it judged under. */
  readonly exceptionIds: readonly string[];
  readonly coverageLimits: readonly string[];
}

export interface ProjectExpectationAssessments {
  readonly expectation: ExpectationRevisionRef;
  readonly coverage: KnowledgeReadCoverage;
  /** Oldest first, so the reasons read in the order somebody reached them. */
  readonly assessments: readonly ProjectExpectationAssessment[];
  /** Assessments of this expectation published after the boundary, by id. */
  readonly later: readonly string[];
}

type ExpectationAssessmentSelection = AssessmentSelection & {
  conclusion: string;
  write_sequence: number;
};

/**
 * The exceptions and coverage limits the authored record holds. Neither has a lookup column —
 * nothing looks an assessment up by either — so they are read back out of the retained bytes the
 * row already carries. A record this build cannot read yields empty lists rather than a throw: the
 * bytes are what somebody authored, and a reader that refused them would hide the assessment.
 */
function payloadBasis(recordHex: string): {
  exceptionIds: string[];
  coverageLimits: string[];
} {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(recordHex, 'hex').toString('utf8'));
  } catch {
    return { exceptionIds: [], coverageLimits: [] };
  }
  const record = (value ?? {}) as Record<string, unknown>;
  const texts = (held: unknown) =>
    Array.isArray(held) ? held.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    exceptionIds: texts(record.exception_ids),
    coverageLimits: texts(record.coverage_limits),
  };
}

export function readProjectExpectationAssessments(
  view: ProjectReadView,
  expectation: ExpectationRevisionRef,
  request: KnowledgeReadRequest
): ProjectExpectationAssessments {
  const rows = view.all<ExpectationAssessmentSelection>(
    `SELECT ${assessmentColumns('a')}, c.conclusion, o.committed_write_sequence AS write_sequence
       FROM knowledge_assessment_conclusions c
       JOIN knowledge_assessments a ON a.assessment_id=c.assessment_id
       JOIN operations o ON o.operation_id=a.operation_id
      WHERE c.expectation_kind=? AND c.expectation_id=? AND c.expectation_revision_id=?
      ORDER BY o.committed_write_sequence, a.assessment_id`,
    expectation.kind,
    expectation.entity_id,
    expectation.revision_id
  );
  const visible = rows.filter((row) => row.write_sequence <= request.knowledge_boundary);
  return {
    expectation,
    coverage: knowledgeReadCoverage(request, []),
    assessments: visible.map((row) => ({
      ...decodeAssessment(view, row),
      conclusion: row.conclusion,
      writeSequence: row.write_sequence,
      ...payloadBasis(row.record_hex),
    })),
    later: rows
      .filter((row) => row.write_sequence > request.knowledge_boundary)
      .map((row) => row.assessment_id),
  };
}
