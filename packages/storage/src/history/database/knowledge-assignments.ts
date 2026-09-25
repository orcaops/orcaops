// Publishing an assignment: who may decide what on somebody's behalf, the obligations it inherits,
// the footprint it delegates, and how long it lasts.
//
// An assigner cannot delegate what they do not hold. The footprint the assignment delegates is
// judged inside the transaction against the authority the assigner cites — an instruction, an
// approval binding, or an earlier assignment — by the same `checkAuthorization` every act is judged
// by, so a chain of assignments can only ever narrow. An assignment that delegates nothing is
// refused for the reason an authorization over an empty footprint is: nothing would pass vacuously.
//
// Nothing here ends an assignment. A reader computes its standing from the time it ends at and the
// revocations that name it, exactly as it does for an exception, and the row itself is never
// deleted or edited: what was published under an assignment before it was revoked stays on record.
//
// Opening one designates nothing, so it moves the write sequence and not the intent counter — the
// acts published under it are what change what stands.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  authorizationContext,
  parseWorkContext,
  requireAuthority,
  requireAuthorizationReferences,
  requireRetainedRevisions,
  requireStoreScope,
} from './knowledge-authority.js';
import { writeSequencesOf } from './knowledge-read-boundary.js';
import {
  actingField,
  actorColumns,
  type AuthoredRecord,
  authoredRecord,
  invalid,
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
  assignmentBasisStands,
  revisionStands,
  scopeColumns,
  scopeReaches,
} from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type Actor,
  type ApplicabilityInputs,
  type Assignment,
  AssignmentSchema,
  assignmentWindow,
  type AuthorityScope,
  evaluateApplicability,
  type RecordRevisionRef,
} from '../../schema/knowledge-contract.js';
import {
  type AssignmentStanding,
  assignmentStandingOf,
  type KnowledgeReadRequest,
} from '../../schema/knowledge-resolution.js';

export interface PublishAssignment {
  readonly operationId: string;
  /** The assignment as authored, without `assigned_by`. */
  readonly assignment: unknown;
  /** Who assigned it, which a publishing session will own once storage has one. */
  readonly assignedBy: Actor;
  /** The work this act is done for, judged against the authority the assigner cites. */
  readonly work?: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type AssignmentPublication = {
  assignmentId: string;
  responsible: string | null;
  recordSha256: string;
};

interface PreparedAssignment {
  readonly assignment: Assignment;
  readonly record: AuthoredRecord;
  readonly work: ApplicabilityInputs;
}

/** Every revision the assignment names, in either half of the record. */
const namedRevisions = (assignment: Assignment): RecordRevisionRef[] => [
  ...assignment.inherited,
  ...assignment.delegated.adopts.map((adoption) => adoption.revision),
  ...assignment.delegated.departs_from.map((departure) => departure.rule),
  ...assignment.delegated.departs_from.flatMap((departure) =>
    departure.replaced_by === null ? [] : [departure.replaced_by]
  ),
  ...assignment.delegated.restates,
];

/** The identities it names, which is what the member index carries: one row per identity. */
const memberIdentities = (assignment: Assignment): { kind: string; entityId: string }[] => {
  const held = new Map<string, { kind: string; entityId: string }>();
  for (const ref of namedRevisions(assignment))
    held.set(`${ref.kind}:${ref.entity_id}`, { kind: ref.kind, entityId: ref.entity_id });
  return [...held.values()].sort((left, right) =>
    `${left.kind}:${left.entityId}` < `${right.kind}:${right.entityId}` ? -1 : 1
  );
};

function check(view: ProjectReadView, prepared: PreparedAssignment, projectId: string): void {
  const { assignment, work } = prepared;
  if (
    view.get(
      'SELECT assignment_id FROM assignments WHERE assignment_id=?',
      assignment.assignment_id
    )
  )
    taken('That assignment ID already belongs to retained history');
  requireRetainedSources(view, [assignment.source_id]);
  requireAuthorizationReferences(view, assignment.authorization, 'An assignment');
  requireRetainedRevisions(view, namedRevisions(assignment), 'An assignment');
  for (const inherited of assignment.inherited)
    if (!revisionStands(view, projectId, inherited, assignment.scope, work))
      invalid(
        `An assignment cannot inherit ${inherited.kind} revision ${inherited.revision_id} because it does not stand in the assignment's scope`
      );
  // The assigner's own authority over exactly the footprint being delegated, read from the store
  // inside this transaction: an assignment can never hand on more than its assigner holds.
  requireAuthority({
    authorization: assignment.authorization,
    scope: assignment.scope,
    footprint: assignment.delegated,
    acting: { kind: 'actor', actor: assignment.assigned_by },
    context: authorizationContext(view, projectId, assignment.authorization, work),
  });
}

export async function publishProjectAssignment(
  handle: ProjectDatabase,
  input: PublishAssignment,
  options: ProjectOperationOptions = {}
) {
  const assignment = parsed(
    AssignmentSchema,
    actingField(input.assignment, 'assigned_by', input.assignedBy),
    'An assignment'
  );
  const projectId = handle.authority.projectId;
  requireStoreScope(projectId, assignment.scope);
  const prepared: PreparedAssignment = {
    assignment,
    record: authoredRecord(assignment, secretAllowList(input.secretAllow)),
    work: parseWorkContext(input.work),
  };
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.assignment.publish',
    target: {
      assignmentId: assignment.assignment_id,
      responsible: assignment.responsible.identity,
      scope: assignment.scope.kind,
    },
    payload: {
      record: prepared.record.sha256,
      work: canonicalJson(prepared.work) ?? null,
    },
    expectedState: null,
    // An assignment designates nothing: it says who may act, and the acts published under it are
    // what change what stands.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    check(view, prepared, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): AssignmentPublication => {
      check(transaction, prepared, projectId);
      const [scopeKind, scopeValue] = scopeColumns(assignment.scope);
      const [responsible, responsibleBasis] = actorColumns(assignment.responsible);
      const [assigner, assignerBasis] = actorColumns(assignment.assigned_by);
      transaction.run(
        `INSERT INTO assignments (assignment_id, objective, responsible, responsible_basis,
           assigned_by, assigned_by_basis, scope_kind, scope_value, authorization_kind, source_id,
           valid_until, record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        assignment.assignment_id,
        assignment.objective,
        responsible,
        responsibleBasis,
        assigner,
        assignerBasis,
        scopeKind,
        scopeValue,
        assignment.authorization.kind,
        assignment.source_id,
        assignment.valid_until,
        prepared.record.bytes,
        prepared.record.sha256,
        settling.operationId
      );
      for (const member of memberIdentities(assignment))
        transaction.run(
          `INSERT INTO assignment_members (assignment_id, member_kind, member_id, operation_id)
           VALUES (?,?,?,?)`,
          assignment.assignment_id,
          member.kind,
          member.entityId,
          settling.operationId
        );
      return {
        assignmentId: assignment.assignment_id,
        responsible: assignment.responsible.identity,
        recordSha256: prepared.record.sha256,
      };
    },
    options
  );
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface ProjectAssignment {
  readonly assignmentId: string;
  readonly objective: string;
  readonly responsible: { identity: string | null; basis: string };
  readonly assignedBy: { identity: string | null; basis: string };
  readonly scope: { kind: string; value: string | null };
  readonly authorizationKind: string;
  readonly sourceId: string;
  readonly validUntil: string | null;
  /** The record as it was authored, read whole: the obligations, the footprint and the prose. */
  readonly record: Assignment;
  readonly recordSha256: string;
  readonly operationId: string;
  readonly writeSequence: number;
  /** How it stood at the boundary this read was taken at, and why. */
  readonly standing: AssignmentStanding;
  readonly reason: string;
  readonly revokedBy: readonly string[];
}

export interface ProjectAssignments {
  readonly assignments: readonly ProjectAssignment[];
  /** Assignments published after the boundary, counted rather than folded into the answer. */
  readonly later: number;
  readonly truncated: number;
}

interface AssignmentRow {
  assignment_id: string;
  objective: string;
  responsible: string | null;
  responsible_basis: string;
  assigned_by: string | null;
  assigned_by_basis: string;
  scope_kind: string;
  scope_value: string | null;
  authorization_kind: string;
  source_id: string;
  valid_until: string | null;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

const ASSIGNMENT_COLUMNS = `SELECT assignment_id, objective, responsible, responsible_basis, assigned_by,
    assigned_by_basis, scope_kind, scope_value, authorization_kind, source_id, valid_until,
    hex(record_bytes) AS record_hex, record_sha256, operation_id
  FROM assignments`;

const ASSIGNMENT_BY_ID = `${ASSIGNMENT_COLUMNS} WHERE assignment_id=?`;
// Ordered by the responsible index, which is the order a listing by responsible walks.
const ASSIGNMENTS_BY_RESPONSIBLE = `${ASSIGNMENT_COLUMNS} WHERE responsible=? ORDER BY responsible, assignment_id`;
const ASSIGNMENTS_BY_MEMBER = `${ASSIGNMENT_COLUMNS}
  WHERE assignment_id IN (SELECT m.assignment_id FROM assignment_members m
    WHERE m.member_kind=? AND m.member_id=?)
  ORDER BY assignment_id`;
const ALL_ASSIGNMENTS = `${ASSIGNMENT_COLUMNS} ORDER BY assignment_id`;

/** Every revocation of one assignment that this read can see and whose scope reaches it. */
function revocationsReaching(
  view: ProjectReadView,
  projectId: string,
  assignment: Assignment,
  boundary: number
): string[] {
  const rows = view.all<{
    revocation_id: string;
    scope_kind: string;
    scope_value: string | null;
    operation_id: string;
  }>(
    `SELECT revocation_id, scope_kind, scope_value, operation_id FROM knowledge_revocations
     WHERE revoked_kind='assignment' AND revoked_id=? ORDER BY revocation_id`,
    assignment.assignment_id
  );
  const sequences = writeSequencesOf(
    view,
    rows.map((row) => row.operation_id)
  );
  return rows
    .filter((row) => {
      const writeSequence = sequences.get(row.operation_id);
      if (writeSequence === undefined || writeSequence > boundary) return false;
      const scope: AuthorityScope =
        row.scope_kind === 'project'
          ? { kind: 'project', project_id: projectId }
          : { kind: 'artifact', artifact_id: row.scope_value as string };
      return scopeReaches(scope, assignment.scope);
    })
    .map((row) => row.revocation_id);
}

function assignmentOf(
  view: ProjectReadView,
  projectId: string,
  row: AssignmentRow,
  writeSequence: number,
  request: KnowledgeReadRequest
): ProjectAssignment {
  const record = parsed(
    AssignmentSchema,
    JSON.parse(Buffer.from(row.record_hex, 'hex').toString('utf8')),
    'A retained assignment'
  );
  const revokedBy = revocationsReaching(view, projectId, record, request.knowledge_boundary);
  const { standing, reason } = assignmentStandingOf({
    revoked: revokedBy.length > 0,
    basis_stands: assignmentBasisStands(view, projectId, record, request),
    window: evaluateApplicability(assignmentWindow(record.valid_until), {
      ...(request.exceptions_judged_at === null ? {} : { time: request.exceptions_judged_at }),
    }),
  });
  return {
    assignmentId: row.assignment_id,
    objective: row.objective,
    responsible: { identity: row.responsible, basis: row.responsible_basis },
    assignedBy: { identity: row.assigned_by, basis: row.assigned_by_basis },
    scope: { kind: row.scope_kind, value: row.scope_value },
    authorizationKind: row.authorization_kind,
    sourceId: row.source_id,
    validUntil: row.valid_until,
    record,
    recordSha256: row.record_sha256,
    operationId: row.operation_id,
    writeSequence,
    standing,
    reason,
    revokedBy,
  };
}

/** One assignment by its id at a boundary, or null when this read holds no record of it. */
export function readProjectAssignment(
  view: ProjectReadView,
  projectId: string,
  assignmentId: string,
  request: KnowledgeReadRequest
): ProjectAssignment | null {
  const row = view.get<AssignmentRow>(ASSIGNMENT_BY_ID, assignmentId);
  if (row === null) return null;
  const writeSequence = writeSequencesOf(view, [row.operation_id]).get(row.operation_id);
  if (writeSequence === undefined || writeSequence > request.knowledge_boundary) return null;
  return assignmentOf(view, projectId, row, writeSequence, request);
}

export interface AssignmentReadRequest {
  /** Only the assignments naming this identity, found on the member index. */
  readonly identity?: { readonly kind: string; readonly entityId: string };
  /** Only the assignments made to this responsible party, found on the responsible index. */
  readonly responsible?: string;
  readonly maxItems?: number;
}

const DEFAULT_MAX_ASSIGNMENTS = 50;

/**
 * The assignments at a boundary, each with how it stood then.
 *
 * The boundary filters the input, which is what makes a read at an earlier boundary an answer about
 * then: an assignment published afterwards is not here, and a revocation recorded afterwards has
 * not happened yet, so an assignment revoked today reads as valid at a boundary before the
 * revocation.
 */
export function listProjectAssignments(
  view: ProjectReadView,
  projectId: string,
  request: KnowledgeReadRequest,
  input: AssignmentReadRequest = {}
): ProjectAssignments {
  const maxItems = input.maxItems ?? DEFAULT_MAX_ASSIGNMENTS;
  const rows =
    input.identity !== undefined
      ? view.all<AssignmentRow>(ASSIGNMENTS_BY_MEMBER, input.identity.kind, input.identity.entityId)
      : input.responsible !== undefined
        ? view.all<AssignmentRow>(ASSIGNMENTS_BY_RESPONSIBLE, input.responsible)
        : view.all<AssignmentRow>(ALL_ASSIGNMENTS);
  const sequences = writeSequencesOf(
    view,
    rows.map((row) => row.operation_id)
  );
  const assignments: ProjectAssignment[] = [];
  let later = 0;
  let truncated = 0;
  for (const row of rows) {
    if (input.responsible !== undefined && row.responsible !== input.responsible) continue;
    const writeSequence = sequences.get(row.operation_id);
    if (writeSequence === undefined) continue;
    if (writeSequence > request.knowledge_boundary) {
      later += 1;
      continue;
    }
    if (assignments.length >= maxItems) {
      truncated += 1;
      continue;
    }
    assignments.push(assignmentOf(view, projectId, row, writeSequence, request));
  }
  return { assignments, later, truncated };
}
