// Publishing an authorization: the retained instruction, exactly the footprint it authorized, and
// the work context it was given for.
//
// This is what a `reused_authorization` cites, so a later session can finish or repeat the same
// act without asking again. It designates nothing itself — the act it was recorded with is what
// moved what stands — so publishing one moves no intent counter.
//
// An act published under an embedded instruction records one of these inside its own transaction,
// which is how a revocation of that authorization reaches what was published under it without
// being cited. That record is written here too, through the same row-writing, so the two can never
// drift apart.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireRetainedRevisions, requireStoreScope } from './knowledge-authority.js';
import {
  actingField,
  actorColumns,
  type AuthoredRecord,
  authoredRecord,
  InstantSchema,
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
import { scopeColumns } from './knowledge-standing.js';
import { runProjectOperation } from './transactions.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import {
  type ActFootprint,
  type Actor,
  type ApplicabilityInputs,
  type ApplicabilitySelector,
  type Attribution,
  type Authorization,
  type AuthorizationRecord,
  AuthorizationRecordSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishAuthorization {
  readonly operationId: string;
  /** The authorization as authored, without `granted_by`. */
  readonly authorization: unknown;
  /** Who gave it, which a publishing session will own once storage has one. */
  readonly grantedBy: Actor;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type AuthorizationPublication = { authorizationId: string; recordSha256: string };

function check(view: ProjectReadView, record: AuthorizationRecord): void {
  if (
    view.get(
      'SELECT authorization_id FROM knowledge_authorizations WHERE authorization_id=?',
      record.authorization_id
    )
  )
    taken('That authorization ID already belongs to retained history');
  requireRetainedSources(view, [record.instruction.instruction_source_id]);
  if (record.instruction.kind === 'informed_instruction')
    requireRetainedRevisions(
      view,
      record.instruction.acknowledged,
      "An authorization's instruction"
    );
  // An authorization names the footprint it authorized, so every revision in that footprint is one
  // this history holds: a footprint over records nobody retained authorizes nothing.
  requireRetainedRevisions(
    view,
    [
      ...record.adopts.map((adoption) => adoption.revision),
      ...record.departs_from.map((departure) => departure.rule),
      ...record.departs_from.flatMap((departure) =>
        departure.replaced_by === null ? [] : [departure.replaced_by]
      ),
      ...record.restates,
    ],
    'An authorization'
  );
}

/** The one place an authorization row is written, whoever publishes it. */
function insertAuthorization(
  transaction: ProjectSettlement,
  operationId: string,
  record: AuthorizationRecord,
  authored: AuthoredRecord
): void {
  const [scopeKind, scopeValue] = scopeColumns(record.instruction.scope);
  const [granter, basis] = actorColumns(record.granted_by);
  transaction.run(
    `INSERT INTO knowledge_authorizations (authorization_id, instruction_kind, instruction_source_id,
       scope_kind, scope_value, granted_by, granted_by_basis, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    record.authorization_id,
    record.instruction.kind,
    record.instruction.instruction_source_id,
    scopeKind,
    scopeValue,
    granter,
    basis,
    authored.bytes,
    authored.sha256,
    operationId
  );
}

const CONTEXT_DIMENSIONS = ['subject', 'software_version', 'environment', 'work_context'] as const;

/**
 * The work an act was done for, as the context that narrows the authorization recorded for it. The
 * work's `time` takes no part: it says when the act happened, and neither `before` nor `from` states
 * that, so an act done for work no dimension describes records an authorization with no context,
 * which covers its footprint wherever its own scope reaches.
 */
function workAsContext(work: ApplicabilityInputs): ApplicabilitySelector | null {
  const all_of = CONTEXT_DIMENSIONS.flatMap((dimension) => {
    const values = work[dimension];
    return values === undefined || values.length === 0
      ? []
      : [{ dimension, operator: 'any_of' as const, values: [...values] }];
  });
  return all_of.length === 0 ? null : { all_of };
}

/** What an act carries into its own transaction to record the authorization it rests on. */
export interface ActAuthorization {
  readonly authorizationId: string;
  readonly recordedAt: string;
  readonly grantedBy: Actor;
  readonly context: ApplicabilitySelector | null;
  readonly secretAllow: readonly string[];
}

/** Only an act published under an embedded instruction records an authorization of its own. */
export const recordsItsOwnAuthorization = (authorization: Authorization | null): boolean =>
  authorization !== null &&
  (authorization.kind === 'informed_instruction' || authorization.kind === 'explicit_instruction');

/**
 * Prepared outside the transaction, for an act that embeds an instruction. The id is the store's,
 * like every other value a writer derives rather than takes: nothing in the act names it, and the
 * operation receipt is what makes a retry idempotent. The time is the caller's argument, the way an
 * acceptance time is, because storage has no clock and no publishing session to take one from.
 */
export function prepareActAuthorization(input: {
  /** The act's own attribution: only an actor is granted an authorization. */
  authorization: Authorization | null;
  grantedBy: Attribution;
  recordedAt?: string;
  work: ApplicabilityInputs;
  secretAllow: readonly string[];
}): ActAuthorization | null {
  if (!recordsItsOwnAuthorization(input.authorization)) return null;
  if (input.grantedBy.kind !== 'actor')
    invalid('A detector proposes; an authorization is granted by an actor');
  return {
    authorizationId: uuidv7(),
    recordedAt: parsed(InstantSchema, input.recordedAt, 'The time this act was published'),
    grantedBy: input.grantedBy.actor,
    context: workAsContext(input.work),
    secretAllow: secretAllowList(input.secretAllow),
  };
}

/**
 * The authorization an act records for itself, written inside the act's own transaction and
 * carrying exactly the footprint the store judged the act on — which is why it cannot be built
 * before that transaction reads what the act stands beside.
 *
 * An act that authorizes nothing records none: a reversal of somebody else's proposal departs from
 * nothing and adopts nothing, and an authorization over an empty footprint is one the contract
 * refuses. Every reference the record names — the instruction's source, the rules it acknowledges,
 * the revisions in the footprint — the act itself already required of this history.
 */
export function settleActAuthorization(
  transaction: ProjectSettlement,
  operationId: string,
  prepared: ActAuthorization | null,
  act: { authorization: Authorization | null; footprint: ActFootprint }
): string | null {
  if (prepared === null) return null;
  const { adopts, departs_from, restates } = act.footprint;
  if (adopts.length === 0 && departs_from.length === 0 && restates.length === 0) return null;
  const record = parsed(
    AuthorizationRecordSchema,
    {
      authorization_id: prepared.authorizationId,
      instruction: act.authorization,
      adopts: adopts.map((adoption) => ({
        revision: adoption.revision,
        designation: adoption.designation,
      })),
      departs_from: [...departs_from],
      restates: [...restates],
      context: prepared.context,
      granted_by: prepared.grantedBy,
      recorded_at: prepared.recordedAt,
    },
    'The authorization recorded for this act'
  );
  insertAuthorization(
    transaction,
    operationId,
    record,
    authoredRecord(record, prepared.secretAllow)
  );
  return record.authorization_id;
}

export async function publishProjectAuthorization(
  handle: ProjectDatabase,
  input: PublishAuthorization,
  options: ProjectOperationOptions = {}
) {
  const record = parsed(
    AuthorizationRecordSchema,
    actingField(input.authorization, 'granted_by', input.grantedBy),
    'An authorization'
  );
  requireStoreScope(handle.authority.projectId, record.instruction.scope);
  const authored = authoredRecord(record, secretAllowList(input.secretAllow));
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.authorization.publish',
    target: {
      authorizationId: record.authorization_id,
      instruction: record.instruction.kind,
      sourceId: record.instruction.instruction_source_id,
    },
    payload: { record: authored.sha256 },
    expectedState: null,
    // Evidence that an act was allowed; the act it was recorded with is what changed what stands.
    intentChange: false,
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    check(view, record);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling): AuthorizationPublication => {
      check(transaction, record);
      insertAuthorization(transaction, settling.operationId, record, authored);
      return { authorizationId: record.authorization_id, recordSha256: authored.sha256 };
    },
    options
  );
}

export interface ProjectAuthorization {
  readonly authorizationId: string;
  readonly instruction: { kind: string; sourceId: string };
  readonly scope: { kind: string; value: string | null };
  readonly grantedBy: { identity: string | null; basis: string };
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export function readProjectAuthorization(
  view: ProjectReadView,
  authorizationId: string
): ProjectAuthorization | null {
  const row = view.get<{
    authorization_id: string;
    instruction_kind: string;
    instruction_source_id: string;
    scope_kind: string;
    scope_value: string | null;
    granted_by: string | null;
    granted_by_basis: string;
    record_hex: string;
    record_sha256: string;
    operation_id: string;
  }>(
    `SELECT authorization_id, instruction_kind, instruction_source_id, scope_kind, scope_value,
       granted_by, granted_by_basis, hex(record_bytes) AS record_hex, record_sha256, operation_id
     FROM knowledge_authorizations WHERE authorization_id=?`,
    authorizationId
  );
  return row === null
    ? null
    : {
        authorizationId: row.authorization_id,
        instruction: { kind: row.instruction_kind, sourceId: row.instruction_source_id },
        scope: { kind: row.scope_kind, value: row.scope_value },
        grantedBy: { identity: row.granted_by, basis: row.granted_by_basis },
        recordHex: row.record_hex,
        recordSha256: row.record_sha256,
        operationId: row.operation_id,
      };
}
