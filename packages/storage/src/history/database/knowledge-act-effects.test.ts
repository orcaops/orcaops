import { afterEach, expect, it } from 'vitest';

import { projectActCurrentlyEffective } from './knowledge-act-effects.js';
import { appendProjectCorrection } from './knowledge-corrections.js';
import { publishProjectException } from './knowledge-exceptions.js';
import { publishProjectRelationship } from './knowledge-relationships.js';
import { createProjectRequirement } from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  BY_OWNER,
  importUnreadableCorrection,
  informedBy,
  instructedBy,
  observing,
  requirementRevision,
  revokeDirectly,
  successorRevision,
} from '../../../tests/knowledge-authority-store.js';
import { discardKnowledgeStores, OWNER, read } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { AuthorityScope } from '../../schema/knowledge-contract.js';

afterEach(discardKnowledgeStores);

type Store = Awaited<ReturnType<typeof authorityStore>>;

const effective = (
  store: Store,
  kind: 'selection' | 'relationship' | 'exception' | 'correction',
  id: string,
  judgedAt: string | null = AT,
  scope: AuthorityScope = store.project
) =>
  read(store.handle, (view) =>
    projectActCurrentlyEffective(view, {
      kind,
      id,
      projectId: store.authority.projectId,
      scope,
      judgedAt,
    })
  );

it('ends a withdrawal only after a later selection restores its last effect', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const first = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: first,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const second = acceptedSelection(
    successor,
    store.project,
    informedBy(store.instructionId, [store.target], store.project),
    { expectedState: observing([first.selection_id]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: second,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const withdrawalId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: withdrawalId,
      kind: 'withdrawal',
      targets: [store.target, successor],
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target, successor], store.project),
      expected_state: observing([first.selection_id, second.selection_id]),
      reason: 'Both revisions were retired.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  expect(effective(store, 'selection', first.selection_id)).toBe(false);
  expect(effective(store, 'selection', second.selection_id)).toBe(false);
  expect(effective(store, 'correction', withdrawalId)).toBe(true);

  const restored = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project),
    { expectedState: observing([], [withdrawalId]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: restored,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

  expect(effective(store, 'correction', withdrawalId)).toBe(true);
  expect(effective(store, 'selection', restored.selection_id)).toBe(true);

  const restoredSuccessor = acceptedSelection(
    successor,
    store.project,
    informedBy(store.instructionId, [store.target], store.project),
    { expectedState: observing([restored.selection_id], [withdrawalId]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: restoredSuccessor,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });

  expect(effective(store, 'correction', withdrawalId)).toBe(false);
});

it('keeps a correction effective while a target from another identity remains stopped', async () => {
  const store = await authorityStore();
  const otherRequirementId = uuidv7();
  const otherRevision = requirementRevision(otherRequirementId, store.sourceId, {
    statement: 'Local history search works with no Cloud connection.',
  });
  await createProjectRequirement(store.handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: otherRequirementId,
      origin: { kind: 'authored', source_id: store.sourceId },
    },
    revision: otherRevision,
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const otherTarget = {
    kind: 'requirement' as const,
    entity_id: otherRequirementId,
    revision_id: otherRevision.revision_id,
  };
  const first = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  const second = acceptedSelection(
    otherTarget,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  for (const selection of [first, second])
    await publishProjectSelection(store.handle, {
      operationId: uuidv7(),
      selection,
      selectedBy: OWNER,
      acceptedAt: AT,
      secretAllow: [],
    });
  const withdrawalId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: withdrawalId,
      kind: 'withdrawal',
      targets: [store.target, otherTarget],
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target, otherTarget], store.project),
      expected_state: observing([first.selection_id, second.selection_id]),
      reason: 'Both independent requirements were retired.',
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  const restoredFirst = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project),
    { expectedState: observing([], [withdrawalId]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: restoredFirst,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(effective(store, 'correction', withdrawalId)).toBe(true);

  const restoredSecond = acceptedSelection(
    otherTarget,
    store.project,
    instructedBy(store.instructionId, store.project),
    { expectedState: observing([], [withdrawalId]) }
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: restoredSecond,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(effective(store, 'correction', withdrawalId)).toBe(false);
});

it('keeps an established ordinary relationship checked until it is withdrawn', async () => {
  const store = await authorityStore();
  const successor = await successorRevision(store);
  const relationshipId = uuidv7();
  await publishProjectRelationship(store.handle, {
    operationId: uuidv7(),
    relationship: {
      relationship_id: relationshipId,
      relation: 'depends_on',
      from: successor,
      to: store.target,
      scope: store.project,
      standing: 'established',
      authorization: null,
      source_ids: [store.sourceId],
      explanation: 'The successor depends on the original requirement.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });

  expect(effective(store, 'relationship', relationshipId)).toBe(true);

  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: uuidv7(),
      kind: 'withdrawal',
      targets: [{ kind: 'relationship', entity_id: relationshipId, revision_id: relationshipId }],
      scope: store.project,
      source_id: store.sourceId,
      authorization: null,
      expected_state: { kind: 'initial' },
      reason: 'The dependency was recorded in error.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });

  expect(effective(store, 'relationship', relationshipId)).toBe(false);
});

it('ends a replacement when its reversal restores the original revision', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const successor = await successorRevision(store);
  const replacementId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: replacementId,
      kind: 'accepted_replacement',
      targets: [store.target],
      replacement: successor,
      designation: 'adopted',
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  expect(effective(store, 'correction', replacementId)).toBe(true);

  const reversalId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: reversalId,
      kind: 'reversal',
      targets: [successor],
      reverses_action_id: replacementId,
      resulting_selection: {
        kind: 'revision',
        revision: store.target,
        designation: 'adopted',
      },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target, successor], store.project),
      expected_state: observing([], [replacementId]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  expect(effective(store, 'correction', replacementId)).toBe(false);
  expect(effective(store, 'correction', reversalId)).toBe(true);
});

it('restores an accepted correction when its reversal is reversed', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const proposalId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: proposalId,
      kind: 'challenge',
      targets: [store.target],
      scope: store.project,
      source_id: store.sourceId,
      authorization: null,
      expected_state: observing([selection.selection_id]),
      explanation: 'The recorded requirement may no longer match the intended behavior.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const acceptanceId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: acceptanceId,
      kind: 'acceptance',
      targets: [store.target],
      accepts_action_id: proposalId,
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  const reversalId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: reversalId,
      kind: 'reversal',
      targets: [store.target],
      reverses_action_id: acceptanceId,
      resulting_selection: { kind: 'none' },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id], [acceptanceId]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  const redoId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: redoId,
      kind: 'reversal',
      targets: [store.target],
      reverses_action_id: reversalId,
      resulting_selection: { kind: 'none' },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id], [acceptanceId, reversalId]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  expect(effective(store, 'correction', acceptanceId)).toBe(true);
  expect(effective(store, 'correction', reversalId)).toBe(false);
  expect(effective(store, 'correction', redoId)).toBe(true);

  const undoRedoId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: undoRedoId,
      kind: 'reversal',
      targets: [store.target],
      reverses_action_id: redoId,
      resulting_selection: { kind: 'none' },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id], [acceptanceId, reversalId, redoId]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  const finalRedoId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: finalRedoId,
      kind: 'reversal',
      targets: [store.target],
      reverses_action_id: undoRedoId,
      resulting_selection: { kind: 'none' },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing(
        [selection.selection_id],
        [acceptanceId, reversalId, redoId, undoRedoId]
      ),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  expect(effective(store, 'correction', acceptanceId)).toBe(true);
  expect(effective(store, 'correction', reversalId)).toBe(false);
  expect(effective(store, 'correction', redoId)).toBe(true);
  expect(effective(store, 'correction', undoRedoId)).toBe(false);
  expect(effective(store, 'correction', finalRedoId)).toBe(true);
});

it('keeps a sibling acceptance effective when an earlier reversal branch is reversed', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.project,
    instructedBy(store.instructionId, store.project)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const proposalId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: proposalId,
      kind: 'challenge',
      targets: [store.target],
      scope: store.project,
      source_id: store.sourceId,
      authorization: null,
      expected_state: observing([selection.selection_id]),
      explanation: 'The retained requirement may be wrong.',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  const firstAcceptanceId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: firstAcceptanceId,
      kind: 'acceptance',
      targets: [store.target],
      accepts_action_id: proposalId,
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  const retractionId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: retractionId,
      kind: 'reversal',
      targets: [store.target],
      reverses_action_id: firstAcceptanceId,
      resulting_selection: { kind: 'none' },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id], [firstAcceptanceId]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  const siblingAcceptanceId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: siblingAcceptanceId,
      kind: 'acceptance',
      targets: [store.target],
      accepts_action_id: proposalId,
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing([selection.selection_id], [firstAcceptanceId, retractionId]),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });
  const branchRedoId = uuidv7();
  await appendProjectCorrection(store.handle, {
    operationId: uuidv7(),
    action: {
      action_id: branchRedoId,
      kind: 'reversal',
      targets: [store.target],
      reverses_action_id: retractionId,
      resulting_selection: { kind: 'none' },
      scope: store.project,
      source_id: store.sourceId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      expected_state: observing(
        [selection.selection_id],
        [firstAcceptanceId, retractionId, siblingAcceptanceId]
      ),
    },
    attributedTo: BY_OWNER,
    recordedAt: AT,
    secretAllow: [],
  });

  const resolved = read(store.handle, (view) =>
    resolveProjectKnowledge(
      view,
      { kind: store.target.kind, entity_id: store.target.entity_id },
      store.authority.projectId,
      store.project,
      {}
    )
  );
  expect(resolved.revisions[0]?.challenged_by).toHaveLength(2);
  expect(resolved.revisions[0]?.challenged_by).toEqual(
    expect.arrayContaining([
      { action_id: proposalId, accepted_by: firstAcceptanceId },
      { action_id: proposalId, accepted_by: siblingAcceptanceId },
    ])
  );
  expect(effective(store, 'correction', proposalId)).toBe(true);
  expect(effective(store, 'correction', firstAcceptanceId)).toBe(true);
  expect(effective(store, 'correction', siblingAcceptanceId)).toBe(true);
  expect(effective(store, 'correction', retractionId)).toBe(false);
  expect(effective(store, 'correction', branchRedoId)).toBe(true);
});

it('stops checking an exception only after its recorded ending is proved', async () => {
  const store = await authorityStore();
  const exceptionId = uuidv7();
  await publishProjectException(store.handle, {
    operationId: uuidv7(),
    exception: {
      exception_id: exceptionId,
      expectation: store.target,
      context: { all_of: [] },
      scope: store.project,
      rationale: 'Temporary exception while the offline implementation is repaired.',
      source_id: store.instructionId,
      authorization: informedBy(store.instructionId, [store.target], store.project),
      ends: { kind: 'until_revoked' },
      end_behavior: 'expectation_applies_again',
      expected_state: { kind: 'initial' },
    },
    grantedBy: OWNER,
    work: {},
    secretAllow: [],
  });

  expect(effective(store, 'exception', exceptionId)).toBe(true);
  await revokeDirectly(store.handle, {
    revokes: { kind: 'exception', id: exceptionId },
    scope: store.project,
    sourceId: store.instructionId,
  });
  expect(effective(store, 'exception', exceptionId)).toBe(false);
});

it('keeps missing and unreadable acts checked', async () => {
  const store = await authorityStore();
  const unreadableId = await importUnreadableCorrection(store.handle, {
    target: store.target,
  });

  expect(effective(store, 'correction', unreadableId)).toBe(true);
  for (const kind of ['selection', 'relationship', 'exception', 'correction'] as const)
    expect(effective(store, kind, uuidv7())).toBe(true);
});

it('keeps a retained selection checked when its scope is unavailable to the read', async () => {
  const store = await authorityStore();
  const selection = acceptedSelection(
    store.target,
    store.artifact,
    instructedBy(store.instructionId, store.artifact)
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection,
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const anotherArtifact = { kind: 'artifact' as const, artifact_id: uuidv7() };

  expect(effective(store, 'selection', selection.selection_id, AT, anotherArtifact)).toBe(true);
});
