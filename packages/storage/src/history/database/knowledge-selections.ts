// Publishing a selection: a working or final recorded choice, which adopts nothing, or an
// accepted selection, which is an adoption and needs authority.
//
// The two live in different tables so neither can be read as the other. An accepted selection is
// judged inside the transaction that publishes it: the governing state it observed is computed
// from rows, its footprint is the revisions it makes stand and the adopted revisions it stands
// beside, and the authority it cites has to cover all of it. A row identical to one that still
// stands is refused, because the same approver adopting the same revision again in the same scope
// records nothing a reader could tell from the first.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  authorizationContext,
  authorizationSources,
  parseWorkContext,
  requireAuthority,
  requireAuthorizationReferences,
  requireRetainedRevisions,
  requireStoreScope,
} from './knowledge-authority.js';
import {
  type ActAuthorization,
  prepareActAuthorization,
  settleActAuthorization,
} from './knowledge-authorizations.js';
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
  retriedOperation,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import {
  adoptedBeside,
  refuseAdoptingReplaced,
  requireExpectedState,
  resolveProjectKnowledge,
  sameScope,
  scopeColumns,
} from './knowledge-standing.js';
import { type ProjectOperation, runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type ActFootprint,
  type Actor,
  type ApplicabilityInputs,
  type Selection,
  selectionFootprint,
  SelectionSchema,
} from '../../schema/knowledge-contract.js';

/** A working or final recorded choice adopts nothing and departs from nothing. */
const NOTHING_ADOPTED: ActFootprint = { adopts: [], departs_from: [], restates: [] };

export interface PublishSelection {
  readonly operationId: string;
  /** The selection as authored, without `selected_by`. */
  readonly selection: unknown;
  /** Who chose it, which a publishing session will own once storage has one. */
  readonly selectedBy: Actor;
  /** When an accepted selection was accepted; the contract's record carries no time and the row needs one. */
  readonly acceptedAt?: string;
  /** The work this act is done for, judged against the context of an authorization it reuses. */
  readonly work?: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type SelectionPublication = {
  selectionId: string;
  kind: string;
  recordSha256: string;
  /** Which table holds it: an adoption designates, a recorded choice adopts nothing. */
  recordedIn: 'adoptions' | 'recorded_choices';
};

export interface PreparedSelection {
  readonly selection: Selection;
  readonly record: AuthoredRecord;
  readonly acceptedAt: string | null;
  readonly work: ApplicabilityInputs;
  readonly authorization: ActAuthorization | null;
}

export function prepareProjectSelection(
  input: Omit<PublishSelection, 'operationId'>,
  projectId: string
): PreparedSelection {
  const selection = parsed(
    SelectionSchema,
    actingField(input.selection, 'selected_by', input.selectedBy),
    'A selection'
  );
  requireStoreScope(projectId, selection.scope);
  const accepted = selection.kind === 'accepted';
  if (!accepted && input.acceptedAt !== undefined)
    invalid('A working or final recorded choice accepts nothing, so it records no acceptance time');
  const acceptedAt = accepted
    ? parsed(InstantSchema, input.acceptedAt, 'The time this selection was accepted')
    : null;
  const work = parseWorkContext(input.work);
  return {
    selection,
    record: authoredRecord(selection, secretAllowList(input.secretAllow)),
    acceptedAt,
    work,
    // An adoption is timed by the act that published it, and so is the authorization it records
    // for itself: the two are one act.
    authorization: prepareActAuthorization({
      authorization: selection.authorization,
      grantedBy: { kind: 'actor', actor: selection.selected_by },
      recordedAt: acceptedAt ?? undefined,
      work,
      secretAllow: input.secretAllow,
    }),
  };
}

function refuseTakenSelectionId(view: ProjectReadView, selectionId: string): void {
  if (
    view.get('SELECT adoption_id FROM adoptions WHERE adoption_id=?', selectionId) ||
    view.get('SELECT selection_id FROM recorded_choices WHERE selection_id=?', selectionId)
  )
    taken('That selection ID already belongs to retained history');
}

const IDENTICAL_ADOPTION = `SELECT adoption_id FROM adoptions
  WHERE target_kind=? AND target_id=? AND target_revision_id=? AND scope_kind=? AND scope_value IS ?
    AND designation=? AND approver IS ? AND approver_basis=?`;

/**
 * A new row identical to one that still stands. The act is who adopted what, where and as what: a
 * second approval time or a different citation for the same designation adds nothing a reader
 * could tell from the first. An adoption that no longer stands is not one of these, so the same
 * approver may adopt the same revision again after a withdrawal, and a designation this approver
 * changes is a different act.
 */
function refuseAdoptionThatStillStands(
  view: ProjectReadView,
  prepared: PreparedSelection,
  resolved: ReturnType<typeof resolveProjectKnowledge>
): void {
  const { selection } = prepared;
  const [scopeKind, scopeValue] = scopeColumns(selection.scope);
  const [approver, approverBasis] = actorColumns(selection.selected_by);
  const standing = resolved.revisions.filter(
    (entry) =>
      entry.standing === 'stands' &&
      entry.designation === selection.designation &&
      entry.revision.revision_id === selection.target.revision_id &&
      entry.scope !== null &&
      sameScope(entry.scope, selection.scope)
  );
  if (standing.length === 0) return;
  const carrying = new Set(standing.flatMap((entry) => entry.stood_by));
  const identical = view
    .all<{
      adoption_id: string;
    }>(
      IDENTICAL_ADOPTION,
      selection.target.kind,
      selection.target.entity_id,
      selection.target.revision_id,
      scopeKind,
      scopeValue,
      selection.designation,
      approver,
      approverBasis
    )
    .some((row) => carrying.has(row.adoption_id));
  if (identical)
    taken('That approver already adopted this revision in this scope, and the adoption stands');
}

/**
 * Everything the store decides about a selection, run before the operation starts and again inside
 * the transaction that publishes it. It answers with the footprint it judged, which is what the
 * authorization recorded for an accepted selection has to carry.
 */
export function checkProjectSelection(
  view: ProjectReadView,
  prepared: PreparedSelection,
  projectId: string
): ActFootprint {
  const { selection, work } = prepared;
  refuseTakenSelectionId(view, selection.selection_id);
  requireRetainedRevisions(view, [selection.target], 'A selection');
  if (selection.authorization !== null)
    requireAuthorizationReferences(view, selection.authorization, 'A selection');
  const resolved = resolveProjectKnowledge(
    view,
    { kind: selection.target.kind, entity_id: selection.target.entity_id },
    projectId,
    selection.scope,
    work
  );
  requireExpectedState(selection.expected_state, resolved.governing_state);
  // An accepted selection, and only an accepted selection, rests on an authorization: a working or
  // final recorded choice adopts nothing, so there is no footprint to judge.
  if (selection.authorization === null) return NOTHING_ADOPTED;
  // An established replacement points at this revision for as long as it stands, so selecting it
  // again contradicts a record nobody withdrew. A background designation contradicts it no less:
  // the revision stands for nothing either way, and every later read carries the contradiction
  // with nothing able to clear it. Withdrawing the relationship first is what clears the way.
  refuseAdoptingReplaced(resolved, selection.target);
  const footprint = selectionFootprint(
    selection,
    adoptedBeside(resolved, selection.target, selection.scope, selection.designation)
  );
  requireAuthority({
    authorization: selection.authorization,
    scope: selection.scope,
    footprint,
    acting: { kind: 'actor', actor: selection.selected_by },
    context: authorizationContext(view, projectId, selection.authorization, work),
  });
  refuseAdoptionThatStillStands(view, prepared, resolved);
  return footprint;
}

/**
 * The operation is the one `runProjectOperation` hands its settlement, never a caller's string: the
 * row a selection writes belongs to the operation that wrote it, and nothing else may name it.
 */
export function settleProjectSelection(
  transaction: ProjectSettlement,
  operation: Readonly<ProjectOperation>,
  prepared: PreparedSelection,
  projectId: string
): SelectionPublication {
  const operationId = operation.operationId;
  const footprint = checkProjectSelection(transaction, prepared, projectId);
  const { selection, record } = prepared;
  const [scopeKind, scopeValue] = scopeColumns(selection.scope);
  const [actor, basis] = actorColumns(selection.selected_by);
  // The absent authorization is what tells the two tables apart, because only an accepted
  // selection carries one, and an accepted selection is the adoption.
  if (selection.authorization === null) {
    transaction.run(
      `INSERT INTO recorded_choices (selection_id, selection_kind, target_kind, target_id, target_revision_id,
         scope_kind, scope_value, selected_by, selected_by_basis, record_bytes, record_sha256, operation_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      selection.selection_id,
      selection.kind,
      selection.target.kind,
      selection.target.entity_id,
      selection.target.revision_id,
      scopeKind,
      scopeValue,
      actor,
      basis,
      record.bytes,
      record.sha256,
      operationId
    );
    return {
      selectionId: selection.selection_id,
      kind: selection.kind,
      recordSha256: record.sha256,
      recordedIn: 'recorded_choices',
    };
  }
  // The authorization recorded for the act is written first, because the row that names it carries
  // an immediate reference to it.
  const authorizationId = settleActAuthorization(transaction, operationId, prepared.authorization, {
    authorization: selection.authorization,
    footprint,
  });
  // The adoption table keeps no second copy of the payload, so the columns carry the authored
  // selection and the operation receipt keeps the state it observed.
  transaction.run(
    `INSERT INTO adoptions (adoption_id, target_kind, target_id, target_revision_id, approver, approver_basis,
       approved_at, scope_kind, scope_value, designation, source_refs_json, authorization_json, authorization_id, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    selection.selection_id,
    selection.target.kind,
    selection.target.entity_id,
    selection.target.revision_id,
    actor,
    basis,
    prepared.acceptedAt,
    scopeKind,
    scopeValue,
    selection.designation,
    canonicalJson([...authorizationSources(transaction, selection.authorization)]),
    canonicalJson(selection.authorization),
    authorizationId,
    operationId
  );
  return {
    selectionId: selection.selection_id,
    kind: selection.kind,
    recordSha256: record.sha256,
    recordedIn: 'adoptions',
  };
}

/** What a selection puts in the receipt: the authored record, and the two arguments beside it. */
export const selectionReceipt = (prepared: PreparedSelection) => ({
  record: prepared.record.sha256,
  acceptedAt: prepared.acceptedAt,
  work: canonicalJson(prepared.work) ?? null,
});

export async function publishProjectSelection(
  handle: ProjectDatabase,
  input: PublishSelection,
  options: ProjectOperationOptions = {}
) {
  const projectId = handle.authority.projectId;
  const prepared = prepareProjectSelection(input, projectId);
  const { selection } = prepared;
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.selection.publish',
    target: {
      selectionId: selection.selection_id,
      kind: selection.kind,
      targetRevisionId: selection.target.revision_id,
    },
    payload: selectionReceipt(prepared),
    expectedState: selection.expected_state,
    // An adoption advances the intent counter whoever published it; a recorded choice designates
    // nothing and moves neither counter beyond the write sequence.
    intentChange: selection.kind === 'accepted',
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    checkProjectSelection(view, prepared, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling) =>
      settleProjectSelection(transaction, settling, prepared, projectId),
    options
  );
}

export interface ProjectSelectionRow {
  readonly selectionId: string;
  readonly kind: string;
  readonly target: { kind: string; entityId: string; revisionId: string };
  readonly scope: { kind: string; value: string | null };
  readonly designation: string | null;
  readonly selectedBy: { identity: string | null; basis: string };
  readonly acceptedAt: string | null;
  readonly authorizationJson: string | null;
  /** The authorization written for this act, when it was published on an embedded instruction. */
  readonly authorizationId: string | null;
  readonly sourceRefs: readonly string[];
  readonly recordHex: string | null;
  readonly recordSha256: string | null;
  readonly operationId: string;
}

interface SelectionRow {
  selection_id: string;
  selection_kind: string;
  target_kind: string;
  target_id: string;
  target_revision_id: string;
  scope_kind: string;
  scope_value: string | null;
  designation: string | null;
  actor: string | null;
  actor_basis: string;
  accepted_at: string | null;
  authorization_json: string | null;
  authorization_id: string | null;
  source_refs_json: string | null;
  record_hex: string | null;
  record_sha256: string | null;
  operation_id: string;
}

const selectionQuery = (adoptions: string, choices: string) =>
  `SELECT adoption_id AS selection_id, 'accepted' AS selection_kind, target_kind, target_id,
     target_revision_id, scope_kind, scope_value, designation, approver AS actor, approver_basis AS actor_basis,
     approved_at AS accepted_at, authorization_json, authorization_id, source_refs_json,
     NULL AS record_hex, NULL AS record_sha256, operation_id
   FROM adoptions WHERE ${adoptions}
   UNION ALL
   SELECT selection_id, selection_kind, target_kind, target_id, target_revision_id, scope_kind, scope_value,
     NULL AS designation, selected_by AS actor, selected_by_basis AS actor_basis, NULL AS accepted_at,
     NULL AS authorization_json, NULL AS authorization_id, NULL AS source_refs_json,
     hex(record_bytes) AS record_hex, record_sha256, operation_id
   FROM recorded_choices WHERE ${choices}`;

const BY_IDENTITY = selectionQuery('adoption_id=?', 'selection_id=?');
const BY_TARGET = selectionQuery('target_kind=? AND target_id=?', 'target_kind=? AND target_id=?');

const selectionRow = (row: SelectionRow): ProjectSelectionRow => ({
  selectionId: row.selection_id,
  kind: row.selection_kind,
  target: {
    kind: row.target_kind,
    entityId: row.target_id,
    revisionId: row.target_revision_id,
  },
  scope: { kind: row.scope_kind, value: row.scope_value },
  designation: row.designation,
  selectedBy: { identity: row.actor, basis: row.actor_basis },
  acceptedAt: row.accepted_at,
  authorizationJson: row.authorization_json,
  authorizationId: row.authorization_id,
  sourceRefs:
    row.source_refs_json === null ? [] : (JSON.parse(row.source_refs_json) as readonly string[]),
  recordHex: row.record_hex,
  recordSha256: row.record_sha256,
  operationId: row.operation_id,
});

export function readProjectSelection(
  view: ProjectReadView,
  selectionId: string
): ProjectSelectionRow | null {
  const row = view.get<SelectionRow>(BY_IDENTITY, selectionId, selectionId);
  return row === null ? null : selectionRow(row);
}

/** Every selection of one target identity, adoptions and recorded choices alike. */
export function listProjectSelections(
  view: ProjectReadView,
  target: { kind: string; entityId: string }
): ProjectSelectionRow[] {
  return view
    .all<SelectionRow>(BY_TARGET, target.kind, target.entityId, target.kind, target.entityId)
    .map(selectionRow);
}
