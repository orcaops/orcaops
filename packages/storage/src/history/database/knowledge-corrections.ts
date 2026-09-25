// Appending a correction action: a challenge, a factual, identity or use correction, an
// acceptance, a withdrawal, an accepted replacement or a reversal.
//
// Originals survive; a correction is appended and never edits anything. Everything the contract's
// judgment treats as store knowledge is read inside the transaction that appends the act — the
// chain of actions it follows, that action's standing followers, what is known of each named
// relationship and who established it, the revisions adopted beside the one it makes stand, and
// where each restated finding originates — and the act's own attribution is this writer's argument,
// never part of the record. The row keeps what the store judged: the change class the contract
// derives, and whether the answer this store gives changed because of it.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  AUTHORITY_REFUSAL,
  authorizationContext,
  parseWorkContext,
  refuseAuthority,
  requireAuthorizationReferences,
  requireRetainedRevisions,
  requireStoreScope,
} from './knowledge-authority.js';
import {
  type ActAuthorization,
  prepareActAuthorization,
  recordsItsOwnAuthorization,
  settleActAuthorization,
} from './knowledge-authorizations.js';
import {
  actingField,
  advancesIntent,
  attributionColumns,
  type AuthoredRecord,
  authoredRecord,
  integrity,
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
  adoptedBeside,
  refuseAdoptingReplaced,
  requireExpectedState,
  resolveProjectKnowledge,
  resolveWithPendingCorrection,
  scopeColumns,
} from './knowledge-standing.js';
import { type ProjectOperation, runProjectOperation } from './transactions.js';
import { canonicalJson } from '../../events/canonical-json.js';
import {
  type ActFootprint,
  type ApplicabilityInputs,
  type Attribution,
  type AttributionBasis,
  type AuthorityScope,
  type AuthorizationRefusal,
  checkCorrection,
  type CorrectionAction,
  CorrectionActionSchema,
  type CorrectionChangeClass,
  correctionFootprint,
  type CorrectionRefusal,
  type Designation,
  type FollowedCorrection,
  type GoverningState,
  isProposingCorrection,
  MAX_FOLLOWED_CHAIN,
  type RecordRevisionRef,
  type RelationshipTarget,
} from '../../schema/knowledge-contract.js';
import type { KnowledgeTarget } from '../../schema/knowledge-resolution.js';

export interface AppendCorrection {
  readonly operationId: string;
  /** The action as authored, without `attributed_to`. */
  readonly action: unknown;
  /** Who acted, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  /** When it was appended, for the authorization an instructed act records for itself. */
  readonly recordedAt?: string;
  /** The work this act is done for, judged against the context of an authorization it reuses. */
  readonly work?: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type CorrectionAppended = {
  actionId: string;
  kind: CorrectionAction['kind'];
  /** The store's judgment, derived from the footprint it judged and never declared by the caller. */
  changeClass: CorrectionChangeClass;
  changedWhatStands: boolean;
  recordSha256: string;
  /** The authorization written for this act, when it was published on an embedded instruction. */
  authorizationId: string | null;
};

interface PreparedCorrection {
  readonly action: CorrectionAction;
  readonly record: AuthoredRecord;
  readonly work: ApplicabilityInputs;
  readonly authorization: ActAuthorization | null;
}

/** What the store judged about the act, carried from the check to the row it writes. */
interface JudgedCorrection {
  readonly footprint: ActFootprint;
  readonly changeClass: CorrectionChangeClass;
  readonly changedWhatStands: boolean;
}

const followedActionId = (action: CorrectionAction): string | null => {
  if (action.kind === 'reversal') return action.reverses_action_id;
  return action.kind === 'acceptance' ? action.accepts_action_id : null;
};

/** The revision an action makes stand, which is the one it may stand beside others with. */
const adoptedByAction = (
  action: CorrectionAction
): { revision: RecordRevisionRef; designation: Designation } | null => {
  if (action.kind === 'accepted_replacement')
    return { revision: action.replacement, designation: action.designation };
  return action.kind === 'reversal' && action.resulting_selection.kind === 'revision'
    ? {
        revision: action.resulting_selection.revision,
        designation: action.resulting_selection.designation,
      }
    : null;
};

const ACTION_BY_ID = `SELECT CAST(record_bytes AS TEXT) AS payload FROM correction_actions WHERE action_id=?`;

function retainedAction(view: ProjectReadView, actionId: string): CorrectionAction | null {
  const row = view.get<{ payload: string }>(ACTION_BY_ID, actionId);
  if (row === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
  } catch {
    integrity(
      'A retained correction action holds no readable JSON; preserve history for explicit repair'
    );
  }
  const action = CorrectionActionSchema.safeParse(value);
  if (!action.success)
    integrity(
      'A retained correction action does not read as its contract record; preserve history for explicit repair'
    );
  return action.data;
}

/**
 * The chain behind the action this act follows, read from the store link by link. One link past
 * the contract's bound is loaded on purpose, so a chain imported history made longer than the bound
 * is refused rather than silently judged as a shorter one. A chain that repeats stops where it
 * repeats: inconsistent imported history stays readable and nothing loops.
 */
function followedChain(view: ProjectReadView, action: CorrectionAction): FollowedCorrection | null {
  let next = followedActionId(action);
  const links: CorrectionAction[] = [];
  const walked = new Set<string>([action.action_id]);
  while (next !== null && links.length <= MAX_FOLLOWED_CHAIN) {
    if (walked.has(next)) break;
    walked.add(next);
    const loaded = retainedAction(view, next);
    if (loaded === null) break;
    links.push(loaded);
    next = followedActionId(loaded);
  }
  let chain: FollowedCorrection | null = null;
  for (let link = links.length - 1; link >= 0; link -= 1)
    chain = { action: links[link] as CorrectionAction, followed: chain };
  return chain;
}

const FOLLOWERS = `SELECT action_id, action_kind FROM correction_actions WHERE follows_action_id=?`;

interface FollowerRow {
  action_id: string;
  action_kind: string;
}

/** Whether a standing reversal undid this action, which is what stops it counting as a follower. */
function reversed(view: ProjectReadView, actionId: string, walked: Set<string>): boolean {
  if (walked.has(actionId)) return false;
  walked.add(actionId);
  return view
    .all<FollowerRow>(FOLLOWERS, actionId)
    .some((row) => row.action_kind === 'reversal' && !reversed(view, row.action_id, walked));
}

/**
 * The followers an action still has. One that was itself reversed no longer counts, so a single
 * unauthorized retraction can never block an authorized act for good.
 */
function standingFollowers(view: ProjectReadView, actionId: string): string[] {
  return view
    .all<FollowerRow>(FOLLOWERS, actionId)
    .filter((row) => !reversed(view, row.action_id, new Set()))
    .map((row) => row.action_id);
}

const RELATIONSHIP_TARGET = `SELECT relationship_id, relation, standing, from_entity_kind, from_entity_id,
    from_revision_id, to_entity_kind, to_entity_id, to_revision_id, attributed_kind, attributed_to,
    attributed_basis
  FROM record_relationships WHERE relationship_id=?`;

interface RelationshipTargetRow {
  relationship_id: string;
  relation: string;
  standing: string;
  from_entity_kind: string;
  from_entity_id: string;
  from_revision_id: string;
  to_entity_kind: string;
  to_entity_id: string;
  to_revision_id: string;
  attributed_kind: string;
  attributed_to: string | null;
  attributed_basis: string | null;
}

/**
 * What the store knows of each relationship the act names, including who established it: the
 * standing the relationship was published with is what decides whether it ever stood, and 'author'
 * is the released word for an actor.
 */
function relationshipTargets(
  view: ProjectReadView,
  targets: readonly RecordRevisionRef[]
): RelationshipTarget[] {
  return targets.flatMap((target) => {
    if (target.kind !== 'relationship') return [];
    const row = view.get<RelationshipTargetRow>(RELATIONSHIP_TARGET, target.entity_id);
    if (row === null) return [];
    return [
      {
        relationship_id: row.relationship_id,
        standing: row.standing as RelationshipTarget['standing'],
        relation: row.relation as RelationshipTarget['relation'],
        from: {
          kind: row.from_entity_kind,
          entity_id: row.from_entity_id,
          revision_id: row.from_revision_id,
        } as RecordRevisionRef,
        to: {
          kind: row.to_entity_kind,
          entity_id: row.to_entity_id,
          revision_id: row.to_revision_id,
        } as RecordRevisionRef,
        attributed_to:
          row.attributed_kind === 'detector'
            ? { kind: 'detector', detector: row.attributed_to ?? '' }
            : {
                kind: 'actor',
                actor: {
                  identity: row.attributed_to,
                  basis: (row.attributed_basis ?? 'unknown') as AttributionBasis,
                },
              },
      },
    ];
  });
}

/**
 * The artifact a finding originates in, read from the occurrence its revision is located at: the
 * knowledge source that occurrence names, or the capture event itself. A finding that belongs to no
 * artifact originates nowhere, and only an instruction at project scope reaches it.
 */
function findingArtifact(view: ProjectReadView, claim: RecordRevisionRef): string | null {
  const revision = view.get<{ source_event_id: string }>(
    'SELECT source_event_id FROM claim_revisions WHERE claim_id=? AND revision_id=?',
    claim.entity_id,
    claim.revision_id
  );
  if (revision === null) return null;
  const source = view.get<{ artifact_id: string | null }>(
    'SELECT artifact_id FROM knowledge_sources WHERE source_id=?',
    revision.source_event_id
  );
  if (source !== null) return source.artifact_id;
  const event = view.get<{ artifact_id: string }>(
    'SELECT artifact_id FROM artifact_events WHERE event_id=?',
    revision.source_event_id
  );
  return event === null ? null : event.artifact_id;
}

const findingsOriginateInScope = (
  view: ProjectReadView,
  footprint: ActFootprint,
  scope: AuthorityScope
): boolean =>
  scope.kind === 'artifact' &&
  footprint.restates
    .filter((ref) => ref.kind === 'claim')
    .every((claim) => findingArtifact(view, claim) === scope.artifact_id);

const identityOf = (ref: RecordRevisionRef): KnowledgeTarget => ({
  kind: ref.kind,
  entity_id: ref.entity_id,
});

const identityKey = (target: KnowledgeTarget) => `${target.kind}:${target.entity_id}`;

/** Every identity the act names, each once, in the order it named them. */
const targetIdentities = (action: CorrectionAction): KnowledgeTarget[] => [
  ...new Map(action.targets.map((ref) => [identityKey(identityOf(ref)), identityOf(ref)])).values(),
];

/** Everything a correction is refused for beyond the authority codes, which are shared. */
const REFUSAL: Record<Exclude<CorrectionRefusal, AuthorizationRefusal>, string> = {
  FOLLOWED_ACTION_REQUIRED: 'The action this act follows is not retained in this history',
  FOLLOWED_ACTION_MISMATCH: 'The action retained under that ID is not the one this act names',
  FOLLOWED_ACTION_ALREADY_FOLLOWED:
    'That action already has a standing reversal or acceptance; undo that one first',
  FOLLOWED_CHAIN_TOO_LONG:
    'This act would follow a longer chain of actions than one act may follow',
  ACCEPTS_NON_PROPOSAL: 'An acceptance follows a proposal, and that action was not one',
  TARGETS_DIFFER_FROM_FOLLOWED:
    'This act names other records than the action it follows named or made stand',
  RESTORES_WHAT_WAS_NOT_DEPARTED_FROM:
    'A reversal restores only what the action it follows departed from; adopting anything else is a replacement',
  REVERSES_ANOTHERS_ACT:
    "Undoing somebody else's act needs an instruction in the same scope as the act",
  RELATIONSHIP_TARGET_UNKNOWN: 'This act names a relationship this history does not hold',
  AUTHORIZATION_REQUIRED:
    'This act changes what stands, so it needs authority over its whole footprint',
  FINDING_OUTSIDE_ITS_ARTIFACT:
    'A finding is reached inside the artifact it originates in, or on an instruction at project scope',
};

/** A followed action and a relationship the store does not hold are missing references. */
const NOT_RETAINED: readonly CorrectionRefusal[] = [
  'FOLLOWED_ACTION_REQUIRED',
  'RELATIONSHIP_TARGET_UNKNOWN',
];

/** What each code is refused with, so the contract's examples can be replayed against the words. */
export const correctionRefusalMessage = (code: CorrectionRefusal): string =>
  code in REFUSAL
    ? REFUSAL[code as Exclude<CorrectionRefusal, AuthorizationRefusal>]
    : AUTHORITY_REFUSAL[code as AuthorizationRefusal];

function refuseCorrection(code: CorrectionRefusal): never {
  if (!(code in REFUSAL)) refuseAuthority(code as AuthorizationRefusal);
  const message = correctionRefusalMessage(code);
  if (NOT_RETAINED.includes(code)) missing(message);
  invalid(message);
}

/** Every revision the action names outside its targets, which the store must also hold. */
const namedRevisions = (action: CorrectionAction): RecordRevisionRef[] => {
  if (action.kind === 'accepted_replacement') return [action.replacement];
  if (action.kind === 'identity_correction') return [action.mistaken_predecessor];
  if (action.kind === 'use_correction') return [action.mistaken_use.target];
  return action.kind === 'reversal' && action.resulting_selection.kind === 'revision'
    ? [action.resulting_selection.revision]
    : [];
};

const merge = (states: readonly GoverningState[]): GoverningState => ({
  selection_ids: [...new Set(states.flatMap((state) => state.selection_ids))],
  correction_action_ids: [...new Set(states.flatMap((state) => state.correction_action_ids))],
});

/**
 * Everything the store decides about a correction, run before the operation starts and again inside
 * the transaction that appends it, and answering with what the row has to record.
 *
 * The expected state is the state governing every identity the act names, together: an act over two
 * identities observes both, and an act over one observes exactly what a selection of it would.
 */
export function checkProjectCorrection(
  view: ProjectReadView,
  prepared: PreparedCorrection,
  projectId: string
): JudgedCorrection {
  const { action, work } = prepared;
  if (view.get('SELECT action_id FROM correction_actions WHERE action_id=?', action.action_id))
    taken('That correction action ID already belongs to retained history');
  // A relationship the store does not hold is the contract's own refusal, judged from what this
  // writer reads of each one it names, so only the revisions are required here.
  requireRetainedRevisions(
    view,
    action.targets.filter((target) => target.kind !== 'relationship'),
    'A correction'
  );
  requireRetainedRevisions(view, namedRevisions(action), 'A correction');
  requireRetainedSources(view, [action.source_id]);
  if (action.authorization !== null)
    requireAuthorizationReferences(view, action.authorization, 'A correction');

  const followed = followedChain(view, action);
  const follows = followedActionId(action);
  const adopted = adoptedByAction(action);
  // What the identity of the revision this act makes stand holds now, which decides both the
  // revisions it would stand beside and whether a replacement still points at it.
  const adopting =
    adopted === null
      ? null
      : resolveProjectKnowledge(view, identityOf(adopted.revision), projectId, action.scope, work);
  // The state the act observed is judged before its authority, so a caller whose act is simply out
  // of date is told to read again rather than told its authority is wrong.
  const resolutions = targetIdentities(action).map((target) =>
    resolveWithPendingCorrection(view, target, projectId, action.scope, work, [
      action,
      ...chainActions(followed),
    ])
  );
  requireExpectedState(
    action.expected_state,
    merge(resolutions.map((resolution) => resolution.before.governing_state))
  );
  // An accepted replacement and a restoring reversal make a revision stand, so the replacement that
  // points at one is what a selection of it meets: the same refusal, naming the same relationship.
  if (adopted !== null && adopting !== null) refuseAdoptingReplaced(adopting, adopted.revision);
  const judged = checkCorrection({
    action,
    followed,
    standing_followers: follows === null ? [] : standingFollowers(view, follows),
    relationship_targets: relationshipTargets(view, action.targets),
    adopted_beside:
      adopted === null || adopting === null
        ? []
        : adoptedBeside(adopting, adopted.revision, action.scope, adopted.designation),
    findings_originate_in_scope: findingsOriginateInScope(
      view,
      correctionFootprint(action, followed),
      action.scope
    ),
    context:
      action.authorization === null
        ? { bindings: [], earlier: [], assignments: [] }
        : authorizationContext(view, projectId, action.authorization, work),
  });
  if (!judged.ok) refuseCorrection(judged.code);
  // What the store judged: the answer this store gives is different because of this act. The
  // proposing test in front of it is deliberate belt and braces — the resolver already answers false
  // for every proposal, which `knowledge-standing.test.ts` holds it to — because a proposal that
  // came back true would be recorded as governing something the contract says it cannot.
  const changedWhatStands =
    !isProposingCorrection(action.kind) &&
    resolutions.some((resolution) =>
      resolution.after.governing_state.correction_action_ids.includes(action.action_id)
    );
  return { footprint: judged.footprint, changeClass: judged.change_class, changedWhatStands };
}

const chainActions = (followed: FollowedCorrection | null): CorrectionAction[] => {
  const actions: CorrectionAction[] = [];
  for (let link = followed; link !== null; link = link.followed) actions.push(link.action);
  return actions;
};

export function settleProjectCorrection(
  transaction: ProjectSettlement,
  operation: Readonly<ProjectOperation>,
  prepared: PreparedCorrection,
  projectId: string
): CorrectionAppended {
  const judged = checkProjectCorrection(transaction, prepared, projectId);
  const { action, record } = prepared;
  const [scopeKind, scopeValue] = scopeColumns(action.scope);
  const [attributedKind, attributedTo, basis] = attributionColumns(action.attributed_to);
  const adopted = adoptedByAction(action);
  // The authorization recorded for the act is written first, because the row that names it carries
  // an immediate reference to it.
  const authorizationId = settleActAuthorization(
    transaction,
    operation.operationId,
    prepared.authorization,
    { authorization: action.authorization, footprint: judged.footprint }
  );
  transaction.run(
    `INSERT INTO correction_actions (action_id, action_kind, scope_kind, scope_value, attributed_kind,
       attributed_to, attributed_basis, authorization_kind, authorization_id, follows_action_id,
       resulting_selection_kind, adopted_kind, adopted_id, adopted_revision_id, adopted_designation,
       change_class, changed_what_stands, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    action.action_id,
    action.kind,
    scopeKind,
    scopeValue,
    attributedKind,
    attributedTo,
    basis,
    action.authorization === null ? null : action.authorization.kind,
    authorizationId,
    followedActionId(action),
    action.kind === 'reversal' ? action.resulting_selection.kind : null,
    adopted === null ? null : adopted.revision.kind,
    adopted === null ? null : adopted.revision.entity_id,
    adopted === null ? null : adopted.revision.revision_id,
    adopted === null ? null : adopted.designation,
    judged.changeClass,
    judged.changedWhatStands ? 1 : 0,
    record.bytes,
    record.sha256,
    operation.operationId
  );
  action.targets.forEach((target, position) => {
    transaction.run(
      `INSERT INTO correction_targets (action_id, position, target_kind, target_id, target_revision_id, operation_id)
       VALUES (?,?,?,?,?,?)`,
      action.action_id,
      position,
      target.kind,
      target.entity_id,
      target.revision_id,
      operation.operationId
    );
  });
  return {
    actionId: action.action_id,
    kind: action.kind,
    changeClass: judged.changeClass,
    changedWhatStands: judged.changedWhatStands,
    recordSha256: record.sha256,
    authorizationId,
  };
}

export function prepareProjectCorrection(
  input: Omit<AppendCorrection, 'operationId'>,
  projectId: string
): PreparedCorrection {
  const action = parsed(
    CorrectionActionSchema,
    actingField(input.action, 'attributed_to', input.attributedTo),
    'A correction'
  );
  requireStoreScope(projectId, action.scope);
  if (input.recordedAt !== undefined && !recordsItsOwnAuthorization(action.authorization))
    invalid(
      'An act published on anything but an embedded instruction records no authorization of its own, and no time for one'
    );
  const work = parseWorkContext(input.work);
  return {
    action,
    record: authoredRecord(action, secretAllowList(input.secretAllow)),
    work,
    authorization: prepareActAuthorization({
      authorization: action.authorization,
      grantedBy: action.attributed_to,
      recordedAt: input.recordedAt,
      work,
      secretAllow: input.secretAllow,
    }),
  };
}

export async function appendProjectCorrection(
  handle: ProjectDatabase,
  input: AppendCorrection,
  options: ProjectOperationOptions = {}
) {
  const projectId = handle.authority.projectId;
  const prepared = prepareProjectCorrection(input, projectId);
  const { action } = prepared;
  const op = {
    operationId: operationIdentity(input.operationId),
    kind: 'knowledge.correction.append',
    target: { actionId: action.action_id, kind: action.kind },
    payload: {
      record: prepared.record.sha256,
      recordedAt: prepared.authorization === null ? null : prepared.authorization.recordedAt,
      work: canonicalJson(prepared.work) ?? null,
    },
    expectedState: action.expected_state,
    // A correction of any kind by an actor is a change of intent, including an unaccepted
    // challenge; a detector can only propose, and proposing moves nothing.
    intentChange: advancesIntent(action.attributed_to),
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  handle.read((view) => {
    checkProjectCorrection(view, prepared, projectId);
    return null;
  });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement, settling) =>
      settleProjectCorrection(transaction, settling, prepared, projectId),
    options
  );
}

export interface ProjectCorrectionRow {
  readonly actionId: string;
  readonly kind: string;
  readonly scope: { kind: string; value: string | null };
  readonly attributedTo: { kind: string; identity: string | null; basis: string | null };
  readonly authorizationKind: string | null;
  readonly authorizationId: string | null;
  readonly followsActionId: string | null;
  readonly resultingSelectionKind: string | null;
  readonly adopted: { kind: string; entityId: string; revisionId: string } | null;
  readonly adoptedDesignation: string | null;
  readonly changeClass: string;
  readonly changedWhatStands: boolean;
  readonly targets: readonly { kind: string; entityId: string; revisionId: string }[];
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

interface CorrectionRow {
  action_id: string;
  action_kind: string;
  scope_kind: string;
  scope_value: string | null;
  attributed_kind: string;
  attributed_to: string | null;
  attributed_basis: string | null;
  authorization_kind: string | null;
  authorization_id: string | null;
  follows_action_id: string | null;
  resulting_selection_kind: string | null;
  adopted_kind: string | null;
  adopted_id: string | null;
  adopted_revision_id: string | null;
  adopted_designation: string | null;
  change_class: string;
  changed_what_stands: number;
  record_hex: string;
  record_sha256: string;
  operation_id: string;
}

const CORRECTION_COLUMNS = `SELECT action_id, action_kind, scope_kind, scope_value, attributed_kind,
    attributed_to, attributed_basis, authorization_kind, authorization_id, follows_action_id,
    resulting_selection_kind, adopted_kind, adopted_id, adopted_revision_id, adopted_designation,
    change_class, changed_what_stands, hex(record_bytes) AS record_hex, record_sha256, operation_id
  FROM correction_actions`;

const TARGETS = `SELECT target_kind, target_id, target_revision_id FROM correction_targets
  WHERE action_id=? ORDER BY position`;

const correctionRow = (view: ProjectReadView, row: CorrectionRow): ProjectCorrectionRow => ({
  actionId: row.action_id,
  kind: row.action_kind,
  scope: { kind: row.scope_kind, value: row.scope_value },
  attributedTo: {
    kind: row.attributed_kind,
    identity: row.attributed_to,
    basis: row.attributed_basis,
  },
  authorizationKind: row.authorization_kind,
  authorizationId: row.authorization_id,
  followsActionId: row.follows_action_id,
  resultingSelectionKind: row.resulting_selection_kind,
  adopted:
    row.adopted_kind === null
      ? null
      : {
          kind: row.adopted_kind,
          entityId: row.adopted_id as string,
          revisionId: row.adopted_revision_id as string,
        },
  adoptedDesignation: row.adopted_designation,
  changeClass: row.change_class,
  changedWhatStands: row.changed_what_stands === 1,
  targets: view
    .all<{
      target_kind: string;
      target_id: string;
      target_revision_id: string;
    }>(TARGETS, row.action_id)
    .map((target) => ({
      kind: target.target_kind,
      entityId: target.target_id,
      revisionId: target.target_revision_id,
    })),
  recordHex: row.record_hex,
  recordSha256: row.record_sha256,
  operationId: row.operation_id,
});

export function readProjectCorrection(
  view: ProjectReadView,
  actionId: string
): ProjectCorrectionRow | null {
  const row = view.get<CorrectionRow>(`${CORRECTION_COLUMNS} WHERE action_id=?`, actionId);
  return row === null ? null : correctionRow(view, row);
}

/** Every correction naming a revision of one identity, in the order they were appended. */
export function listProjectCorrections(
  view: ProjectReadView,
  target: { kind: string; entityId: string }
): ProjectCorrectionRow[] {
  return view
    .all<CorrectionRow>(
      `${CORRECTION_COLUMNS} WHERE action_id IN (
         SELECT action_id FROM correction_targets WHERE target_kind=? AND target_id=?)
       ORDER BY rowid`,
      target.kind,
      target.entityId
    )
    .map((row) => correctionRow(view, row));
}
