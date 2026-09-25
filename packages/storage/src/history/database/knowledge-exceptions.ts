// Publishing an exception: an exact expectation excepted in a context, with the end condition and
// the behaviour that applies when it ends.
//
// An exception always departs from its expectation, so only an authorization that acknowledges
// that expectation can carry it, and the act is judged inside the transaction against the state it
// observed. Nothing is written when an exception ends: a reader computes its standing from the end
// it records and the revocations that name it.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  authorizationContext,
  parseWorkContext,
  requireAuthority,
  requireAuthorizationReferences,
  requireRetainedRevisions,
  requireStoreScope,
} from './knowledge-authority.js';
import {
  actingField,
  actorColumns,
  type AuthoredRecord,
  authoredRecord,
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
  requireExpectedState,
  resolveProjectKnowledge,
  scopeColumns,
} from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Actor,
  type ApplicabilityInputs,
  exceptionFootprint,
  ExceptionSchema,
  type KnowledgeException,
} from '../../schema/knowledge-contract.js';

export interface PublishException {
  readonly operationId: string;
  /** The exception as authored, without `granted_by`. */
  readonly exception: unknown;
  /** Who granted it, which a publishing session will own once storage has one. */
  readonly grantedBy: Actor;
  /** The work this act is done for, judged against the context of an authorization it reuses. */
  readonly work?: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type ExceptionPublication = {
  exceptionId: string;
  expectationRevisionId: string;
  recordSha256: string;
};

interface PreparedException {
  readonly exception: KnowledgeException;
  readonly record: AuthoredRecord;
  readonly work: ApplicabilityInputs;
}

function check(view: ProjectReadView, prepared: PreparedException, projectId: string): void {
  const { exception, work } = prepared;
  if (
    view.get(
      'SELECT exception_id FROM knowledge_exceptions WHERE exception_id=?',
      exception.exception_id
    )
  )
    taken('That exception ID already belongs to retained history');
  requireRetainedRevisions(view, [exception.expectation], 'An exception');
  requireRetainedSources(view, [exception.source_id]);
  requireAuthorizationReferences(view, exception.authorization, 'An exception');
  const resolved = resolveProjectKnowledge(
    view,
    { kind: exception.expectation.kind, entity_id: exception.expectation.entity_id },
    projectId,
    exception.scope,
    work
  );
  requireExpectedState(exception.expected_state, resolved.governing_state);
  requireAuthority({
    authorization: exception.authorization,
    scope: exception.scope,
    footprint: exceptionFootprint(exception),
    acting: { kind: 'actor', actor: exception.granted_by },
    context: authorizationContext(view, projectId, exception.authorization, work),
  });
}

export async function publishProjectException(
  handle: ProjectDatabase,
  input: PublishException,
  options: ProjectOperationOptions = {}
) {
  const exception = parsed(
    ExceptionSchema,
    actingField(input.exception, 'granted_by', input.grantedBy),
    'An exception'
  );
  const projectId = handle.authority.projectId;
  requireStoreScope(projectId, exception.scope);
  const prepared: PreparedException = {
    exception,
    record: authoredRecord(exception, secretAllowList(input.secretAllow)),
    work: parseWorkContext(input.work),
  };
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.exception.publish',
    target: {
      exceptionId: exception.exception_id,
      expectationRevisionId: exception.expectation.revision_id,
    },
    payload: {
      record: prepared.record.sha256,
      work: canonicalJson(prepared.work) ?? null,
    },
    expectedState: exception.expected_state,
    // An exception changes what an expectation requires of the work it covers.
    intentChange: true,
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    check(view, prepared, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): ExceptionPublication => {
      check(transaction, prepared, projectId);
      const [scopeKind, scopeValue] = scopeColumns(exception.scope);
      const [granter, basis] = actorColumns(exception.granted_by);
      transaction.run(
        `INSERT INTO knowledge_exceptions (exception_id, expectation_kind, expectation_id, expectation_revision_id,
           scope_kind, scope_value, granted_by, granted_by_basis, authorization_kind, end_kind, end_behavior,
           record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        exception.exception_id,
        exception.expectation.kind,
        exception.expectation.entity_id,
        exception.expectation.revision_id,
        scopeKind,
        scopeValue,
        granter,
        basis,
        exception.authorization.kind,
        exception.ends.kind,
        exception.end_behavior,
        prepared.record.bytes,
        prepared.record.sha256,
        settling.operationId
      );
      return {
        exceptionId: exception.exception_id,
        expectationRevisionId: exception.expectation.revision_id,
        recordSha256: prepared.record.sha256,
      };
    },
    options
  );
}

export interface ProjectException {
  readonly exceptionId: string;
  readonly expectation: { kind: string; entityId: string; revisionId: string };
  readonly scope: { kind: string; value: string | null };
  readonly grantedBy: { identity: string | null; basis: string };
  readonly authorizationKind: string;
  readonly endKind: string;
  readonly endBehavior: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

interface ExceptionRow {
  exception_id: string;
  expectation_kind: string;
  expectation_id: string;
  expectation_revision_id: string;
  scope_kind: string;
  scope_value: string | null;
  granted_by: string | null;
  granted_by_basis: string;
  authorization_kind: string;
  end_kind: string;
  end_behavior: string;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

const EXCEPTION_COLUMNS = `SELECT exception_id, expectation_kind, expectation_id, expectation_revision_id,
    scope_kind, scope_value, granted_by, granted_by_basis, authorization_kind, end_kind, end_behavior,
    hex(record_bytes) AS record_hex, record_sha256, operation_id
  FROM knowledge_exceptions`;

const exceptionRow = (row: ExceptionRow): ProjectException => ({
  exceptionId: row.exception_id,
  expectation: {
    kind: row.expectation_kind,
    entityId: row.expectation_id,
    revisionId: row.expectation_revision_id,
  },
  scope: { kind: row.scope_kind, value: row.scope_value },
  grantedBy: { identity: row.granted_by, basis: row.granted_by_basis },
  authorizationKind: row.authorization_kind,
  endKind: row.end_kind,
  endBehavior: row.end_behavior,
  recordHex: row.record_hex,
  recordSha256: row.record_sha256,
  operationId: row.operation_id,
});

export function readProjectException(
  view: ProjectReadView,
  exceptionId: string
): ProjectException | null {
  const row = view.get<ExceptionRow>(`${EXCEPTION_COLUMNS} WHERE exception_id=?`, exceptionId);
  return row === null ? null : exceptionRow(row);
}

/** Every exception of one expectation identity, in the order they were retained. */
export function listProjectExceptions(
  view: ProjectReadView,
  expectation: { kind: string; entityId: string }
): ProjectException[] {
  return view
    .all<ExceptionRow>(
      `${EXCEPTION_COLUMNS} WHERE expectation_kind=? AND expectation_id=? ORDER BY rowid`,
      expectation.kind,
      expectation.entityId
    )
    .map(exceptionRow);
}
