// Publishing a subject and its revisions. A subject identifies a behaviour or area of the
// product; paths and symbols help find one and never define it, so a rename retires nothing.
//
// A subject revision records what a subject is called and what it covers, never what stands, so
// it moves the write sequence and leaves the intent counter alone.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  actingField,
  actorColumns,
  authoredRecord,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  requireRetainedSources,
  requireRevisionContinues,
  retriedOperation,
  revisionLineage,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import { runProjectOperation } from './transactions.js';
import {
  type Actor,
  type SubjectRevision,
  SubjectRevisionSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishSubjectRevision {
  readonly operationId: string;
  /** The revision as authored, without `authored_by`. */
  readonly revision: unknown;
  /** The authoring actor, which a publishing session will own once storage has one. */
  readonly authoredBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type SubjectPublication = {
  subjectId: string;
  revisionId: string;
  recordSha256: string;
};

interface PreparedSubjectRevision {
  readonly operationId: string;
  readonly revision: SubjectRevision;
  readonly record: ReturnType<typeof authoredRecord>;
}

function prepare(input: PublishSubjectRevision, kind: string) {
  const operationId = operationIdentity(input.operationId);
  const revision = parsed(
    SubjectRevisionSchema,
    actingField(input.revision, 'authored_by', input.authoredBy),
    'A subject revision'
  );
  const record = authoredRecord(revision, secretAllowList(input.secretAllow));
  return {
    prepared: { operationId, revision, record } satisfies PreparedSubjectRevision,
    op: {
      operationId,
      kind,
      target: { subjectId: revision.subject_id, revisionId: revision.revision_id },
      payload: { record: record.sha256 },
      expectedState: { previousRevisionId: revision.previous_revision_id },
      intentChange: false,
    } as const,
  };
}

function refuseTakenRevision(view: ProjectReadView, revisionId: string): void {
  if (view.get('SELECT revision_id FROM subject_revisions WHERE revision_id=?', revisionId))
    taken('That subject revision ID already belongs to retained history');
}

function insertRevision(transaction: ProjectSettlement, prepared: PreparedSubjectRevision): void {
  const { revision, record, operationId } = prepared;
  const [author, basis] = actorColumns(revision.authored_by);
  transaction.run(
    `INSERT INTO subject_revisions (revision_id, subject_id, previous_revision_id, subject_kind,
       authored_by, authored_by_basis, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    revision.revision_id,
    revision.subject_id,
    revision.previous_revision_id,
    revision.kind,
    author,
    basis,
    record.bytes,
    record.sha256,
    operationId
  );
}

export async function publishProjectSubject(
  handle: ProjectDatabase,
  input: PublishSubjectRevision,
  options: ProjectOperationOptions = {}
) {
  const { prepared, op } = prepare(input, 'knowledge.subject.publish');
  const { revision } = prepared;
  if (revision.previous_revision_id !== null)
    invalid('A subject is published with its first revision, which continues nothing');
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    if (view.get('SELECT subject_id FROM subjects WHERE subject_id=?', revision.subject_id))
      taken('That subject already exists; publish a further revision of it instead');
    refuseTakenRevision(view, revision.revision_id);
    requireRetainedSources(view, revision.source_ids);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): SubjectPublication => {
      if (
        transaction.get('SELECT subject_id FROM subjects WHERE subject_id=?', revision.subject_id)
      )
        taken('That subject already exists; publish a further revision of it instead');
      refuseTakenRevision(transaction, revision.revision_id);
      requireRetainedSources(transaction, revision.source_ids);
      insertRevision(transaction, prepared);
      transaction.run(
        'INSERT INTO subjects (subject_id, first_revision_id, operation_id) VALUES (?,?,?)',
        revision.subject_id,
        revision.revision_id,
        op.operationId
      );
      return {
        subjectId: revision.subject_id,
        revisionId: revision.revision_id,
        recordSha256: prepared.record.sha256,
      };
    },
    options
  );
}

export async function publishProjectSubjectRevision(
  handle: ProjectDatabase,
  input: PublishSubjectRevision,
  options: ProjectOperationOptions = {}
) {
  const { prepared, op } = prepare(input, 'knowledge.subject.revision.publish');
  const { revision } = prepared;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  const continues = (view: ProjectReadView) => {
    if (!view.get('SELECT subject_id FROM subjects WHERE subject_id=?', revision.subject_id))
      missing('The revision continues a subject this history does not hold');
    refuseTakenRevision(view, revision.revision_id);
    requireRetainedSources(view, revision.source_ids);
    requireRevisionContinues(
      revisionLineage(view, 'subject_revisions', 'subject_id', revision.subject_id),
      revision
    );
  };
  handle.read((view) => {
    continues(view);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): SubjectPublication => {
      continues(transaction);
      insertRevision(transaction, prepared);
      return {
        subjectId: revision.subject_id,
        revisionId: revision.revision_id,
        recordSha256: prepared.record.sha256,
      };
    },
    options
  );
}

export interface ProjectSubjectRevisionRow {
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly kind: string;
  readonly authoredBy: string | null;
  readonly authoredByBasis: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export function readProjectSubject(
  view: ProjectReadView,
  subjectId: string
): { subjectId: string; firstRevisionId: string; revisions: ProjectSubjectRevisionRow[] } | null {
  const subject = view.get<{ subject_id: string; first_revision_id: string }>(
    'SELECT subject_id, first_revision_id FROM subjects WHERE subject_id=?',
    subjectId
  );
  if (!subject) return null;
  const revisions = view
    .all<{
      revision_id: string;
      previous_revision_id: string | null;
      subject_kind: string;
      authored_by: string | null;
      authored_by_basis: string;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      'SELECT revision_id, previous_revision_id, subject_kind, authored_by, authored_by_basis, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM subject_revisions WHERE subject_id=? ORDER BY rowid',
      subjectId
    )
    .map((row) => ({
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      kind: row.subject_kind,
      authoredBy: row.authored_by,
      authoredByBasis: row.authored_by_basis,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
  return { subjectId: subject.subject_id, firstRevisionId: subject.first_revision_id, revisions };
}
