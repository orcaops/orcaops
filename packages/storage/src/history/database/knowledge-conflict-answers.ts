// Publishing the retained answer to one conflict question, either way.
//
// A refusal is kept exactly as an authorization is: it is what stops the same change being asked
// again for the same work. The answer records what was answered and about which work; it
// designates nothing itself, and the authorization an authorized answer names is the record that
// carries the permission.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireRetainedRevisions, requireStoreScope } from './knowledge-authority.js';
import {
  actingField,
  actorColumns,
  authoredRecord,
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
import { scopeColumns } from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import {
  type Actor,
  type ConflictAnswer,
  ConflictAnswerSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishConflictAnswer {
  readonly operationId: string;
  /** The answer as authored, without `answered_by`. */
  readonly answer: unknown;
  /** Who answered, which a publishing session will own once storage has one. */
  readonly answeredBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type ConflictAnswerPublication = {
  answerId: string;
  outcome: string;
  recordSha256: string;
};

function check(view: ProjectReadView, answer: ConflictAnswer): void {
  if (view.get('SELECT answer_id FROM conflict_answers WHERE answer_id=?', answer.answer_id))
    taken('That conflict answer ID already belongs to retained history');
  requireRetainedRevisions(view, [answer.rule], 'A conflict answer');
  requireRetainedSources(view, [answer.source_id]);
  // A conflict answer that names an authorization must name one that exists.
  if (
    answer.authorization_id !== null &&
    !view.get(
      'SELECT authorization_id FROM knowledge_authorizations WHERE authorization_id=?',
      answer.authorization_id
    )
  )
    missing('The authorization this answer names is not retained in this history');
}

export async function publishProjectConflictAnswer(
  handle: ProjectDatabase,
  input: PublishConflictAnswer,
  options: ProjectOperationOptions = {}
) {
  const answer = parsed(
    ConflictAnswerSchema,
    actingField(input.answer, 'answered_by', input.answeredBy),
    'A conflict answer'
  );
  requireStoreScope(handle.authority.projectId, answer.scope);
  const record = authoredRecord(answer, secretAllowList(input.secretAllow));
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.conflict.answer.publish',
    target: {
      answerId: answer.answer_id,
      ruleRevisionId: answer.rule.revision_id,
      outcome: answer.outcome,
    },
    payload: { record: record.sha256 },
    expectedState: null,
    // The answer records what was asked and decided; the authorization it names carries the act.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    check(view, answer);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): ConflictAnswerPublication => {
      check(transaction, answer);
      const [scopeKind, scopeValue] = scopeColumns(answer.scope);
      const [answerer, basis] = actorColumns(answer.answered_by);
      transaction.run(
        `INSERT INTO conflict_answers (answer_id, rule_kind, rule_id, rule_revision_id, outcome,
           scope_kind, scope_value, answered_by, answered_by_basis, authorization_id,
           record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        answer.answer_id,
        answer.rule.kind,
        answer.rule.entity_id,
        answer.rule.revision_id,
        answer.outcome,
        scopeKind,
        scopeValue,
        answerer,
        basis,
        answer.authorization_id,
        record.bytes,
        record.sha256,
        settling.operationId
      );
      return { answerId: answer.answer_id, outcome: answer.outcome, recordSha256: record.sha256 };
    },
    options
  );
}

export interface ProjectConflictAnswer {
  readonly answerId: string;
  readonly rule: { kind: string; entityId: string; revisionId: string };
  readonly outcome: string;
  readonly scope: { kind: string; value: string | null };
  readonly answeredBy: { identity: string | null; basis: string };
  readonly authorizationId: string | null;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

const ANSWER_COLUMNS = `SELECT answer_id, rule_kind, rule_id, rule_revision_id, outcome, scope_kind, scope_value,
    answered_by, answered_by_basis, authorization_id, hex(record_bytes) AS record_hex, record_sha256, operation_id
  FROM conflict_answers`;

interface AnswerRow {
  answer_id: string;
  rule_kind: string;
  rule_id: string;
  rule_revision_id: string;
  outcome: string;
  scope_kind: string;
  scope_value: string | null;
  answered_by: string | null;
  answered_by_basis: string;
  authorization_id: string | null;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

const answerRow = (row: AnswerRow): ProjectConflictAnswer => ({
  answerId: row.answer_id,
  rule: { kind: row.rule_kind, entityId: row.rule_id, revisionId: row.rule_revision_id },
  outcome: row.outcome,
  scope: { kind: row.scope_kind, value: row.scope_value },
  answeredBy: { identity: row.answered_by, basis: row.answered_by_basis },
  authorizationId: row.authorization_id,
  recordHex: row.record_hex,
  recordSha256: row.record_sha256,
  operationId: row.operation_id,
});

export function readProjectConflictAnswer(
  view: ProjectReadView,
  answerId: string
): ProjectConflictAnswer | null {
  const row = view.get<AnswerRow>(`${ANSWER_COLUMNS} WHERE answer_id=?`, answerId);
  return row === null ? null : answerRow(row);
}

/** Every answer about one rule, in the order they were retained. */
export function listProjectConflictAnswers(
  view: ProjectReadView,
  rule: { kind: string; entityId: string }
): ProjectConflictAnswer[] {
  return view
    .all<AnswerRow>(
      `${ANSWER_COLUMNS} WHERE rule_kind=? AND rule_id=? ORDER BY rowid`,
      rule.kind,
      rule.entityId
    )
    .map(answerRow);
}
