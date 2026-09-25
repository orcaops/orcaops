// A read at an earlier knowledge boundary reproduces what stood then, while a later correction
// appears only in the current read.
import { afterEach, expect, it } from 'vitest';

import { publishProjectConflictAnswer } from './knowledge-conflict-answers.js';
import { publishProjectException } from './knowledge-exceptions.js';
import { type KnowledgeBoundary, knowledgeReadRequest } from './knowledge-read-boundary.js';
import { readProjectGoverningState } from './knowledge-read-governing.js';
import { publishProjectRevocation } from './knowledge-revocations.js';
import { publishProjectSelection } from './knowledge-selections.js';
import {
  acceptedSelection,
  adoptOnBranch,
  AT,
  type AuthorityStore,
  authorityStore,
  establishReplacement,
  informedBy,
  instructedBy,
  observing,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import { requirementThatMoved } from '../../../tests/knowledge-read-store.js';
import { counters, discardKnowledgeStores, OWNER, read } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

const governing = (
  moved: { store: AuthorityStore },
  boundary: KnowledgeBoundary,
  exceptionsJudgedAt: string | null = null
) =>
  read(moved.store.handle, (view) =>
    readProjectGoverningState(
      view,
      { kind: 'requirement', entity_id: moved.store.requirementId },
      moved.store.authority.projectId,
      knowledgeReadRequest(view, {
        scope: moved.store.project,
        mode: boundary === 'now' ? 'current' : 'historical',
        boundary,
        exceptionsJudgedAt,
      })
    )
  );

const entryFor = (
  answer: ReturnType<typeof governing>,
  revisionId: string,
  standing: 'stands' | 'stopped' | 'unadopted'
) =>
  answer.resolved.revisions.filter(
    (entry) => entry.revision.revision_id === revisionId && entry.standing === standing
  );

it('reproduces the one adopted revision at the boundary it was adopted at', async () => {
  const moved = await requirementThatMoved();
  const answer = governing(moved, moved.boundaries.adopted);
  expect(answer.coverage.boundary).toBe(moved.boundaries.adopted);
  expect(answer.coverage.mode).toBe('historical');
  expect(answer.resolved.revisions).toEqual([
    expect.objectContaining({
      revision: moved.adopted,
      standing: 'stands',
      designation: 'adopted',
      stood_by: [moved.adoptionId],
    }),
  ]);
  expect(answer.resolved.governing_state).toEqual({
    selection_ids: [moved.adoptionId],
    correction_action_ids: [],
  });
});

it('shows the replacement standing at the boundary it replaced at, and the replaced revision stopped', async () => {
  const moved = await requirementThatMoved();
  const answer = governing(moved, moved.boundaries.replaced);
  expect(entryFor(answer, moved.replacement.revision_id, 'stands')).toEqual([
    expect.objectContaining({
      designation: 'adopted',
      stood_by: [moved.replacementSelectionId],
    }),
  ]);
  expect(entryFor(answer, moved.adopted.revision_id, 'stopped')).toEqual([
    expect.objectContaining({
      because: expect.arrayContaining([
        {
          record: 'relationship',
          record_id: moved.relationshipId,
          effect: 'superseded_by_relationship',
        },
      ]),
    }),
  ]);
});

it('keeps a later withdrawal out of the historical answer and names it as a later record', async () => {
  const moved = await requirementThatMoved();
  const answer = governing(moved, moved.boundaries.replaced);
  expect(
    answer.resolved.revisions.some(
      (entry) =>
        entry.revision.revision_id === moved.replacement.revision_id &&
        entry.because.some((reason) => reason.record_id === moved.withdrawalId)
    )
  ).toBe(false);
  expect(answer.resolved.governing_state.correction_action_ids).not.toContain(moved.withdrawalId);
  expect(answer.coverage.later).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        record: 'correction',
        record_id: moved.withdrawalId,
        write_sequence: moved.boundaries.withdrawn,
      }),
    ])
  );
});

it('shows the withdrawal in the current read', async () => {
  const moved = await requirementThatMoved();
  const answer = governing(moved, 'now');
  expect(answer.coverage.mode).toBe('current');
  expect(answer.coverage.boundary).toBe(moved.boundaries.withdrawn);
  expect(entryFor(answer, moved.replacement.revision_id, 'stopped')).toEqual([
    expect.objectContaining({
      because: expect.arrayContaining([
        { record: 'correction', record_id: moved.withdrawalId, effect: 'withdrawn' },
      ]),
    }),
  ]);
  expect(entryFor(answer, moved.replacement.revision_id, 'stands')).toEqual([]);
  expect(answer.coverage.later).toEqual([]);
});

it('carries the basis the answer was computed from', async () => {
  const moved = await requirementThatMoved();
  const answer = governing(moved, moved.boundaries.adopted);
  expect(answer.resolved.basis).toEqual({
    scope: moved.store.project,
    mode: 'historical',
    knowledge_boundary: moved.boundaries.adopted,
    implementation: { kind: 'none_selected' },
    applicability: {},
    exceptions_judged_at: null,
  });
  expect(answer.target).toEqual({
    kind: 'requirement',
    entity_id: moved.store.requirementId,
  });
});

it('reports a branch-scoped row where the resolver reports it', async () => {
  const moved = await requirementThatMoved();
  const adoptionId = await adoptOnBranch(moved.store.handle, {
    target: moved.adopted,
    branch: 'feature/offline',
  });
  const answer = governing(moved, 'now');
  expect(answer.coverage.branchScoped).toEqual([
    expect.objectContaining({
      record_id: adoptionId,
      record: 'selection',
      branch: 'feature/offline',
    }),
  ]);
  expect(answer.coverage.omitted).toEqual(
    expect.arrayContaining([
      { record: 'branch_scoped_row', record_id: adoptionId, reason: 'branch_scope' },
    ])
  );
});

/** One adopted requirement, and the write sequence that adoption committed at. */
async function adopted() {
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
  return { store, adoption, boundary: counters(store.handle).writeSequence };
}

const CLOUD_ONLY = {
  all_of: [{ dimension: 'work_context', operator: 'any_of', values: ['cloud-only-report'] }],
};

/** An exception of the store's own target, ended only by an explicit revocation. */
const grantException = (store: AuthorityStore, exceptionId: string, adoptionId: string) =>
  publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: store.target,
      context: CLOUD_ONLY,
      scope: store.project,
      rationale: 'The usage report is Cloud-only by nature.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: observing([adoptionId]),
    },
    grantedBy: OWNER,
    work: { work_context: ['cloud-only-report'] },
    secretAllow: [],
  });

const laterIds = (answer: ReturnType<typeof governing>, record: string) =>
  answer.coverage.later.filter((entry) => entry.record === record).map((entry) => entry.record_id);

it('names a selection published after the boundary and lets it stand for nothing', async () => {
  const { store, adoption, boundary } = await adopted();
  const successor = await successorRevision(store);
  const later = acceptedSelection(
    successor,
    store.project,
    informedBy(store.instructionId, [store.target], store.project),
    { expectedState: observing([adoption.selection_id]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: later,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

  const answer = governing({ store }, boundary);
  expect(laterIds(answer, 'selection')).toEqual([later.selection_id]);
  expect(answer.resolved.governing_state.selection_ids).toEqual([adoption.selection_id]);
  expect(answer.resolved.revisions.map((entry) => entry.revision.revision_id)).not.toContain(
    successor.revision_id
  );
});

it('names a relationship established after the boundary and applies none of it', async () => {
  const { store, boundary } = await adopted();
  const successor = await successorRevision(store);
  const relationshipId = await establishReplacement(store.handle, {
    from: successor,
    to: store.target,
    scope: store.project,
    sourceId: store.instructionId,
  });

  const answer = governing({ store }, boundary);
  expect(laterIds(answer, 'relationship')).toEqual([relationshipId]);
  expect(answer.resolved.relationships).toEqual([]);
  expect(
    answer.resolved.revisions.filter(
      (entry) => entry.revision.revision_id === store.target.revision_id
    )
  ).toEqual([expect.objectContaining({ standing: 'stands' })]);
});

it('names an exception granted after the boundary and holds nothing back for it', async () => {
  const { store, adoption, boundary } = await adopted();
  const exceptionId = uuidv7();
  await grantException(store, exceptionId, adoption.selection_id);

  const answer = governing({ store }, boundary, AT);
  expect(laterIds(answer, 'exception')).toEqual([exceptionId]);
  expect(answer.resolved.exceptions).toEqual([]);
});

it('names a revocation published after the boundary and keeps the exception standing', async () => {
  const { store, adoption } = await adopted();
  const exceptionId = uuidv7();
  await grantException(store, exceptionId, adoption.selection_id);
  const boundary = counters(store.handle).writeSequence;

  const revocationId = uuidv7();
  await publishProjectRevocation(store.handle, {
    operationId: uuidv7(),
    revocation: {
      revocation_id: revocationId,
      revokes: { kind: 'exception', id: exceptionId },
      scope: store.project,
      source_id: store.instructionId,
      instruction: instructedBy(store.instructionId, store.project),
      recorded_at: AT,
    },
    revokedBy: OWNER,
    secretAllow: [],
  });

  const answer = governing({ store }, boundary, AT);
  expect(laterIds(answer, 'revocation')).toEqual([revocationId]);
  expect(answer.resolved.exceptions).toEqual([
    expect.objectContaining({ exception_id: exceptionId, standing: 'in_effect', revoked_by: [] }),
  ]);
});

it('names a conflict answer given after the boundary and answers no conflict with it', async () => {
  const { store, boundary } = await adopted();
  const answerId = uuidv7();
  await publishProjectConflictAnswer(store.handle, {
    operationId: uuidv7(),
    answer: {
      answer_id: answerId,
      rule: store.target,
      outcome: 'declined',
      context: CLOUD_ONLY,
      scope: store.project,
      source_id: store.instructionId,
      answered_at: AT,
      authorization_id: null,
    },
    answeredBy: OWNER,
    secretAllow: [],
  });

  const answer = governing({ store }, boundary);
  expect(laterIds(answer, 'conflict_answer')).toEqual([answerId]);
  expect(answer.resolved.conflicts).toEqual([]);
});

it('names a branch-scoped row written after the boundary and reports none of it', async () => {
  const { store, boundary } = await adopted();
  const branchAdoptionId = await adoptOnBranch(store.handle, {
    target: store.target,
    branch: 'feature/offline',
  });

  const answer = governing({ store }, boundary);
  expect(laterIds(answer, 'branch_scoped_row')).toEqual([branchAdoptionId]);
  expect(answer.coverage.branchScoped).toEqual([]);
});
