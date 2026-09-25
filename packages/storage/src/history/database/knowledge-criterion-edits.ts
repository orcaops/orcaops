// Editing a criterion that was promoted to a continuing requirement, under one of the two
// actions the contract names.
//
// `revise_shared_requirement` writes a proposed revision of the continuing identity and nothing
// else, so adoption and pinned uses do not move. `change_task_acceptance` records nothing at
// all — not a row, not a receipt, neither counter: the local criterion it describes belongs to
// the task's own plan revision, and schema 31 has nowhere to keep that criterion's text, so this
// writer only confirms the shared revision the local change must not waive and says where the
// change is kept. An edit that names neither action fails to parse, so nothing shared is written
// for it and no wording is read as an action.
import { type ProjectDatabase, type ProjectReadView } from './connection.js';
import {
  advancesIntent,
  authoredRecord,
  committedNothing,
  composedRecord,
  invalid,
  missing,
  operationIdentity,
  parsed,
  type ProjectOperationOptions,
  type ProjectSettlement,
  replayOperation,
  requireRevisionContinues,
  retriedOperation,
  revisionLineage,
  secretAllowList,
} from './knowledge-record-input.js';
import {
  insertRequirementRevision,
  prepareRequirementRevision,
  refuseTakenRequirementRevision,
  requireRevisionReferences,
} from './knowledge-requirements.js';
import { runProjectOperation } from './transactions.js';
import {
  type Attribution,
  AttributionSchema,
  type PromotedCriterionEdit,
  PromotedCriterionEditSchema,
} from '../../schema/knowledge-contract.js';

export interface EditPromotedCriterion {
  readonly operationId: string;
  /** The edit, which names its action. */
  readonly edit: unknown;
  /** Who the edit is by, which a publishing session will own once storage has one. */
  readonly attributedTo: Attribution;
  /**
   * The rest of the proposed revision for `revise_shared_requirement`: everything a requirement
   * revision needs beyond the identity, predecessor, statement and rationale the edit carries.
   */
  readonly sharedRevision?: unknown;
  /** The refused content this publication is allowed to carry, as the capture path takes it. */
  readonly secretAllow: readonly string[];
}

export type PromotedCriterionEditOutcome = {
  action: PromotedCriterionEdit['action'];
  requirementId: string;
  /** The proposed shared revision, or null when the edit changed nothing shared. */
  revisionId: string | null;
  recordSha256: string | null;
  /** Where the change is kept: this store's shared revision, or the task's own plan revision. */
  recordedBy: 'shared_revision' | 'task_plan_revision';
};

function requirePromotedCriterion(view: ProjectReadView, edit: PromotedCriterionEdit): void {
  const identity = view.get<{ origin_kind: string }>(
    'SELECT origin_kind FROM requirements WHERE requirement_id=?',
    edit.requirement.entity_id
  );
  if (!identity) missing('The edit names a requirement this history does not hold');
  if (identity.origin_kind !== 'promoted_criterion')
    invalid(
      'That requirement was not promoted from a criterion; revise it as an ordinary revision'
    );
  if (
    !view.get(
      'SELECT revision_id FROM requirement_revisions WHERE requirement_id=? AND revision_id=?',
      edit.requirement.entity_id,
      edit.requirement.revision_id
    )
  )
    missing('The edit names a shared revision this history does not hold');
}

export async function editProjectPromotedCriterion(
  handle: ProjectDatabase,
  input: EditPromotedCriterion,
  options: ProjectOperationOptions = {}
) {
  const operationId = operationIdentity(input.operationId);
  const edit = parsed(PromotedCriterionEditSchema, input.edit, 'A promoted criterion edit');
  if (edit.requirement.kind !== 'requirement')
    invalid('A promoted criterion is a continuing requirement');
  // Validated whether or not this action writes a shared revision: an edit is by somebody, and
  // an argument with no runtime schema is not validated at all.
  const attributedTo = parsed(AttributionSchema, input.attributedTo, 'An edit attribution');
  const allow = secretAllowList(input.secretAllow);
  const editRecord = authoredRecord(edit, allow);
  if (edit.action === 'change_task_acceptance' && input.sharedRevision !== undefined)
    invalid('Changing a task’s acceptance conditions writes no shared revision');
  if (edit.action === 'revise_shared_requirement' && input.sharedRevision === undefined)
    invalid('A proposed shared revision needs the fields the edit itself does not carry');
  const revision =
    edit.action === 'revise_shared_requirement'
      ? prepareRequirementRevision({
          operationId,
          revision: composedRecord(input.sharedRevision, {
            requirement_id: edit.requirement.entity_id,
            previous_revision_id: edit.requirement.revision_id,
            statement: edit.proposed_statement,
            rationale: edit.rationale,
          }),
          attributedTo,
          secretAllow: allow,
        })
      : null;
  const op = {
    operationId,
    kind: 'knowledge.promoted_criterion.edit',
    target: {
      requirementId: edit.requirement.entity_id,
      revisionId: edit.requirement.revision_id,
      action: edit.action,
    },
    payload: {
      edit: editRecord.sha256,
      revision: revision === null ? null : revision.record.sha256,
    },
    expectedState: null,
    intentChange: revision !== null && advancesIntent(revision.revision.attributed_to),
  } as const;
  if (retriedOperation(handle, operationId)) return replayOperation(handle, op, options);
  const check = (view: ProjectReadView) => {
    requirePromotedCriterion(view, edit);
    if (revision === null) {
      if (
        edit.action === 'change_task_acceptance' &&
        !view.get('SELECT artifact_id FROM artifacts WHERE artifact_id=?', edit.artifact_id)
      )
        missing('The edit names an artifact this history does not hold');
      return;
    }
    refuseTakenRequirementRevision(view, revision.revision.revision_id);
    requireRevisionReferences(view, revision.revision);
    requireRevisionContinues(
      revisionLineage(view, 'requirement_revisions', 'requirement_id', edit.requirement.entity_id),
      revision.revision
    );
  };
  handle.read((view) => {
    check(view);
    return null;
  });
  // The shared requirement is confirmed and left exactly as it stands, and the change itself is
  // kept by the task's own plan revision, so this store records nothing and runs no operation.
  if (revision === null)
    return committedNothing<PromotedCriterionEditOutcome>(handle, {
      action: edit.action,
      requirementId: edit.requirement.entity_id,
      revisionId: null,
      recordSha256: null,
      recordedBy: 'task_plan_revision',
    });
  return runProjectOperation(
    handle,
    op,
    (transaction: ProjectSettlement): PromotedCriterionEditOutcome => {
      check(transaction);
      insertRequirementRevision(transaction, revision);
      return {
        action: edit.action,
        requirementId: edit.requirement.entity_id,
        revisionId: revision.revision.revision_id,
        recordSha256: revision.record.sha256,
        recordedBy: 'shared_revision',
      };
    },
    options
  );
}
