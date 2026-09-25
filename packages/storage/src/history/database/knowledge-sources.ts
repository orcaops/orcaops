// Publishing a source occurrence: the capture field a record was read from, or the bytes or
// immutable retained reference every other source keeps with its content hash.
//
// One capture field occurrence is one source id. A second publish of the same occurrence that read
// it the same way returns the source it already has and writes nothing at all, not even a receipt:
// that is not an error and never a second row, because two source ids for one passage would let it
// gain two identities. A second publish that read it differently is refused by the name of the
// source the occurrence already has, rather than answered with the earlier reading.
//
// The table keeps no lookup copy of a retained source's location or source time; both stay in
// the authored payload, which is the only place either is read from.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  actingField,
  actorColumns,
  AlreadyRetained,
  attributionColumns,
  type AuthoredRecord,
  authoredRecord,
  committedNothing,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  refuseRetainedSecrets,
  replayOperation,
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import {
  type Actor,
  type SourceOccurrence,
  SourceOccurrenceSchema,
} from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

export interface PublishKnowledgeSource {
  readonly operationId: string;
  /** The occurrence as authored, without `recorded_by`. */
  readonly source: unknown;
  /** The actor recording it, which a publishing session will own once storage has one. */
  readonly recordedBy: Actor;
  /** The bytes themselves, for a source that retains its own copy of them. */
  readonly retainedBytes?: Buffer | null;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type KnowledgeSourcePublication = {
  sourceId: string;
  recordSha256: string;
  /** False when the occurrence already had a source, which this call returned without writing. */
  published: boolean;
};

const retainedPublication = (row: RetainedSource): KnowledgeSourcePublication => ({
  sourceId: row.source_id,
  recordSha256: row.record_sha256,
  published: false,
});

interface RetainedSource {
  source_id: string;
  record_sha256: string;
  operation_id: string;
}

/**
 * The source a capture field occurrence already has, by its lookup columns alone. A caller that
 * cites a passage rather than authoring a reading of it takes this id, whatever the retained
 * record says about who recorded or interpreted it.
 */
export function retainedCaptureOccurrence(
  view: ProjectReadView,
  occurrence: SourceOccurrence['occurrence']
): { sourceId: string; operationId: string } | null {
  const row = captureOccurrence(view, occurrence);
  return row === null || row === undefined
    ? null
    : { sourceId: row.source_id, operationId: row.operation_id };
}

const captureOccurrence = (view: ProjectReadView, occurrence: SourceOccurrence['occurrence']) =>
  occurrence.kind !== 'capture_field'
    ? null
    : view.get<RetainedSource>(
        "SELECT source_id, record_sha256, operation_id FROM knowledge_sources WHERE source_kind='capture_field' AND event_id=? AND field_path=? AND position=?",
        occurrence.event_id,
        occurrence.field_path,
        occurrence.position
      );

function refuseTakenIdentity(view: ProjectReadView, sourceId: string): void {
  if (view.get('SELECT source_id FROM knowledge_sources WHERE source_id=?', sourceId))
    taken('That source ID already belongs to a different retained source occurrence');
}

export interface PreparedKnowledgeSource {
  readonly source: SourceOccurrence;
  readonly record: AuthoredRecord;
  readonly retainedBytes: Buffer | null;
  /** The record this call would have authored under the source id a retained occurrence has. */
  readonly recordUnder: (sourceId: string) => AuthoredRecord;
}

export function prepareProjectKnowledgeSource(
  input: Omit<PublishKnowledgeSource, 'operationId'>
): PreparedKnowledgeSource {
  const source = parsed(
    SourceOccurrenceSchema,
    actingField(input.source, 'recorded_by', input.recordedBy),
    'A source occurrence'
  );
  const { occurrence } = source;
  const allow = secretAllowList(input.secretAllow);
  const retainedBytes = input.retainedBytes ?? null;
  const bytes = Buffer.isBuffer(retainedBytes) ? Buffer.from(retainedBytes) : retainedBytes;
  if (occurrence.kind === 'capture_field') {
    if (bytes !== null) invalid('A capture field owns no second copy of the bytes');
  } else if (occurrence.retention.kind === 'bytes') {
    if (!Buffer.isBuffer(bytes)) invalid('A source that retains bytes publishes the bytes it kept');
    if (digest(bytes) !== occurrence.retention.content_sha256)
      invalid('The retained bytes do not hash to the content identity the source states');
    refuseRetainedSecrets(bytes, allow);
  } else if (bytes !== null) {
    invalid('A source held by an immutable reference retains no bytes here');
  }
  return {
    source,
    record: authoredRecord(source, allow),
    retainedBytes: bytes,
    recordUnder: (sourceId) => authoredRecord({ ...source, source_id: sourceId }, allow),
  };
}

/**
 * The source this occurrence already has, if any, after refusing everything the store decides
 * about a new one. Null means nothing is retained for it and it may be written.
 */
export function retainedProjectKnowledgeSource(
  view: ProjectReadView,
  prepared: PreparedKnowledgeSource
): KnowledgeSourcePublication | null {
  const { occurrence } = prepared.source;
  const existing = captureOccurrence(view, occurrence);
  // One capture field occurrence is one source, so a second publish of it could only repeat the
  // first. The comparison is against the record this call would have authored under the source
  // the occurrence already has, because the caller minting a fresh id for a retained occurrence
  // is the repeat this returns the retained one for. Anything else it authored — a different
  // author, interpreter or access restriction — is a different reading of the same passage, and
  // replaying it would answer with a record nobody wrote.
  if (existing)
    return prepared.recordUnder(existing.source_id).sha256 === existing.record_sha256
      ? retainedPublication(existing)
      : taken(`That capture field is already source ${existing.source_id}`);
  if (
    occurrence.kind === 'capture_field' &&
    !view.get(
      'SELECT event_id FROM artifact_events WHERE artifact_id=? AND event_id=?',
      occurrence.artifact_id,
      occurrence.event_id
    )
  )
    missing('The capture event this source occurs in is not retained in this history');
  refuseTakenIdentity(view, prepared.source.source_id);
  return null;
}

/**
 * The in-transaction writer, so an operation that publishes records citing a source can publish
 * the source itself in the same settlement. `published` is false when the occurrence already had
 * one, which is the answer a repeat gets and never a second row.
 */
export function settleProjectKnowledgeSource(
  transaction: ProjectSettlement,
  operationId: string,
  prepared: PreparedKnowledgeSource
): KnowledgeSourcePublication {
  const existing = retainedProjectKnowledgeSource(transaction, prepared);
  if (existing) return existing;
  const { source, record, retainedBytes: bytes } = prepared;
  const { occurrence } = source;
  const [author, authorBasis] = actorColumns(source.source_author);
  const [recorder, recorderBasis] = actorColumns(source.recorded_by);
  // Three columns, so a source nobody interpreted is not confused with one a detector did.
  const [interpretedKind, interpreter, interpreterBasis] =
    source.interpreted_by === null ? [null, null, null] : attributionColumns(source.interpreted_by);
  const retention = occurrence.kind === 'capture_field' ? null : occurrence.retention;
  transaction.run(
    `INSERT INTO knowledge_sources (source_id, source_kind, artifact_id, event_id, field_path, position,
       retention_kind, retained_bytes, retained_reference, content_sha256,
       source_author, source_author_basis, recorded_by, recorded_by_basis,
       interpreted_kind, interpreted_by, interpreted_by_basis, access_restriction, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    source.source_id,
    occurrence.kind,
    occurrence.kind === 'capture_field' ? occurrence.artifact_id : null,
    occurrence.kind === 'capture_field' ? occurrence.event_id : null,
    occurrence.kind === 'capture_field' ? occurrence.field_path : null,
    occurrence.kind === 'capture_field' ? occurrence.position : null,
    retention === null ? null : retention.kind,
    retention !== null && retention.kind === 'bytes' ? bytes : null,
    retention !== null && retention.kind === 'retained_reference' ? retention.reference : null,
    retention === null ? null : retention.content_sha256,
    author,
    authorBasis,
    recorder,
    recorderBasis,
    interpretedKind,
    interpreter,
    interpreterBasis,
    source.access_restriction,
    record.bytes,
    record.sha256,
    operationId
  );
  return { sourceId: source.source_id, recordSha256: record.sha256, published: true };
}

export async function publishProjectKnowledgeSource(
  handle: ProjectDatabase,
  input: PublishKnowledgeSource,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const prepared = prepareProjectKnowledgeSource(input);
  const { source, record } = prepared;
  const op = {
    operationId,
    kind: 'knowledge.source.publish',
    target: { sourceId: source.source_id, kind: source.occurrence.kind },
    // The payload hash covers every authored field of the occurrence, so a retry under this
    // operation id with any of them altered conflicts rather than replaying the prior success.
    payload: { record: record.sha256 },
    expectedState: null,
    // Publishing a source is not a change of intent: it records what was said, not a new rule.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const retained = handle.read((view) => retainedProjectKnowledgeSource(view, prepared)).value;
  // An occurrence that already has a source is not published again, and a call that publishes
  // nothing runs no operation: no receipt, and neither counter moves.
  if (retained) return committedNothing(handle, retained);
  return publishUnlessRetained(
    handle,
    op,
    (transaction: ProjectSettlement): KnowledgeSourcePublication => {
      const settled = settleProjectKnowledgeSource(transaction, operationId, prepared);
      if (!settled.published) throw new AlreadyRetained(settled);
      return settled;
    },
    options
  );
}

export interface ProjectKnowledgeSource {
  readonly sourceId: string;
  readonly kind: string;
  /** What the writer recorded about reading this source; the access-context step reads it here. */
  readonly accessRestriction: string | null;
  /** Null for a source nobody interpreted, which is not the same as one a detector interpreted. */
  readonly interpretedBy: { kind: string; name: string | null; basis: string | null } | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly retainedBytesHex: string | null;
  readonly operationId: string;
}

export function readProjectKnowledgeSource(
  view: ProjectReadView,
  sourceId: string
): ProjectKnowledgeSource | null {
  const row = view.get<{
    source_id: string;
    source_kind: string;
    access_restriction: string | null;
    interpreted_kind: string | null;
    interpreted_by: string | null;
    interpreted_by_basis: string | null;
    record_hex: string;
    record_sha256: string;
    retained_hex: string | null;
    operation_id: string;
  }>(
    'SELECT source_id, source_kind, access_restriction, interpreted_kind, interpreted_by, interpreted_by_basis, hex(record_bytes) AS record_hex, record_sha256, hex(retained_bytes) AS retained_hex, operation_id FROM knowledge_sources WHERE source_id=?',
    sourceId
  );
  return row
    ? {
        sourceId: row.source_id,
        kind: row.source_kind,
        accessRestriction: row.access_restriction,
        interpretedBy:
          row.interpreted_kind === null
            ? null
            : {
                kind: row.interpreted_kind,
                name: row.interpreted_by,
                basis: row.interpreted_by_basis,
              },
        recordHex: row.record_hex,
        recordSha256: row.record_sha256,
        retainedBytesHex: row.retained_hex,
        operationId: row.operation_id,
      }
    : null;
}
