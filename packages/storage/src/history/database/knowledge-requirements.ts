// Creating a continuing requirement with its origin and first revision, and publishing further
// revisions of one.
//
// A promoted criterion's requirement IS that criterion, so it keeps the criterion's id and the
// writer finds the criterion inside the plan event it names. Every other origin takes a fresh
// id, and one that a criterion or a requirement already holds is refused. One promoted passage
// is one identity: promoting it again returns the requirement it already has, because an
// existing requirement is reached by a revision that restates the passage.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import { requireInterpretationSupport } from './knowledge-interpretations.js';
import {
  actingField,
  advancesIntent,
  AlreadyRetained,
  attributionColumns,
  authoredRecord,
  committedNothing,
  criterionArtifacts,
  criterionHoldsIdentity,
  criterionInPlanEvent,
  integrity,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  publishUnlessRetained,
  replayOperation,
  requireRetainedSources,
  requireRetainedSubject,
  requireRevisionContinues,
  retainedExpectationRevision,
  retriedOperation,
  revisionLineage,
  secretAllowList,
  taken,
} from './knowledge-record-input.js';
import {
  prepareProjectSelection,
  type PublishSelection,
  readProjectSelection,
  selectionReceipt,
  settleProjectSelection,
} from './knowledge-selections.js';
import { runProjectOperation } from './transactions.js';
import {
  type Attribution,
  type CriterionReference,
  type RequirementIdentity,
  RequirementIdentitySchema,
  type RequirementRevision,
  RequirementRevisionSchema,
} from '../../schema/knowledge-contract.js';

export interface PublishRequirementRevision {
  readonly operationId: string;
  /** The revision as authored, without `attributed_to`. */
  readonly revision: unknown;
  /** Who this revision is by, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export interface CreateRequirement extends PublishRequirementRevision {
  /** The identity and its origin, written atomically with the first revision. */
  readonly identity: unknown;
  /**
   * The requirement's first selection, settled in the same operation, so creation and the choice
   * made with it are one atomic act whose expected state is `initial`.
   */
  readonly selection?: Omit<PublishSelection, 'operationId' | 'secretAllow'>;
}

export type RequirementCreation = {
  requirementId: string;
  revisionId: string;
  identitySha256: string;
  revisionSha256: string;
  /** False when the passage already had this requirement, which this call returned unwritten. */
  published: boolean;
  /** The first selection settled with the creation, when the caller made one. */
  selectionId: string | null;
};

export type RequirementRevisionPublication = {
  requirementId: string;
  revisionId: string;
  recordSha256: string;
};

export interface PreparedRequirementRevision {
  readonly operationId: string;
  readonly revision: RequirementRevision;
  readonly record: ReturnType<typeof authoredRecord>;
}

export function prepareRequirementRevision(
  input: PublishRequirementRevision
): PreparedRequirementRevision {
  const revision = parsed(
    RequirementRevisionSchema,
    actingField(input.revision, 'attributed_to', input.attributedTo),
    'A requirement revision'
  );
  return {
    operationId: operationIdentity(input.operationId),
    revision,
    record: authoredRecord(revision, secretAllowList(input.secretAllow)),
  };
}

export function refuseTakenRequirementRevision(view: ProjectReadView, revisionId: string): void {
  if (view.get('SELECT revision_id FROM requirement_revisions WHERE revision_id=?', revisionId))
    taken('That requirement revision ID already belongs to retained history');
}

export function requireRevisionReferences(
  view: ProjectReadView,
  revision: RequirementRevision
): void {
  requireRetainedSources(view, [
    ...revision.source_ids,
    ...revision.passages.map((passage) => passage.source_id),
  ]);
  requireRetainedSubject(view, revision.subject);
  requireInterpretationSupport(
    view,
    'requirement',
    revision.requirement_id,
    revision.revision_id,
    revision.interpretation,
    revision.passages
  );
}

export function insertRequirementRevision(
  transaction: ProjectSettlement,
  prepared: PreparedRequirementRevision
): void {
  const { revision, record, operationId } = prepared;
  const [kind, name, basis] = attributionColumns(revision.attributed_to);
  transaction.run(
    `INSERT INTO requirement_revisions (revision_id, requirement_id, previous_revision_id,
       subject_id, subject_revision_id, source_standing, duration_kind,
       attributed_kind, attributed_to, attributed_basis, record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    revision.revision_id,
    revision.requirement_id,
    revision.previous_revision_id,
    revision.subject === null ? null : revision.subject.subject_id,
    revision.subject === null ? null : revision.subject.subject_revision_id,
    revision.source_standing,
    revision.duration.kind,
    kind,
    name,
    basis,
    record.bytes,
    record.sha256,
    operationId
  );
}

type OriginColumns = [
  originKind: string,
  derivedFromKind: string | null,
  criterionArtifactId: string | null,
  criterionPlanEventId: string | null,
  criterionId: string | null,
  expectationKind: string | null,
  expectationId: string | null,
  expectationRevisionId: string | null,
  passageSourceId: string | null,
  passageLocation: string | null,
  passageSha256: string | null,
  interpretationId: string | null,
];

const withCriterion = (
  originKind: string,
  derivedFromKind: string | null,
  criterion: CriterionReference
): OriginColumns => [
  originKind,
  derivedFromKind,
  criterion.artifact_id,
  criterion.plan_event_id,
  criterion.criterion_id,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];

function originColumns(origin: RequirementIdentity['origin']): OriginColumns {
  if (origin.kind === 'promoted_criterion')
    return withCriterion('promoted_criterion', null, origin.criterion);
  if (origin.kind === 'promoted_source')
    return [
      'promoted_source',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      origin.passage.source_id,
      origin.passage.location,
      origin.passage.passage_sha256,
      null,
    ];
  if (origin.kind === 'authored')
    return ['authored', null, null, null, null, null, null, null, null, null, null, null];
  if (origin.kind === 'interpreted_source')
    return [
      'interpreted_source',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      origin.interpretation_id,
    ];
  if (origin.derived_from.kind === 'criterion')
    return withCriterion('derived', 'criterion', origin.derived_from.criterion);
  const { expectation } = origin.derived_from;
  return [
    'derived',
    'expectation',
    null,
    null,
    null,
    expectation.kind,
    expectation.entity_id,
    expectation.revision_id,
    null,
    null,
    null,
    null,
  ];
}

export function insertRequirementIdentity(
  transaction: ProjectSettlement,
  prepared: PreparedRequirementIdentity,
  firstRevisionId: string,
  operationId: string
): void {
  transaction.run(
    `INSERT INTO requirements (requirement_id, first_revision_id, origin_kind, derived_from_kind,
       criterion_artifact_id, criterion_plan_event_id, criterion_id,
       expectation_kind, expectation_id, expectation_revision_id,
       passage_source_id, passage_location, passage_sha256, interpretation_id,
       record_bytes, record_sha256, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    prepared.identity.requirement_id,
    firstRevisionId,
    ...originColumns(prepared.identity.origin),
    prepared.record.bytes,
    prepared.record.sha256,
    operationId
  );
}

export interface PreparedRequirementIdentity {
  readonly identity: RequirementIdentity;
  readonly record: ReturnType<typeof authoredRecord>;
}

export function prepareRequirementIdentity(
  identity: unknown,
  secretAllow: readonly string[]
): PreparedRequirementIdentity {
  const parsedIdentity = parsed(RequirementIdentitySchema, identity, 'A requirement identity');
  return {
    identity: parsedIdentity,
    record: authoredRecord(parsedIdentity, secretAllowList(secretAllow)),
  };
}

/** The requirement a promoted passage already has, if any. One passage is one identity. */
export const retainedPromotedPassage = (
  view: ProjectReadView,
  origin: RequirementIdentity['origin']
) =>
  origin.kind !== 'promoted_source'
    ? null
    : view.get<{ requirement_id: string; first_revision_id: string; record_sha256: string }>(
        "SELECT requirement_id, first_revision_id, record_sha256 FROM requirements WHERE origin_kind='promoted_source' AND passage_source_id=? AND passage_location=? AND passage_sha256=?",
        origin.passage.source_id,
        origin.passage.location,
        origin.passage.passage_sha256
      );

export function requireRequirementOrigin(
  view: ProjectReadView,
  identity: RequirementIdentity
): void {
  const { origin } = identity;
  if (origin.kind === 'promoted_criterion') {
    // A promoted criterion becomes the continuing identity, so an id two artifacts' plans both
    // hold names no one criterion and nothing may be promoted under it.
    if (criterionArtifacts(view, origin.criterion.criterion_id).length > 1)
      invalid(
        'That criterion id is in the plans of more than one artifact, so it names no one criterion'
      );
    if (!criterionInPlanEvent(view, origin.criterion))
      missing('The promoted criterion is not in the plan event this identity names');
    return;
  }
  if (criterionHoldsIdentity(view, identity.requirement_id))
    taken('A retained plan criterion already holds that identity; promote that criterion instead');
  if (origin.kind === 'promoted_source') {
    requireRetainedSources(view, [origin.passage.source_id]);
    return;
  }
  if (origin.kind === 'authored') {
    requireRetainedSources(view, [origin.source_id]);
    return;
  }
  if (origin.kind === 'interpreted_source') return;
  requireRetainedSources(view, [origin.source_id]);
  if (origin.derived_from.kind === 'criterion') {
    if (!criterionInPlanEvent(view, origin.derived_from.criterion))
      missing('The criterion this requirement derives from is not in the plan event it names');
    return;
  }
  if (!retainedExpectationRevision(view, origin.derived_from.expectation))
    missing('The expectation revision this requirement derives from is not retained');
}

export async function createProjectRequirement(
  handle: ProjectDatabase,
  input: CreateRequirement,
  options: ProjectOperationOptions = {}
) {
  const prepared = prepareRequirementRevision(input);
  const preparedIdentity = prepareRequirementIdentity(input.identity, input.secretAllow);
  const identity = preparedIdentity.identity;
  const { revision, record } = prepared;
  if (revision.requirement_id !== identity.requirement_id)
    invalid('The first revision belongs to the identity created with it');
  if (revision.previous_revision_id !== null)
    invalid('A requirement is created with its first revision, which continues nothing');
  const originRecord = preparedIdentity.record;
  const projectId = handle.authority.projectId;
  const selection =
    input.selection === undefined
      ? null
      : prepareProjectSelection({ ...input.selection, secretAllow: input.secretAllow }, projectId);
  if (
    selection !== null &&
    (selection.selection.target.kind !== 'requirement' ||
      selection.selection.target.entity_id !== identity.requirement_id ||
      selection.selection.target.revision_id !== revision.revision_id)
  )
    invalid('A first selection selects the first revision of the requirement created with it');
  const op = {
    operationId: prepared.operationId,
    kind: 'knowledge.requirement.create',
    target: {
      requirementId: identity.requirement_id,
      revisionId: revision.revision_id,
      origin: identity.origin.kind,
    },
    // Both payload hashes cover every authored field of the two records written together, so a
    // retry under this operation id with any of them altered conflicts.
    payload: {
      identity: originRecord.sha256,
      revision: record.sha256,
      selection: selection === null ? null : selectionReceipt(selection),
    },
    // Creation has no prior token to present, so the first selection's own precondition is the
    // operation's: it holds only while nothing governs the new revision yet.
    expectedState: selection === null ? null : selection.selection.expected_state,
    // An adoption advances the counter on its own, whatever the revision's attribution says.
    intentChange:
      advancesIntent(revision.attributed_to) || selection?.selection.kind === 'accepted',
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  /**
   * What the store already holds for this passage, if anything. The caller gets it back only
   * when it authored exactly what is retained, which is what a worker's replay derives; anything
   * else is a second identity for one passage wearing a repeat's clothes, so it is refused by
   * name and pointed at the contract's remedy.
   */
  const retainedForPassage = (view: ProjectReadView): RequirementCreation | null => {
    const existing = retainedPromotedPassage(view, identity.origin);
    if (!existing) return null;
    const first = view.get<{ record_sha256: string }>(
      'SELECT record_sha256 FROM requirement_revisions WHERE revision_id=?',
      existing.first_revision_id
    );
    if (!first)
      integrity(
        'A retained requirement is missing the first revision it names; preserve history for explicit repair'
      );
    if (existing.record_sha256 !== originRecord.sha256 || first.record_sha256 !== record.sha256)
      taken(
        `That passage is already requirement ${existing.requirement_id}; publish a revision of it that restates the passage instead of promoting the passage again`
      );
    // A repeat may not silently drop the selection the caller brought with it: only the selection
    // this creation already retained is answered, and any other is a new act of its own.
    if (selection !== null && readProjectSelection(view, selection.selection.selection_id) === null)
      taken(
        `That passage is already requirement ${existing.requirement_id}; publish this selection of its revision on its own`
      );
    return {
      requirementId: existing.requirement_id,
      revisionId: existing.first_revision_id,
      identitySha256: existing.record_sha256,
      revisionSha256: first.record_sha256,
      published: false,
      selectionId: selection === null ? null : selection.selection.selection_id,
    };
  };
  const check = (view: ProjectReadView) => {
    const retained = retainedForPassage(view);
    if (retained) return retained;
    if (
      view.get(
        'SELECT requirement_id FROM requirements WHERE requirement_id=?',
        identity.requirement_id
      )
    )
      taken('That requirement identity already exists; publish a revision of it instead');
    refuseTakenRequirementRevision(view, revision.revision_id);
    requireRequirementOrigin(view, identity);
    requireRevisionReferences(view, revision);
    return null;
  };
  const retained = handle.read(check).value;
  // A passage that already has its requirement is not promoted again, and a call that publishes
  // nothing runs no operation: no receipt, and neither counter moves.
  if (retained) return committedNothing(handle, retained);
  return publishUnlessRetained(
    handle,
    op,
    (transaction: ProjectSettlement, settling): RequirementCreation => {
      const existing = check(transaction);
      if (existing) throw new AlreadyRetained(existing);
      insertRequirementRevision(transaction, prepared);
      insertRequirementIdentity(
        transaction,
        preparedIdentity,
        revision.revision_id,
        op.operationId
      );
      // The first selection is settled here, after the revision it selects exists and inside the
      // same transaction, so a refusal of the selection rolls the requirement back with it.
      if (selection !== null) settleProjectSelection(transaction, settling, selection, projectId);
      return {
        requirementId: identity.requirement_id,
        revisionId: revision.revision_id,
        identitySha256: originRecord.sha256,
        revisionSha256: record.sha256,
        published: true,
        selectionId: selection === null ? null : selection.selection.selection_id,
      };
    },
    options
  );
}

export async function publishProjectRequirementRevision(
  handle: ProjectDatabase,
  input: PublishRequirementRevision,
  options: ProjectOperationOptions = {}
) {
  const prepared = prepareRequirementRevision(input);
  const { revision, record } = prepared;
  const op = {
    operationId: prepared.operationId,
    kind: 'knowledge.requirement.revision.publish',
    target: { requirementId: revision.requirement_id, revisionId: revision.revision_id },
    payload: { record: record.sha256 },
    expectedState: { previousRevisionId: revision.previous_revision_id },
    intentChange: advancesIntent(revision.attributed_to),
  } as const;
  if (retriedOperation(handle, op.operationId)) return replayOperation(handle, op, options);
  const continues = (view: ProjectReadView) => {
    if (
      !view.get(
        'SELECT requirement_id FROM requirements WHERE requirement_id=?',
        revision.requirement_id
      )
    )
      missing('The revision continues a requirement this history does not hold');
    refuseTakenRequirementRevision(view, revision.revision_id);
    requireRevisionReferences(view, revision);
    requireRevisionContinues(
      revisionLineage(view, 'requirement_revisions', 'requirement_id', revision.requirement_id),
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
    (transaction: ProjectSettlement): RequirementRevisionPublication => {
      continues(transaction);
      insertRequirementRevision(transaction, prepared);
      return {
        requirementId: revision.requirement_id,
        revisionId: revision.revision_id,
        recordSha256: record.sha256,
      };
    },
    options
  );
}

export interface ProjectRequirementRevisionRow {
  readonly revisionId: string;
  readonly previousRevisionId: string | null;
  readonly sourceStanding: string;
  readonly durationKind: string;
  readonly attribution: { kind: string; name: string | null; basis: string | null };
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
}

export interface ProjectRequirement {
  readonly requirementId: string;
  readonly firstRevisionId: string;
  readonly originKind: string;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly operationId: string;
  readonly revisions: ProjectRequirementRevisionRow[];
}

export function readProjectRequirement(
  view: ProjectReadView,
  requirementId: string
): ProjectRequirement | null {
  const identity = view.get<{
    requirement_id: string;
    first_revision_id: string;
    origin_kind: string;
    record_hex: string;
    record_sha256: string;
    operation_id: string;
  }>(
    'SELECT requirement_id, first_revision_id, origin_kind, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM requirements WHERE requirement_id=?',
    requirementId
  );
  if (!identity) return null;
  const revisions = view
    .all<{
      revision_id: string;
      previous_revision_id: string | null;
      source_standing: string;
      duration_kind: string;
      attributed_kind: string;
      attributed_to: string | null;
      attributed_basis: string | null;
      record_hex: string;
      record_sha256: string;
      operation_id: string;
    }>(
      'SELECT revision_id, previous_revision_id, source_standing, duration_kind, attributed_kind, attributed_to, attributed_basis, hex(record_bytes) AS record_hex, record_sha256, operation_id FROM requirement_revisions WHERE requirement_id=? ORDER BY rowid',
      requirementId
    )
    .map((row) => ({
      revisionId: row.revision_id,
      previousRevisionId: row.previous_revision_id,
      sourceStanding: row.source_standing,
      durationKind: row.duration_kind,
      attribution: {
        kind: row.attributed_kind,
        name: row.attributed_to,
        basis: row.attributed_basis,
      },
      recordHex: row.record_hex,
      recordSha256: row.record_sha256,
      operationId: row.operation_id,
    }));
  return {
    requirementId: identity.requirement_id,
    firstRevisionId: identity.first_revision_id,
    originKind: identity.origin_kind,
    recordHex: identity.record_hex,
    recordSha256: identity.record_sha256,
    operationId: identity.operation_id,
    revisions,
  };
}
