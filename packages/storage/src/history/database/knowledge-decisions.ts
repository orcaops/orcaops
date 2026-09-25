// Publishing a revision of a continuing decision: the chosen approach with its rationale,
// alternatives, assumptions and reconsideration conditions, and the standing, subject and
// attribution a released row never recorded.
//
// The name says `continuing` because `publishProjectDecisionRevision` in
// `exact-revision-records.ts` is the writer that reproduces released-shaped rows and must not
// gain callers; this is the one that records standing, basis and attribution.
//
// A decision revision is located by the frozen occurrence tuple its released table carries, which
// the payload itself has no room for. The occurrence argument therefore names one of the
// revision's own passages, so the source and location columns stay copies of authored content;
// only the position is the store's, allocated so a successor restating the same statement from
// the same place never collides with the revision it continues. The contract requires at least
// one passage for exactly this reason, so there is always an authored location to key on.
//
// A decision's identity row carries nothing, so where a derived decision came from lives on the
// revision that mints the identity. The parent revision is read inside the transaction; a caller
// never gets to name one the store does not hold.
import { z } from 'zod';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireInterpretationSupport } from './knowledge-interpretations.js';
import {
  actingField,
  advancesIntent,
  attributionColumns,
  type AuthoredRecord,
  authoredRecord,
  invalid,
  LabelSchema,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  RecordIdSchema,
  replayOperation,
  requireRetainedSources,
  requireRetainedSubject,
  requireRevisionContinues,
  retainedExpectationRevision,
  retriedOperation,
  revisionLineage,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import { runProjectOperation } from './transactions.js';
import {
  type Attribution,
  type DecisionRevision,
  DecisionRevisionSchema,
} from '../../schema/knowledge-contract.js';

const DecisionOccurrenceSchema = z.strictObject({
  source_id: RecordIdSchema,
  location: LabelSchema,
});

/** Which of the revision's own passages the statement is, without the allocated position. */
export type DecisionOccurrence = z.infer<typeof DecisionOccurrenceSchema>;

export interface PublishContinuingDecisionRevision {
  readonly operationId: string;
  /** The revision as authored, without `attributed_to`. */
  readonly revision: unknown;
  /** Who this revision is by, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  readonly occurrence: DecisionOccurrence;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type DecisionRevisionPublication = {
  decisionId: string;
  revisionId: string;
  recordSha256: string;
  occurrence: { sourceId: string; location: string; position: number };
};

export interface PreparedDecisionRevision {
  readonly revision: DecisionRevision;
  readonly occurrence: DecisionOccurrence;
  readonly record: AuthoredRecord;
}

export function prepareProjectDecisionRevision(
  input: Omit<PublishContinuingDecisionRevision, 'operationId'>
): PreparedDecisionRevision {
  const revision = parsed(
    DecisionRevisionSchema,
    actingField(input.revision, 'attributed_to', input.attributedTo),
    'A decision revision'
  );
  const occurrence = parsed(DecisionOccurrenceSchema, input.occurrence, 'A decision occurrence');
  if (
    !revision.passages.some(
      (passage) =>
        passage.source_id === occurrence.source_id && passage.location === occurrence.location
    )
  )
    invalid('A decision revision occurs at one of the passages it restates');
  return {
    revision,
    occurrence,
    record: authoredRecord(revision, secretAllowList(input.secretAllow)),
  };
}

/** Everything the store decides, run before the operation starts and again inside it. */
export function checkProjectDecisionRevision(
  view: ProjectReadView,
  prepared: PreparedDecisionRevision
): void {
  const { revision } = prepared;
  if (
    view.get('SELECT revision_id FROM decision_revisions WHERE revision_id=?', revision.revision_id)
  )
    taken('That decision revision ID already belongs to retained history');
  requireRetainedSources(view, [
    ...revision.source_ids,
    ...revision.passages.map((passage) => passage.source_id),
    ...(revision.derivation === null ? [] : [revision.derivation.source_id]),
  ]);
  requireRetainedSubject(view, revision.subject);
  requireInterpretationSupport(
    view,
    'decision',
    revision.decision_id,
    revision.revision_id,
    revision.interpretation,
    revision.passages
  );
  if (
    revision.derivation !== null &&
    !retainedExpectationRevision(view, revision.derivation.derived_from)
  )
    missing('The expectation revision this decision derives from is not retained');
  requireRevisionContinues(
    revisionLineage(view, 'decision_revisions', 'decision_id', revision.decision_id),
    revision
  );
}

/** The in-transaction writer, so a caller's own operation can publish the revision it derived. */
export function settleProjectDecisionRevision(
  transaction: ProjectSettlement,
  operationId: string,
  prepared: PreparedDecisionRevision
): DecisionRevisionPublication {
  checkProjectDecisionRevision(transaction, prepared);
  const { revision, occurrence, record } = prepared;
  const sourceId = occurrence.source_id;
  const used = transaction.get<{ next: number }>(
    'SELECT ifnull(max(position),-1)+1 AS next FROM decision_revisions WHERE source_event_id=? AND field_path=?',
    sourceId,
    occurrence.location
  );
  const position = used ? used.next : 0;
  const [kind, name, basis] = attributionColumns(revision.attributed_to);
  const parent = revision.derivation === null ? null : revision.derivation.derived_from;
  transaction.run(
    `INSERT INTO decision_revisions (revision_id, decision_id, previous_revision_id,
       source_event_id, field_path, position, authored_by, attributed_kind, attributed_basis,
       source_standing, subject_id, subject_revision_id,
       derived_from_kind, derived_from_id, derived_from_revision_id, alternative_count,
       record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    revision.revision_id,
    revision.decision_id,
    revision.previous_revision_id,
    sourceId,
    occurrence.location,
    position,
    name,
    kind,
    basis,
    revision.source_standing,
    revision.subject === null ? null : revision.subject.subject_id,
    revision.subject === null ? null : revision.subject.subject_revision_id,
    parent === null ? null : parent.kind,
    parent === null ? null : parent.entity_id,
    parent === null ? null : parent.revision_id,
    revision.alternatives.length,
    record.bytes,
    record.sha256,
    operationId
  );
  if (revision.previous_revision_id === null)
    transaction.run(
      'INSERT INTO decisions (decision_id, first_revision_id, operation_id) VALUES (?,?,?)',
      revision.decision_id,
      revision.revision_id,
      operationId
    );
  return {
    decisionId: revision.decision_id,
    revisionId: revision.revision_id,
    recordSha256: record.sha256,
    occurrence: { sourceId, location: occurrence.location, position },
  };
}

export async function publishProjectContinuingDecisionRevision(
  handle: ProjectDatabase,
  input: PublishContinuingDecisionRevision,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const prepared = prepareProjectDecisionRevision(input);
  const { revision, occurrence, record } = prepared;
  const op = {
    operationId,
    kind: 'knowledge.decision.revision.publish',
    target: { decisionId: revision.decision_id, revisionId: revision.revision_id },
    // The occurrence names an authored passage, so it takes part in retry equality; the position
    // does not, because the store allocates it rather than taking the caller's word.
    payload: {
      record: record.sha256,
      occurrence: { sourceId: occurrence.source_id, location: occurrence.location },
    },
    expectedState: { previousRevisionId: revision.previous_revision_id },
    intentChange: advancesIntent(revision.attributed_to),
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    checkProjectDecisionRevision(view, prepared);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): DecisionRevisionPublication =>
      settleProjectDecisionRevision(transaction, operationId, prepared),
    options
  );
}
