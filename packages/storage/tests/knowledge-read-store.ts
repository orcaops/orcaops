// A real project database whose history moves, so a read can be taken at each boundary it moved
// through: a requirement adopted, replaced on an informed instruction, and the replacement
// withdrawn. Each step records the write sequence it committed at, which is what a read at that
// boundary names.
import {
  acceptedSelection,
  AT,
  type AuthorityStore,
  authorityStore,
  BY_OWNER,
  establishReplacement,
  informedBy,
  instructedBy,
  observing,
  requirementRevision,
  withdrawRevision,
} from './knowledge-authority-store.js';
import { counters, OWNER } from './knowledge-store.js';
import { canonicalJson } from '../src/events/canonical-json.js';
import { type ProjectDatabase } from '../src/history/database/connection.js';
import { publishProjectRequirementRevision } from '../src/history/database/knowledge-requirements.js';
import { publishProjectSelection } from '../src/history/database/knowledge-selections.js';
import { runProjectOperation } from '../src/history/database/transactions.js';
import { digest } from '../src/history/event-integrity.js';
import { uuidv7 } from '../src/ids/uuidv7.js';
import type { ExpectationRevisionRef } from '../src/schema/knowledge-contract.js';

export interface RequirementThatMoved {
  readonly store: AuthorityStore;
  /** The revision the requirement was created and adopted with. */
  readonly adopted: ExpectationRevisionRef;
  /** The revision that replaced it, adopted on an informed instruction and later withdrawn. */
  readonly replacement: ExpectationRevisionRef;
  readonly adoptionId: string;
  readonly replacementSelectionId: string;
  readonly relationshipId: string;
  readonly withdrawalId: string;
  /** The write sequence each step committed at. */
  readonly boundaries: {
    readonly adopted: number;
    readonly replaced: number;
    readonly withdrawn: number;
  };
}

export async function requirementThatMoved(): Promise<RequirementThatMoved> {
  const store = await authorityStore();
  const adoption = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: adoption,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const adopted = counters(store.handle).writeSequence;

  const successor = requirementRevision(store.requirementId, store.sourceId, {
    previousRevisionId: store.revisionId,
    statement:
      'Local capture works with no Cloud connection, and says so when it cannot reach one.',
  });
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: successor,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const replacement: ExpectationRevisionRef = {
    kind: 'requirement',
    entity_id: store.requirementId,
    revision_id: successor.revision_id,
  };
  const replacementSelection = acceptedSelection(
    replacement,
    store.project,
    informedBy(store.instructionId, [store.target], store.project),
    { expectedState: observing([adoption.selection_id]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: replacementSelection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const relationshipId = await establishReplacement(store.handle, {
    from: replacement,
    to: store.target,
    scope: store.project,
    sourceId: store.instructionId,
  });
  const replaced = counters(store.handle).writeSequence;

  const withdrawalId = await withdrawRevision(store.handle, {
    target: replacement,
    scope: store.project,
    sourceId: store.instructionId,
    instructionId: store.instructionId,
    expectedState: observing([replacementSelection.selection_id]),
  });
  const withdrawn = counters(store.handle).writeSequence;

  return {
    store,
    adopted: store.target,
    replacement,
    adoptionId: adoption.selection_id,
    replacementSelectionId: replacementSelection.selection_id,
    relationshipId,
    withdrawalId,
    boundaries: { adopted, replaced, withdrawn },
  };
}

/**
 * A requirement revision row whose payload will not read as its contract record, as an upgrade, an
 * import or a build older than the contract can leave one. Every lookup column is well formed, so
 * nothing but the record itself is unreadable.
 */
export async function revisionWithUnreadableRecord(
  handle: ProjectDatabase,
  requirementId: string,
  previousRevisionId: string | null
): Promise<string> {
  const revisionId = uuidv7();
  const bytes = Buffer.from(canonicalJson({ revision_id: revisionId, note: 'not a revision' })!);
  await runProjectOperation(
    handle,
    {
      operationId: uuidv7(),
      kind: 'knowledge.requirement.revision.imported',
      target: { revisionId },
      payload: { record: digest(bytes) },
      expectedState: null,
      intentChange: false,
    },
    (transaction, settling) => {
      transaction.run(
        `INSERT INTO requirement_revisions (revision_id, requirement_id, previous_revision_id,
           source_standing, duration_kind, attributed_kind, attributed_to, attributed_basis,
           record_bytes, record_sha256, operation_id)
         VALUES (?,?,?,'explicit_instruction','continuing','actor',?,?,?,?,?)`,
        revisionId,
        requirementId,
        previousRevisionId,
        OWNER.identity,
        OWNER.basis,
        bytes,
        digest(bytes),
        settling.operationId
      );
      return { revisionId };
    }
  );
  return revisionId;
}
