// Creating a requirement and making the first choice about it is one atomic operation.
import { afterEach, expect, it } from 'vitest';

import { createProjectRequirement } from './knowledge-requirements.js';
import { readProjectSelection } from './knowledge-selections.js';
import {
  AT,
  authorityStore,
  BY_OWNER,
  instructedBy,
  requirementRevision,
} from '../../../tests/knowledge-authority-store.js';
import {
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

/** A second requirement of the same source, so the fixture's own requirement stays untouched. */
const creation = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  selection: unknown,
  requirementId = uuidv7()
) => {
  const revision = requirementRevision(requirementId, store.sourceId);
  return {
    operationId: uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: { kind: 'authored', source_id: store.sourceId },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
    selection:
      selection === null
        ? undefined
        : {
            selection: {
              ...(selection as object),
              target: {
                kind: 'requirement',
                entity_id: requirementId,
                revision_id: revision.revision_id,
              },
            },
            selectedBy: OWNER,
            acceptedAt: AT,
          },
  };
};

const firstAdoption = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  authorization: unknown
) => ({
  selection_id: uuidv7(),
  kind: 'accepted',
  scope: store.project,
  designation: 'adopted',
  authorization,
  expected_state: { kind: 'initial' },
});

it('settles a requirement and its first selection in one operation and one change of intent', async () => {
  const store = await authorityStore();
  const adoption = firstAdoption(store, instructedBy(store.instructionId, store.project));
  const input = creation(store, adoption);
  const before = counters(store.handle);
  const operationsBefore = rowCount(store.handle, 'operations');
  const created = await createProjectRequirement(store.handle, input);
  expect(created.value.published).toBe(true);
  expect(created.value.selectionId).toBe(adoption.selection_id);
  expect(created.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  expect(rowCount(store.handle, 'operations')).toBe(operationsBefore + 1);
  const row = read(store.handle, (view) =>
    readProjectSelection(view, created.value.selectionId as string)
  )!;
  expect(row.target.revisionId).toBe(created.value.revisionId);
  // Creation has no prior token to present, so the operation's expected state is the selection's.
  expect(
    read(store.handle, (view) =>
      view.get<{ expected_state_json: string }>(
        'SELECT expected_state_json FROM operations WHERE operation_id=?',
        input.operationId
      )
    )!.expected_state_json
  ).toBe('{"kind":"initial"}');
});

it('advances the intent counter for an adoption a detector publishes', async () => {
  const store = await authorityStore();
  const input = creation(
    store,
    firstAdoption(store, instructedBy(store.instructionId, store.project))
  );
  const before = counters(store.handle);
  const created = await createProjectRequirement(store.handle, {
    ...input,
    revision: { ...input.revision, source_standing: 'extracted_candidate' },
    attributedTo: { kind: 'detector', detector: 'knowledge-processor' },
  });
  expect(created.counters.intentChangeCounter).toBe(before.intentChangeCounter + 1);
});

it('rolls the requirement back when its first selection is refused', async () => {
  const store = await authorityStore();
  const requirements = rowCount(store.handle, 'requirements');
  const before = counters(store.handle);
  await expect(
    createProjectRequirement(
      store.handle,
      creation(store, firstAdoption(store, { kind: 'approval_binding', binding_id: uuidv7() }))
    )
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(store.handle, 'requirements')).toBe(requirements);
  expect(rowCount(store.handle, 'requirement_revisions')).toBe(requirements);
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
  expect(counters(store.handle)).toEqual(before);
});

it('refuses a first selection of anything but the revision created with it', async () => {
  const store = await authorityStore();
  const input = creation(
    store,
    firstAdoption(store, instructedBy(store.instructionId, store.project))
  );
  await expect(
    createProjectRequirement(store.handle, {
      ...input,
      selection: {
        ...input.selection!,
        selection: { ...input.selection!.selection, target: store.target },
      },
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

it('creates a requirement with no selection at all', async () => {
  const store = await authorityStore();
  const created = await createProjectRequirement(store.handle, creation(store, null));
  expect(created.value.selectionId).toBeNull();
  expect(rowCount(store.handle, 'adoptions')).toBe(0);
});

/** A promotion of one passage, which is the creation a second call can repeat. */
const promotion = (
  store: Awaited<ReturnType<typeof authorityStore>>,
  selection: { selection_id: string },
  change: { operationId?: string; designation?: string } = {}
) => {
  const requirementId = promotedId;
  const revision = requirementRevision(requirementId, store.sourceId, {
    revisionId: promotedRevisionId,
  });
  return {
    operationId: change.operationId ?? uuidv7(),
    identity: {
      requirement_id: requirementId,
      origin: {
        kind: 'promoted_source',
        passage: {
          source_id: store.sourceId,
          location: 'plan_steps[0].acceptance_criteria[0].text',
          passage_sha256: digest(Buffer.from('Capture works offline')),
        },
        promoted_at: AT,
      },
    },
    revision,
    attributedTo: BY_OWNER,
    secretAllow: [],
    selection: {
      selection: {
        ...selection,
        kind: 'accepted',
        target: {
          kind: 'requirement',
          entity_id: requirementId,
          revision_id: revision.revision_id,
        },
        scope: store.project,
        designation: change.designation ?? 'adopted',
        authorization: instructedBy(store.instructionId, store.project),
        expected_state: { kind: 'initial' },
      },
      selectedBy: OWNER,
      acceptedAt: AT,
    },
  };
};

const promotedId = uuidv7();
const promotedRevisionId = uuidv7();

it('keeps the first selection in retry equality and answers only the repeat it already holds', async () => {
  const store = await authorityStore();
  const selection = { selection_id: uuidv7() };
  const operationId = uuidv7();
  const created = await createProjectRequirement(
    store.handle,
    promotion(store, selection, { operationId })
  );
  expect(created.value.selectionId).toBe(selection.selection_id);

  const replayed = await createProjectRequirement(
    store.handle,
    promotion(store, selection, { operationId })
  );
  expect(replayed).toEqual({ ...created, replayed: true });
  await expect(
    createProjectRequirement(
      store.handle,
      promotion(store, selection, { operationId, designation: 'background' })
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  // A second promotion of the passage, bringing the selection the store already holds.
  const before = counters(store.handle);
  const operations = rowCount(store.handle, 'operations');
  const again = await createProjectRequirement(store.handle, promotion(store, selection));
  expect(again).toEqual({
    value: { ...created.value, published: false },
    replayed: true,
    counters: before,
  });
  expect(rowCount(store.handle, 'operations')).toBe(operations);

  // A second promotion bringing a selection nobody retained is a new act, and refused by name.
  await expect(
    createProjectRequirement(store.handle, promotion(store, { selection_id: uuidv7() }))
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(store.handle, 'adoptions')).toBe(1);
});
