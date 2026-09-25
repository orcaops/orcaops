// Publishing a revocation: ending an authorization, an exception, a conflict answer or an
// assignment from now on.
//
// What was done under the revoked record is preserved — an adoption made under a since-revoked
// authorization still stands, and the resolver names the revocation beside it — so a revocation is
// never a way to undo an act. Whoever revokes acts on an instruction in the same scope, which the
// contract's own record refuses to carry from anywhere else, and a revocation reaches only what
// its own scope reaches: an instruction over one artifact ends nothing a project-wide record
// authorized, because no read would ever apply it there either.
//
// A record one standing revocation already reaches is not revoked again: nothing un-revokes, so a
// second act would end nothing, and ending an exception is a change of intent whose counter would
// move over an intent nobody changed.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireStoreScope } from './knowledge-authority.js';
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
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import {
  prepareProjectKnowledgeSource,
  type PublishKnowledgeSource,
  settleProjectKnowledgeSource,
} from './knowledge-sources.js';
import { scopeColumns, scopeReaches } from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import {
  type Actor,
  type AuthorityScope,
  type Revocation,
  RevocationSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishRevocation {
  readonly operationId: string;
  /** The revocation as authored, without `revoked_by`. */
  readonly revocation: unknown;
  /** Who revoked it, which a publishing session will own once storage has one. */
  readonly revokedBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type RevocationPublication = {
  revocationId: string;
  revokes: { kind: string; id: string };
  recordSha256: string;
};

export interface PublishRevocationWithSource extends PublishRevocation {
  readonly source: Omit<PublishKnowledgeSource, 'operationId'>;
}

const REVOKED = {
  authorization:
    'SELECT scope_kind, scope_value FROM knowledge_authorizations WHERE authorization_id=?',
  exception: 'SELECT scope_kind, scope_value FROM knowledge_exceptions WHERE exception_id=?',
  conflict_answer: 'SELECT scope_kind, scope_value FROM conflict_answers WHERE answer_id=?',
  assignment: 'SELECT scope_kind, scope_value FROM assignments WHERE assignment_id=?',
} as const;

const REVOKED_RECORD = {
  authorization: 'authorization',
  exception: 'exception',
  conflict_answer: 'conflict answer',
  assignment: 'assignment',
} as const;

/**
 * The revocation already standing over this record wherever it reaches, if there is one. Nothing
 * un-revokes, so a second revocation of a record one already ends changes nothing — and, for an
 * exception, would move the intent counter again over an intent nobody changed.
 */
function standingRevocation(
  view: ProjectReadView,
  revokes: Revocation['revokes'],
  at: AuthorityScope,
  projectId: string
): string | null {
  for (const row of view.all<{ revocation_id: string; scope_kind: string; scope_value: string }>(
    `SELECT revocation_id, scope_kind, scope_value FROM knowledge_revocations
     WHERE revoked_kind=? AND revoked_id=? ORDER BY revocation_id`,
    revokes.kind,
    revokes.id
  )) {
    const scope: AuthorityScope =
      row.scope_kind === 'project'
        ? { kind: 'project', project_id: projectId }
        : { kind: 'artifact', artifact_id: row.scope_value };
    if (scopeReaches(scope, at)) return row.revocation_id;
  }
  return null;
}

function checkTarget(view: ProjectReadView, revocation: Revocation, projectId: string): void {
  if (
    view.get(
      'SELECT revocation_id FROM knowledge_revocations WHERE revocation_id=?',
      revocation.revocation_id
    )
  )
    taken('That revocation ID already belongs to retained history');
  const revoked = view.get<{ scope_kind: string; scope_value: string | null }>(
    REVOKED[revocation.revokes.kind],
    revocation.revokes.id
  );
  if (revoked === null) missing('The record this revocation ends is not retained in this history');
  // A revocation ends a record only where its own scope reaches, exactly as a read applies it, so
  // an instruction given over one artifact can never end what a project-wide record authorizes.
  const scope: AuthorityScope =
    revoked.scope_kind === 'project'
      ? { kind: 'project', project_id: projectId }
      : { kind: 'artifact', artifact_id: revoked.scope_value as string };
  if (!scopeReaches(revocation.scope, scope))
    invalid(
      'This revocation acts in a narrower scope than the record it ends; revoke it in the scope it was given in'
    );
  const standing = standingRevocation(view, revocation.revokes, scope, projectId);
  if (standing !== null)
    taken(
      `That ${REVOKED_RECORD[revocation.revokes.kind]} is already ended by revocation ${standing}`
    );
}

function check(view: ProjectReadView, revocation: Revocation, projectId: string): void {
  checkTarget(view, revocation, projectId);
  requireRetainedSources(view, [
    revocation.source_id,
    revocation.instruction.instruction_source_id,
  ]);
}

function settleRevocation(
  transaction: ProjectSettlement,
  operationId: string,
  revocation: Revocation,
  record: ReturnType<typeof authoredRecord>,
  projectId: string
): RevocationPublication {
  check(transaction, revocation, projectId);
  const [scopeKind, scopeValue] = scopeColumns(revocation.scope);
  const [revoker, basis] = actorColumns(revocation.revoked_by);
  transaction.run(
    `INSERT INTO knowledge_revocations (revocation_id, revoked_kind, revoked_id, scope_kind, scope_value,
       revoked_by, revoked_by_basis, instruction_kind, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    revocation.revocation_id,
    revocation.revokes.kind,
    revocation.revokes.id,
    scopeKind,
    scopeValue,
    revoker,
    basis,
    revocation.instruction.kind,
    record.bytes,
    record.sha256,
    operationId
  );
  return {
    revocationId: revocation.revocation_id,
    revokes: { ...revocation.revokes },
    recordSha256: record.sha256,
  };
}

export async function publishProjectRevocation(
  handle: ProjectDatabase,
  input: PublishRevocation,
  options: ProjectOperationOptions = {}
) {
  const revocation = parsed(
    RevocationSchema,
    actingField(input.revocation, 'revoked_by', input.revokedBy),
    'A revocation'
  );
  requireStoreScope(handle.authority.projectId, revocation.scope);
  const record = authoredRecord(revocation, secretAllowList(input.secretAllow));
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.revocation.publish',
    target: {
      revocationId: revocation.revocation_id,
      revokes: revocation.revokes.kind,
      revokedId: revocation.revokes.id,
    },
    payload: { record: record.sha256 },
    expectedState: null,
    // Ending an exception puts its expectation back under its recorded end behaviour, which is a
    // change of intent. Ending an authorization, an answer or an assignment ends permission and
    // designates nothing: what was done under it still stands, and the acts under it are what
    // changed what stands.
    intentChange: revocation.revokes.kind === 'exception',
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  const projectId = handle.authority.projectId;
  handle.read((view) => {
    check(view, revocation, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): RevocationPublication => {
      return settleRevocation(transaction, settling.operationId, revocation, record, projectId);
    },
    options
  );
}

export async function publishProjectRevocationWithSource(
  handle: ProjectDatabase,
  input: PublishRevocationWithSource,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const revocation = parsed(
    RevocationSchema,
    actingField(input.revocation, 'revoked_by', input.revokedBy),
    'A revocation'
  );
  requireStoreScope(handle.authority.projectId, revocation.scope);
  const source = prepareProjectKnowledgeSource(input.source);
  if (
    source.source.source_id !== revocation.source_id ||
    source.source.source_id !== revocation.instruction.instruction_source_id
  )
    invalid('The revocation and its instruction must cite the source settled with them');
  const record = authoredRecord(revocation, secretAllowList(input.secretAllow));
  const op = {
    operationId,
    kind: 'knowledge.revocation-with-source.publish',
    target: {
      revocationId: revocation.revocation_id,
      revokes: revocation.revokes.kind,
      revokedId: revocation.revokes.id,
      sourceId: source.source.source_id,
    },
    payload: { record: record.sha256, source: source.record.sha256 },
    expectedState: null,
    intentChange: revocation.revokes.kind === 'exception',
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const projectId = handle.authority.projectId;
  handle.read((view) => {
    checkTarget(view, revocation, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): RevocationPublication => {
      settleProjectKnowledgeSource(transaction, settling.operationId, source);
      return settleRevocation(transaction, settling.operationId, revocation, record, projectId);
    },
    options
  );
}

export interface ProjectRevocation {
  readonly revocationId: string;
  readonly revokes: { kind: string; id: string };
  readonly scope: { kind: string; value: string | null };
  readonly revokedBy: { identity: string | null; basis: string };
  readonly instructionKind: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

interface RevocationRow {
  revocation_id: string;
  revoked_kind: string;
  revoked_id: string;
  scope_kind: string;
  scope_value: string | null;
  revoked_by: string | null;
  revoked_by_basis: string;
  instruction_kind: string;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

const REVOCATION_COLUMNS = `SELECT revocation_id, revoked_kind, revoked_id, scope_kind, scope_value, revoked_by,
    revoked_by_basis, instruction_kind, hex(record_bytes) AS record_hex, record_sha256, operation_id
  FROM knowledge_revocations`;

/** Every revocation that ends one record, with every column the writer recorded. */
export function listProjectRevocations(
  view: ProjectReadView,
  revokes: { kind: string; id: string }
): ProjectRevocation[] {
  return view
    .all<RevocationRow>(
      `${REVOCATION_COLUMNS} WHERE revoked_kind=? AND revoked_id=? ORDER BY rowid`,
      revokes.kind,
      revokes.id
    )
    .map((row) => ({
      revocationId: row.revocation_id,
      revokes: { kind: row.revoked_kind, id: row.revoked_id },
      scope: { kind: row.scope_kind, value: row.scope_value },
      revokedBy: { identity: row.revoked_by, basis: row.revoked_by_basis },
      instructionKind: row.instruction_kind,
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
}
