import { afterEach, expect, it } from 'vitest';

import {
  type InterpretedRecord,
  publishInterpretedKnowledge,
  StaleInterpretedState,
} from './knowledge-interpretation.js';
import { listProjectRelationships } from './knowledge-relationships.js';
import { readProjectRequirement } from './knowledge-requirements.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { publishProjectKnowledgeSource, readProjectKnowledgeSource } from './knowledge-sources.js';
import { resolveProjectKnowledge } from './knowledge-standing.js';
import { listProjectTaskUses } from './knowledge-task-uses.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  informedBy,
} from '../../../tests/knowledge-authority-store.js';
import {
  BY_OWNER,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  OWNER,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import type { ExpectedState } from '../../schema/knowledge-contract.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

type Store = Awaited<ReturnType<typeof authorityStore>>;

const NOTHING_GOVERNS: ExpectedState = {
  kind: 'observed',
  selection_ids: [],
  correction_action_ids: [],
};

const STATEMENT = 'Notes are flushed to disk before the screen reports them saved.';
const CHOICE = 'Writes go through a temporary file and a rename.';

/** The capture field the interpreted attempt read, exactly as the worker names one. */
const sourceOf = (store: Store) => ({
  source_id: `${store.plan.planEventId}#task#0`,
  occurrence: {
    kind: 'capture_field' as const,
    artifact_id: store.plan.artifactId,
    event_id: store.plan.planEventId,
    field_path: 'task',
    position: 0,
  },
  source_author: OWNER,
  interpreted_by: DETECTOR,
  access_restriction: null,
});

const passageOf = (sourceId: string, text: string) => ({
  source_id: sourceId,
  location: `bytes:0-${Buffer.byteLength(text)}`,
  passage_sha256: digest(Buffer.from(text)),
});

/**
 * A plan of the shape reconciliation builds: a requirement candidate with the identity it mints,
 * a decision candidate, a relationship suggested onto the store's existing requirement, a
 * proposing correction of it and the background use it was connected to later.
 */
function planRecords(
  store: Store,
  ids: {
    requirementId: string;
    requirementRevisionId: string;
    decisionId: string;
    decisionRevisionId: string;
    relationshipId: string;
    actionId: string;
  },
  restsOn: ExpectedState = NOTHING_GOVERNS
): InterpretedRecord[] {
  const sourceId = sourceOf(store).source_id;
  const rests = [
    { target: { kind: 'requirement', entity_id: store.requirementId }, state: restsOn },
  ];
  const common = {
    applicability: { all_of: [] },
    source_ids: [sourceId],
    source_standing: 'extracted_candidate',
    recorded_at: AT,
  };
  return [
    {
      kind: 'requirement_revision',
      identity: {
        requirement_id: ids.requirementId,
        origin: {
          kind: 'promoted_source',
          passage: passageOf(sourceId, STATEMENT),
          promoted_at: AT,
        },
      },
      revision: {
        ...common,
        requirement_id: ids.requirementId,
        revision_id: ids.requirementRevisionId,
        previous_revision_id: null,
        statement: STATEMENT,
        rationale: null,
        subject: null,
        duration: { kind: 'unknown' },
        passages: [passageOf(sourceId, STATEMENT)],
      },
      restsOn: [],
    },
    {
      kind: 'decision_revision',
      revision: {
        ...common,
        decision_id: ids.decisionId,
        revision_id: ids.decisionRevisionId,
        previous_revision_id: null,
        chosen_approach: CHOICE,
        rationale: 'A technician must not lose a note to a crash.',
        alternatives: [],
        assumptions: [],
        reconsideration_conditions: [],
        subject: null,
        derivation: null,
        passages: [passageOf(sourceId, CHOICE)],
      },
      occurrence: { source_id: sourceId, location: passageOf(sourceId, CHOICE).location },
      restsOn: [],
    },
    {
      kind: 'relationship',
      relationship: {
        relationship_id: ids.relationshipId,
        relation: 'challenges',
        from: {
          kind: 'requirement',
          entity_id: ids.requirementId,
          revision_id: ids.requirementRevisionId,
        },
        to: store.target,
        scope: store.artifact,
        standing: 'suggested',
        authorization: null,
        source_ids: [sourceId],
        explanation: 'Suggested by the detector: the passage contradicts the retained rule.',
      },
      restsOn: rests,
    },
    {
      kind: 'correction',
      action: {
        action_id: ids.actionId,
        kind: 'challenge',
        targets: [store.target],
        scope: store.artifact,
        source_id: sourceId,
        authorization: null,
        expected_state: restsOn,
        explanation: 'The source says the opposite of what this rule requires.',
      },
      restsOn: rests,
    },
    {
      kind: 'task_use',
      use: {
        artifact_id: store.plan.artifactId,
        plan_event_id: store.plan.planEventId,
        target: store.target,
        role: 'background',
        local: null,
        exception_id: null,
      },
      discovery: { discovered_at: AT, discovered_by: DETECTOR },
      restsOn: rests,
    },
  ];
}

const freshIds = () => ({
  requirementId: uuidv7(),
  requirementRevisionId: uuidv7(),
  decisionId: uuidv7(),
  decisionRevisionId: uuidv7(),
  relationshipId: uuidv7(),
  actionId: uuidv7(),
});

const publish = (store: Store, records: InterpretedRecord[]) =>
  publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    source: sourceOf(store),
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records,
    secretAllow: [],
  });

/** Adopts the store's requirement, which is what moves the state a plan's records rest on. */
async function adoptTheRequirement(store: Store): Promise<string> {
  const selectionId = uuidv7();
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.artifact,
      informedBy(store.instructionId, [store.target], store.artifact),
      { selectionId }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  return selectionId;
}

it('publishes a whole plan under one operation, with nothing carrying authority', async () => {
  const store = await authorityStore();
  const ids = freshIds();

  const published = await publish(store, planRecords(store, ids));

  expect(published.replayed).toBe(false);
  expect(published.value.published.map((entry) => entry.kind)).toEqual([
    'requirement_revision',
    'decision_revision',
    'relationship',
    'correction',
    'task_use',
  ]);
  expect(published.value.published.every((entry) => !entry.replay)).toBe(true);

  // One operation wrote the source and every record of the plan, so there is exactly one
  // operation for the attempt to name.
  const operations = read(store.handle, (view) => [
    ...view
      .all<{ operation_id: string }>(
        `SELECT operation_id FROM knowledge_sources WHERE source_id=?
         UNION SELECT operation_id FROM requirements WHERE requirement_id=?
         UNION SELECT operation_id FROM requirement_revisions WHERE revision_id=?
         UNION SELECT operation_id FROM decision_revisions WHERE revision_id=?
         UNION SELECT operation_id FROM record_relationships WHERE relationship_id=?
         UNION SELECT operation_id FROM correction_actions WHERE action_id=?
         UNION SELECT operation_id FROM task_uses WHERE plan_event_id=? AND selection_kind='connected_later'`,
        published.value.sourceId,
        ids.requirementId,
        ids.requirementRevisionId,
        ids.decisionRevisionId,
        ids.relationshipId,
        ids.actionId,
        store.plan.planEventId
      )
      .map((row) => row.operation_id),
  ]);
  expect(operations).toHaveLength(1);

  const requirement = read(store.handle, (view) => readProjectRequirement(view, ids.requirementId));
  expect(requirement?.revisions[0]?.sourceStanding).toBe('extracted_candidate');
  expect(requirement?.revisions[0]?.attribution).toEqual({
    kind: 'detector',
    name: DETECTOR.detector,
    basis: null,
  });
  const relationship = read(store.handle, (view) =>
    listProjectRelationships(view, { kind: 'requirement', entityId: store.requirementId })
  ).find((row) => row.relationshipId === ids.relationshipId);
  expect(relationship?.standing).toBe('suggested');
  expect(relationship?.attributedTo.kind).toBe('detector');
  expect(
    read(store.handle, (view) =>
      view.get<{ authorization_id: string | null; changed_what_stands: number }>(
        'SELECT authorization_id, changed_what_stands FROM correction_actions WHERE action_id=?',
        ids.actionId
      )
    )
  ).toEqual({ authorization_id: null, changed_what_stands: 0 });
  const uses = read(store.handle, (view) =>
    listProjectTaskUses(view, store.plan.planEventId)
  ).filter((row) => row.selectionKind === 'connected_later');
  expect(uses.map((row) => row.role)).toEqual(['background']);
  expect(uses[0]?.discoveredBy).toEqual({ kind: 'detector', name: DETECTOR.detector, basis: null });
  expect(
    read(store.handle, (view) => readProjectKnowledgeSource(view, published.value.sourceId))
      ?.interpretedBy
  ).toEqual({ kind: 'detector', name: DETECTOR.detector, basis: null });
});

it('writes nothing at all for a plan with no records, not even the source', async () => {
  const store = await authorityStore();
  const before = counters(store.handle);

  const published = await publish(store, []);

  expect(published.replayed).toBe(true);
  expect(published.value.published).toEqual([]);
  // The source is published because the records cite it; with no records nothing would.
  expect(
    read(store.handle, (view) => readProjectKnowledgeSource(view, sourceOf(store).source_id))
  ).toBeNull();
  expect(counters(store.handle)).toEqual(before);
});

it('cites the source a person already made of the passage, and authors no second one', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  // A person recorded the passage as a source before the detector read it: their own reading of
  // it, with nobody named as its interpreter.
  const theirs = uuidv7();
  await publishProjectKnowledgeSource(store.handle, {
    operationId: uuidv7(),
    source: { ...sourceOf(store), source_id: theirs, interpreted_by: null },
    recordedBy: OWNER,
    secretAllow: [],
  });

  const published = await publish(store, planRecords(store, ids));

  // One capture field occurrence is one source: the plan cites theirs, and the store holds no
  // source under the detector's own id.
  expect(published.value.sourceId).toBe(theirs);
  expect(published.value.sourceReplay).toBe(true);
  expect(
    read(store.handle, (view) => readProjectKnowledgeSource(view, sourceOf(store).source_id))
  ).toBeNull();
  const cited = read(store.handle, (view) =>
    view.all<{ source_id: string }>(
      'SELECT passage_source_id AS source_id FROM requirements WHERE requirement_id=?',
      ids.requirementId
    )
  ).map((row) => row.source_id);
  expect(cited).toEqual([theirs]);
  expect(
    read(
      store.handle,
      (view) =>
        view.get<{ n: number }>(
          "SELECT count(*) AS n FROM knowledge_sources WHERE source_kind='capture_field' AND event_id=? AND field_path='task' AND position=0",
          store.plan.planEventId
        )!.n
    )
  ).toBe(1);
});

it('moves neither counter, because an extracted candidate changes no intent', async () => {
  const store = await authorityStore();
  const before = counters(store.handle);

  await publish(store, planRecords(store, freshIds()));

  const after = counters(store.handle);
  expect(after.intentChangeCounter).toBe(before.intentChangeCounter);
  expect(after.writeSequence).toBe(before.writeSequence + 1);
});

it('publishes nothing on a replay of the same derivation, and moves no counter', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  await publish(store, planRecords(store, ids));
  const before = counters(store.handle);

  const again = await publish(store, planRecords(store, ids));

  expect(again.replayed).toBe(true);
  expect(again.value.sourceReplay).toBe(true);
  expect(again.value.published.every((entry) => entry.replay)).toBe(true);
  expect(counters(store.handle)).toEqual(before);
  expect(rowCount(store.handle, 'requirement_revisions')).toBe(2);
});

it('replays the operation that first retained the interpreted source', async () => {
  const store = await authorityStore();
  const records = planRecords(store, freshIds());
  const input = {
    operationId: uuidv7(),
    source: sourceOf(store),
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records,
    secretAllow: [],
  };
  const first = await publishInterpretedKnowledge(store.handle, input);
  const beforeReplay = counters(store.handle);

  await expect(publishInterpretedKnowledge(store.handle, input)).resolves.toEqual({
    ...first,
    replayed: true,
  });
  expect(counters(store.handle)).toEqual(beforeReplay);

  const requirement = records[0] as Extract<InterpretedRecord, { kind: 'requirement_revision' }>;
  await expect(
    publishInterpretedKnowledge(store.handle, {
      ...input,
      records: [
        {
          ...requirement,
          revision: {
            ...(requirement.revision as object),
            rationale: 'Changed after the first request.',
          },
        },
        ...records.slice(1),
      ],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

it('refuses a second record under an identity this store already holds', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  await publish(store, planRecords(store, ids));

  const records = planRecords(store, ids);
  const requirement = records[0] as Extract<InterpretedRecord, { kind: 'requirement_revision' }>;
  // A time is enough: what makes a repeat answerable is the bytes, so a record whose identity is
  // derived from the source and whose times are not derives a record this store can never accept.
  // That is why the plan builder takes every time a record keeps from the source and not a clock.
  await expect(
    publish(store, [
      {
        ...requirement,
        revision: { ...(requirement.revision as object), recorded_at: '2027-02-02T02:02:00.000Z' },
      },
    ])
  ).rejects.toThrow(/already retained as a different record/);
});

it('adds no second edge when one source suggests the same relationship twice', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  await publish(store, planRecords(store, ids));
  const records = planRecords(store, { ...ids, requirementId: ids.requirementId });
  const relationship = records[2] as Extract<InterpretedRecord, { kind: 'relationship' }>;

  // The same edge noticed at another passage of the same source: one relationship id, and the
  // wording of the passage that first noticed it is what the row keeps.
  const again = await publish(store, [
    {
      ...relationship,
      relationship: {
        ...(relationship.relationship as object),
        explanation: 'Suggested by the detector: another passage contradicts the retained rule.',
      },
    },
  ]);

  expect(again.value.published).toEqual([
    { kind: 'relationship', id: ids.relationshipId, revisionId: null, replay: true },
  ]);
  expect(
    read(store.handle, (view) =>
      listProjectRelationships(view, { kind: 'requirement', entityId: store.requirementId })
    ).filter((row) => row.relationshipId === ids.relationshipId)
  ).toHaveLength(1);
});

it('fails the whole plan with the current state when a governing state moved', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  // The plan was read before the adoption and rests on the state it saw then.
  const stale = planRecords(store, ids);
  const selectionId = await adoptTheRequirement(store);

  const refusal = await publish(store, stale).catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(StaleInterpretedState);
  const moved = refusal as StaleInterpretedState;
  expect(moved.record).toEqual({ kind: 'relationship', id: ids.relationshipId });
  expect(moved.current.selection_ids).toEqual([selectionId]);
  // Nothing of the plan reached the store: the record the state moved under is refused with the
  // records ahead of it in the same operation.
  expect(read(store.handle, (view) => readProjectRequirement(view, ids.requirementId))).toBeNull();
  expect(
    read(store.handle, (view) => readProjectKnowledgeSource(view, sourceOf(store).source_id))
  ).toBeNull();
});

it('publishes against a governing state that did move, once the plan carries it', async () => {
  const store = await authorityStore();
  const selectionId = await adoptTheRequirement(store);

  const published = await publish(
    store,
    planRecords(store, freshIds(), {
      kind: 'observed',
      selection_ids: [selectionId],
      correction_action_ids: [],
    })
  );

  expect(published.value.published.every((entry) => !entry.replay)).toBe(true);
  const governing = read(
    store.handle,
    (view) =>
      resolveProjectKnowledge(
        view,
        { kind: 'requirement', entity_id: store.requirementId },
        store.authority.projectId,
        store.artifact,
        {}
      ).governing_state.selection_ids
  );
  expect(governing).toEqual([selectionId]);
});

it('refuses a publication attributed to an actor', async () => {
  const store = await authorityStore();

  await expect(
    publishInterpretedKnowledge(store.handle, {
      operationId: uuidv7(),
      source: sourceOf(store),
      recordedBy: OWNER,
      attributedTo: BY_OWNER,
      scope: store.artifact,
      records: [],
      secretAllow: [],
    })
  ).rejects.toThrow(/never an actor/);
});

it('refuses a relationship the plan asks to establish, and writes nothing', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  const records = planRecords(store, ids);
  const relationship = records[2] as Extract<InterpretedRecord, { kind: 'relationship' }>;

  await expect(
    publish(store, [
      records[0]!,
      {
        ...relationship,
        relationship: { ...(relationship.relationship as object), standing: 'established' },
      },
    ])
  ).rejects.toThrow();

  expect(read(store.handle, (view) => readProjectRequirement(view, ids.requirementId))).toBeNull();
});

it('refuses a plan whose use claims the task implemented the rule, and writes nothing', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  const records = planRecords(store, ids);
  const use = records[4] as Extract<InterpretedRecord, { kind: 'task_use' }>;

  await expect(
    publish(store, [records[0]!, { ...use, use: { ...(use.use as object), role: 'implement' } }])
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  expect(read(store.handle, (view) => readProjectRequirement(view, ids.requirementId))).toBeNull();
  expect(rowCount(store.handle, 'task_uses')).toBe(0);
});

it('refuses a statement carrying a secret before anything is written', async () => {
  const store = await authorityStore();
  const ids = freshIds();
  const records = planRecords(store, ids);
  const requirement = records[0] as Extract<InterpretedRecord, { kind: 'requirement_revision' }>;
  const secret = `The deploy key is ghp_${'a'.repeat(36)} and must not change.`;

  const refusal = await publish(store, [
    {
      ...requirement,
      revision: { ...(requirement.revision as object), statement: secret },
    },
  ]).catch((error: unknown) => error);

  expect((refusal as { code: string }).code).toBe('SECRET_IN_PAYLOAD');
  expect((refusal as Error).message).not.toContain('ghp_');
  expect(
    read(store.handle, (view) => readProjectKnowledgeSource(view, sourceOf(store).source_id))
  ).toBeNull();
});
