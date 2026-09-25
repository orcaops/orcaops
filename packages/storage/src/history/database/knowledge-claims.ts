// Publishing a revision of a continuing claim: the factual statement or finding, what it is
// about, the standing and attribution a released row never recorded, and — kept apart from the
// statement — whatever anybody reported about checking it.
//
// The name says `continuing` because `publishProjectClaimRevision` in `exact-revision-records.ts`
// is the writer that reproduces released-shaped rows and must not gain callers; this is the one
// that records standing, subject, basis and attribution.
//
// Like a decision revision, a claim revision is located by the frozen occurrence tuple its
// released table carries. The occurrence argument names one of the revision's own passages, so
// the source and location columns stay copies of authored content; only the position is the
// store's, allocated so a successor restating the same statement from the same place never
// collides with the revision it continues.
import { z } from 'zod';

import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireInterpretationSupport } from './knowledge-interpretations.js';
import { requireRetainedObservations } from './knowledge-observations.js';
import {
  actingField,
  advancesIntent,
  attributionColumns,
  type AuthoredRecord,
  authoredRecord,
  invalid,
  LabelSchema,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  RecordIdSchema,
  replayOperation,
  requireRetainedSources,
  requireRetainedSubject,
  requireRevisionContinues,
  retriedOperation,
  revisionLineage,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import { runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Attribution,
  type ClaimRevision,
  ClaimRevisionSchema,
} from '../../schema/knowledge-contract.js';

const ClaimOccurrenceSchema = z.strictObject({
  source_id: RecordIdSchema,
  location: LabelSchema,
});

/** Which of the revision's own passages the statement is, without the allocated position. */
export type ClaimOccurrence = z.infer<typeof ClaimOccurrenceSchema>;

export interface PublishContinuingClaimRevision {
  readonly operationId: string;
  /** The revision as authored, without `attributed_to`. */
  readonly revision: unknown;
  /** Who this revision is by, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  readonly occurrence: ClaimOccurrence;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type ClaimRevisionPublication = {
  claimId: string;
  revisionId: string;
  recordSha256: string;
  occurrence: { sourceId: string; location: string; position: number };
};

export interface PreparedClaimRevision {
  readonly revision: ClaimRevision;
  readonly occurrence: ClaimOccurrence;
  readonly record: AuthoredRecord;
}

export function prepareProjectClaimRevision(
  input: Omit<PublishContinuingClaimRevision, 'operationId'>
): PreparedClaimRevision {
  const revision = parsed(
    ClaimRevisionSchema,
    actingField(input.revision, 'attributed_to', input.attributedTo),
    'A claim revision'
  );
  const occurrence = parsed(ClaimOccurrenceSchema, input.occurrence, 'A claim occurrence');
  if (
    !revision.passages.some(
      (passage) =>
        passage.source_id === occurrence.source_id && passage.location === occurrence.location
    )
  )
    invalid('A claim revision occurs at one of the passages it restates');
  return {
    revision,
    occurrence,
    record: authoredRecord(revision, secretAllowList(input.secretAllow)),
  };
}

/** Everything the store decides, run before the operation starts and again inside it. */
export function checkProjectClaimRevision(
  view: ProjectReadView,
  prepared: PreparedClaimRevision
): void {
  const { revision } = prepared;
  if (view.get('SELECT revision_id FROM claim_revisions WHERE revision_id=?', revision.revision_id))
    taken('That claim revision ID already belongs to retained history');
  requireRetainedSources(view, [
    ...revision.source_ids,
    ...revision.passages.map((passage) => passage.source_id),
  ]);
  requireRetainedSubject(view, revision.subject);
  requireInterpretationSupport(
    view,
    'claim',
    revision.claim_id,
    revision.revision_id,
    revision.interpretation,
    revision.passages
  );
  // A finding rests on the observations it names, so naming one this history does not hold is a
  // missing record rather than a dangling string the reference would refuse as a driver error.
  requireRetainedObservations(view, revision.observation_ids);
  requireRevisionContinues(
    revisionLineage(view, 'claim_revisions', 'claim_id', revision.claim_id),
    revision
  );
}

/** The in-transaction writer, so a caller's own operation can publish the revision it derived. */
export function settleProjectClaimRevision(
  transaction: ProjectSettlement,
  operationId: string,
  prepared: PreparedClaimRevision
): ClaimRevisionPublication {
  checkProjectClaimRevision(transaction, prepared);
  const { revision, occurrence, record } = prepared;
  const sourceId = occurrence.source_id;
  const used = transaction.get<{ next: number }>(
    'SELECT ifnull(max(position),-1)+1 AS next FROM claim_revisions WHERE source_event_id=? AND field_path=?',
    sourceId,
    occurrence.location
  );
  const position = used ? used.next : 0;
  const [kind, name, basis] = attributionColumns(revision.attributed_to);
  transaction.run(
    `INSERT INTO claim_revisions (revision_id, claim_id, previous_revision_id,
       source_event_id, field_path, position, asserted_by, attributed_kind, attributed_basis,
       source_standing, subject_id, subject_revision_id,
       assertion_source_json, verification_json, verification_provenance,
       record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    revision.revision_id,
    revision.claim_id,
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
    // The released column carries two shapes, told apart by source_standing: a released row's
    // exact assertion source, and a continuing row's array of the source ids the assertion
    // rests on. The statement itself stays in the authored bytes and nowhere else.
    canonicalJson(revision.source_ids),
    revision.verification === null ? null : canonicalJson(revision.verification),
    revision.verification === null ? null : revision.verification.provenance,
    record.bytes,
    record.sha256,
    operationId
  );
  // The observations the finding rests on are lookup rows so a reader reaches them without
  // opening the payload and each one references the observation it names.
  revision.observation_ids.forEach((observationId, observationPosition) =>
    transaction.run(
      'INSERT INTO claim_revision_observations (revision_id, position, observation_id, operation_id) VALUES (?,?,?,?)',
      revision.revision_id,
      observationPosition,
      observationId,
      operationId
    )
  );
  if (revision.previous_revision_id === null)
    transaction.run(
      'INSERT INTO claims (claim_id, first_revision_id, operation_id) VALUES (?,?,?)',
      revision.claim_id,
      revision.revision_id,
      operationId
    );
  return {
    claimId: revision.claim_id,
    revisionId: revision.revision_id,
    recordSha256: record.sha256,
    occurrence: { sourceId, location: occurrence.location, position },
  };
}

export async function publishProjectContinuingClaimRevision(
  handle: ProjectDatabase,
  input: PublishContinuingClaimRevision,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const prepared = prepareProjectClaimRevision(input);
  const { revision, occurrence, record } = prepared;
  const op = {
    operationId,
    kind: 'knowledge.claim.revision.publish',
    target: { claimId: revision.claim_id, revisionId: revision.revision_id },
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
    checkProjectClaimRevision(view, prepared);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): ClaimRevisionPublication =>
      settleProjectClaimRevision(transaction, operationId, prepared),
    options
  );
}

export interface ProjectClaimRevisionRow {
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly occurrence: { sourceId: string; location: string; position: number };
  readonly sourceStanding: string | null;
  readonly subject: { subjectId: string; subjectRevisionId: string } | null;
  readonly attribution: { kind: string; name: string | null; basis: string | null };
  /** The observations the finding rests on, in the order it named them; possibly none. */
  readonly observationIds: string[];
  /**
   * Two shapes in one released column, told apart by `sourceStanding`: a released row (standing
   * null) put its exact assertion source here; a continuing row puts the ids of the sources the
   * assertion rests on.
   */
  readonly assertionSourceJson: string;
  /** Null for a revision nobody reported checking; `agent_reported` is the only provenance. */
  readonly verificationProvenance: string | null;
  readonly verificationJson: string | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export interface ProjectClaim {
  readonly claimId: string;
  readonly firstRevisionId: string;
  readonly operationId: string;
  readonly revisions: ProjectClaimRevisionRow[];
}

const observationsOf = (view: ProjectReadView, revisionId: string): string[] =>
  view
    .all<{
      observation_id: string;
    }>(
      'SELECT observation_id FROM claim_revision_observations WHERE revision_id=? ORDER BY position',
      revisionId
    )
    .map((row) => row.observation_id);

export function readProjectContinuingClaim(
  view: ProjectReadView,
  claimId: string
): ProjectClaim | null {
  const identity = view.get<{ claim_id: string; first_revision_id: string; operation_id: string }>(
    'SELECT claim_id, first_revision_id, operation_id FROM claims WHERE claim_id=?',
    claimId
  );
  if (!identity) return null;
  const revisions = view
    .all<{
      revision_id: string;
      previous_revision_id: string | null;
      source_event_id: string;
      field_path: string;
      position: number;
      source_standing: string | null;
      subject_id: string | null;
      subject_revision_id: string | null;
      attributed_kind: string;
      asserted_by: string | null;
      attributed_basis: string | null;
      assertion_source_json: string;
      verification_json: string | null;
      verification_provenance: string | null;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      'SELECT revision_id, previous_revision_id, source_event_id, field_path, position, source_standing, subject_id, subject_revision_id, attributed_kind, asserted_by, attributed_basis, assertion_source_json, verification_json, verification_provenance, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM claim_revisions WHERE claim_id=? ORDER BY rowid',
      claimId
    )
    .map((row) => ({
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      occurrence: {
        sourceId: row.source_event_id,
        location: row.field_path,
        position: row.position,
      },
      sourceStanding: row.source_standing,
      subject:
        row.subject_id === null || row.subject_revision_id === null
          ? null
          : { subjectId: row.subject_id, subjectRevisionId: row.subject_revision_id },
      attribution: {
        kind: row.attributed_kind,
        name: row.asserted_by,
        basis: row.attributed_basis,
      },
      observationIds: observationsOf(view, row.revision_id),
      assertionSourceJson: row.assertion_source_json,
      verificationProvenance: row.verification_provenance,
      verificationJson: row.verification_json,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
  return {
    claimId: identity.claim_id,
    firstRevisionId: identity.first_revision_id,
    operationId: identity.operation_id,
    revisions,
  };
}
