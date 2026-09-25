// Publishing a task-independent assessment: exact expectation revisions and the exceptions in
// force, the software inputs it judged or their explicit absence, the evidence it weighed, and one
// conclusion per expectation with its reason.
//
// It names no task, artifact or pull request: a release, build or commit is assessed on its own,
// and the subject reached through the expectation revisions it names. An assessment with no
// implementation selected concludes unresolved or not assessed and never borrows the current
// checkout — the conclusions table refuses a satisfaction claim against unidentified software
// whatever this writer does.
//
// Execution errors, skipped checks, missing inputs and stale evidence are states of the checks and
// live in a table of their own, so nothing can read one as a conclusion.
//
// An assessment stamps the counters it observed. It never advances the intent counter: making
// every earlier assessment eligible again is what a real change of intent does, and an assessment
// that did it would invalidate itself.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { type InputIdentity, unretainedObservations } from './knowledge-observations.js';
import { knowledgeBoundaryAt } from './knowledge-read-boundary.js';
import {
  actingField,
  authoredRecord,
  integrity,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  retainedExpectationRevision,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import { runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Actor,
  type Assessment,
  AssessmentSchema,
  type ExpectationRevisionRef,
} from '../../schema/knowledge-contract.js';

export interface PublishAssessment {
  readonly operationId: string;
  /** The assessment as authored, without `assessor`. */
  readonly assessment: unknown;
  /** Who assessed it, which a publishing session will own once storage has one. */
  readonly assessedBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type AssessmentPublication = {
  assessmentId: string;
  recordSha256: string;
};

/** The intent counter as committed, which is the most an assessment can honestly have observed. */
function committedIntentCounter(view: ProjectReadView): number {
  const row = view.get<{ intent_change_counter: number }>(
    'SELECT intent_change_counter FROM project_counters WHERE singleton = 1'
  );
  if (row === null || !Number.isSafeInteger(row.intent_change_counter))
    integrity(
      'The project intent counter is missing or outside the safe integer range; explicit repair is required'
    );
  return row.intent_change_counter;
}

function requireRetainedEvidence(view: ProjectReadView, assessment: Assessment): void {
  const observations = assessment.evidence
    .filter((entry) => entry.source.kind === 'observation')
    .map((entry) => (entry.source as { observation_id: string }).observation_id);
  if (unretainedObservations(view, observations).length)
    missing('The assessment weighs an observation this history does not hold');
  for (const entry of assessment.evidence)
    if (
      entry.source.kind === 'assessment' &&
      !view.get(
        'SELECT assessment_id FROM knowledge_assessments WHERE assessment_id=?',
        entry.source.assessment_id
      )
    )
      missing('The assessment weighs an earlier assessment this history does not hold');
}

export async function publishProjectKnowledgeAssessment(
  handle: ProjectDatabase,
  input: PublishAssessment,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const assessment = parsed(
    AssessmentSchema,
    actingField(input.assessment, 'assessor', input.assessedBy),
    'An assessment'
  );
  const record = authoredRecord(assessment, secretAllowList(input.secretAllow));
  const op = {
    operationId,
    kind: 'knowledge.assessment.publish',
    target: { assessmentId: assessment.assessment_id },
    payload: { record: record.sha256 },
    // An assessment changes nothing that stands, so there is no selection for it to observe. What
    // it read is the counters it stamps, and whether those are still current is a later reader's
    // judgment rather than a refusal here.
    expectedState: null,
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const check = (view: ProjectReadView) => {
    if (
      view.get(
        'SELECT assessment_id FROM knowledge_assessments WHERE assessment_id=?',
        assessment.assessment_id
      )
    )
      taken('That assessment ID already belongs to retained history');
    // Counters this history has not committed are not ones anybody observed. Both are guarded:
    // an assessment's staleness is judged against what it stamped, so a stamp beyond the store
    // would read as evidence of a later state than any that has ever existed here.
    if (assessment.observed_write_sequence > knowledgeBoundaryAt(view))
      invalid(
        'An assessment stamps counters it observed; this write sequence is later than the one this history has committed'
      );
    if (assessment.observed_intent_counter > committedIntentCounter(view))
      invalid(
        'An assessment stamps counters it observed; this intent counter is later than the one this history has committed'
      );
    for (const expectation of assessment.expectations)
      if (!retainedExpectationRevision(view, expectation))
        missing('The assessment names an expectation revision this history does not hold');
    for (const exceptionId of assessment.exception_ids)
      if (
        !view.get('SELECT exception_id FROM knowledge_exceptions WHERE exception_id=?', exceptionId)
      )
        missing('The assessment names an exception this history does not hold');
    requireRetainedEvidence(view, assessment);
  };
  handle.read((view) => {
    check(view);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): AssessmentPublication => {
      check(transaction);
      const implementation = assessment.implementation;
      transaction.run(
        `INSERT INTO knowledge_assessments (assessment_id, assessed_by, assessed_by_basis,
           method_name, method_configuration_sha256, implementation_kind,
           implementation_inputs_json, environment, observed_write_sequence,
           observed_intent_counter, record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        assessment.assessment_id,
        assessment.assessor.identity,
        assessment.assessor.basis,
        assessment.method.name,
        assessment.method.configuration_sha256,
        implementation.kind,
        implementation.kind === 'selected' ? canonicalJson(implementation.inputs) : null,
        implementation.kind === 'selected' ? implementation.environment : null,
        assessment.observed_write_sequence,
        assessment.observed_intent_counter,
        record.bytes,
        record.sha256,
        operationId
      );
      assessment.conclusions.forEach((entry, position) =>
        transaction.run(
          `INSERT INTO knowledge_assessment_conclusions (assessment_id, position, expectation_kind,
             expectation_id, expectation_revision_id, conclusion, operation_id)
           VALUES (?,?,?,?,?,?,?)`,
          assessment.assessment_id,
          position,
          entry.expectation.kind,
          entry.expectation.entity_id,
          entry.expectation.revision_id,
          entry.conclusion,
          operationId
        )
      );
      assessment.evidence.forEach((entry, position) =>
        transaction.run(
          `INSERT INTO knowledge_assessment_evidence (assessment_id, position, evidence_kind,
             evidence_id, role, operation_id) VALUES (?,?,?,?,?,?)`,
          assessment.assessment_id,
          position,
          entry.source.kind,
          entry.source.kind === 'observation'
            ? entry.source.observation_id
            : entry.source.assessment_id,
          entry.role,
          operationId
        )
      );
      assessment.check_states.forEach((entry, position) =>
        transaction.run(
          `INSERT INTO knowledge_assessment_check_states (assessment_id, position, check_name,
             state, operation_id) VALUES (?,?,?,?,?)`,
          assessment.assessment_id,
          position,
          entry.check,
          entry.state,
          operationId
        )
      );
      return { assessmentId: assessment.assessment_id, recordSha256: record.sha256 };
    },
    options
  );
}

export interface ProjectAssessmentConclusion {
  readonly expectation: ExpectationRevisionRef;
  readonly conclusion: string;
}

export interface ProjectAssessmentEvidence {
  readonly kind: string;
  readonly id: string;
  readonly role: string;
}

/** Never a conclusion: what became of a check is a state of the check. */
export interface ProjectAssessmentCheckState {
  readonly check: string;
  readonly state: string;
}

export interface ProjectAssessmentRow {
  readonly assessmentId: string;
  readonly assessedBy: string | null;
  readonly assessedByBasis: string;
  readonly method: { name: string; configurationSha256: string | null };
  /** The software this assessment judged, or its explicit absence. */
  readonly implementation:
    | { kind: 'selected'; inputs: InputIdentity[]; environment: string | null }
    | { kind: 'none_selected' };
  readonly observedWriteSequence: number;
  readonly observedIntentCounter: number;
  readonly conclusions: ProjectAssessmentConclusion[];
  readonly evidence: ProjectAssessmentEvidence[];
  readonly checkStates: ProjectAssessmentCheckState[];
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export interface AssessmentSelection {
  assessment_id: string;
  assessed_by: string | null;
  assessed_by_basis: string;
  method_name: string;
  method_configuration_sha256: string | null;
  implementation_kind: string;
  implementation_inputs_json: string | null;
  environment: string | null;
  observed_write_sequence: number;
  observed_intent_counter: number;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

export const assessmentColumns = (from: string): string =>
  `${from}.assessment_id, ${from}.assessed_by, ${from}.assessed_by_basis, ${from}.method_name,
  ${from}.method_configuration_sha256, ${from}.implementation_kind,
  ${from}.implementation_inputs_json, ${from}.environment, ${from}.observed_write_sequence,
  ${from}.observed_intent_counter, hex(${from}.record_bytes) AS record_hex,
  ${from}.record_sha256, ${from}.operation_id`;

export function decodeAssessment(
  view: ProjectReadView,
  row: AssessmentSelection
): ProjectAssessmentRow {
  return {
    assessmentId: row.assessment_id,
    assessedBy: row.assessed_by,
    assessedByBasis: row.assessed_by_basis,
    method: { name: row.method_name, configurationSha256: row.method_configuration_sha256 },
    implementation:
      row.implementation_kind === 'selected'
        ? {
            kind: 'selected',
            inputs: JSON.parse(row.implementation_inputs_json ?? '[]') as InputIdentity[],
            environment: row.environment,
          }
        : { kind: 'none_selected' },
    observedWriteSequence: row.observed_write_sequence,
    observedIntentCounter: row.observed_intent_counter,
    conclusions: view
      .all<{
        expectation_kind: 'requirement' | 'decision';
        expectation_id: string;
        expectation_revision_id: string;
        conclusion: string;
      }>(
        `SELECT expectation_kind, expectation_id, expectation_revision_id, conclusion
           FROM knowledge_assessment_conclusions WHERE assessment_id=? ORDER BY position`,
        row.assessment_id
      )
      .map((entry) => ({
        expectation: {
          kind: entry.expectation_kind,
          entity_id: entry.expectation_id,
          revision_id: entry.expectation_revision_id,
        },
        conclusion: entry.conclusion,
      })),
    evidence: view
      .all<{ evidence_kind: string; evidence_id: string; role: string }>(
        `SELECT evidence_kind, evidence_id, role FROM knowledge_assessment_evidence
          WHERE assessment_id=? ORDER BY position`,
        row.assessment_id
      )
      .map((entry) => ({ kind: entry.evidence_kind, id: entry.evidence_id, role: entry.role })),
    checkStates: view
      .all<{ check_name: string; state: string }>(
        `SELECT check_name, state FROM knowledge_assessment_check_states
          WHERE assessment_id=? ORDER BY position`,
        row.assessment_id
      )
      .map((entry) => ({ check: entry.check_name, state: entry.state })),
    recordHex: row.record_hex,
    recordSha256: row.record_sha256,
    operationId: row.operation_id,
  };
}

export function readProjectKnowledgeAssessment(
  view: ProjectReadView,
  assessmentId: string
): ProjectAssessmentRow | null {
  const row = view.get<AssessmentSelection>(
    `SELECT ${assessmentColumns('a')} FROM knowledge_assessments a WHERE a.assessment_id=?`,
    assessmentId
  );
  return row ? decodeAssessment(view, row) : null;
}
