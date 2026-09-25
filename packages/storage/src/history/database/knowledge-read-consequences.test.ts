import { afterEach, expect, it } from 'vitest';

import { knowledgeReadRequest } from './knowledge-read-boundary.js';
import {
  readProjectArtifactsTouching,
  readProjectAssessmentsNaming,
  readProjectAssumptionsNaming,
  readProjectFilesTouchedBy,
  readProjectIdentitiesSharingSubject,
  readProjectPlanEventsOf,
  readProjectRelationshipsOfIdentity,
  readProjectStandingMovedSince,
} from './knowledge-read-consequences.js';
import {
  consequenceStore,
  OTHER_TOUCHED_FILE,
  TOUCHED_FILE,
} from '../../../tests/knowledge-consequence-store.js';
import { discardKnowledgeStores, read } from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

const requestAt = (store: Awaited<ReturnType<typeof consequenceStore>>, boundary: number | 'now') =>
  read(store.handle, (view) =>
    knowledgeReadRequest(view, {
      scope: store.store.project,
      mode: boundary === 'now' ? 'current' : 'historical',
      boundary,
    })
  );

it('reports a relationship established by an actor apart from one a detector suggested', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const found = read(store.handle, (view) =>
    readProjectRelationshipsOfIdentity(
      view,
      { kind: 'requirement', entity_id: store.requirement.entity_id },
      request
    )
  );

  expect(found.established.map((entry) => entry.relationshipId)).toEqual([store.dependencyId]);
  expect(found.established[0]).toMatchObject({
    relation: 'depends_on',
    standing: 'established',
    attributedTo: { kind: 'actor', identity: 'owner@example.test' },
  });
  expect(found.suggested.map((entry) => entry.relationshipId)).toEqual([
    store.suggestedDependencyId,
  ]);
  expect(found.suggested[0]).toMatchObject({
    relation: 'motivates',
    attributedTo: { kind: 'detector', identity: 'knowledge-processor', basis: null },
  });
  expect(found.later).toBe(0);
});

it('leaves a relationship out of a read at a boundary before it was published', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, store.boundaries.adopted);

  const found = read(store.handle, (view) =>
    readProjectRelationshipsOfIdentity(
      view,
      { kind: 'requirement', entity_id: store.requirement.entity_id },
      request
    )
  );

  expect(found.established).toEqual([]);
  expect(found.suggested).toEqual([]);
  expect(found.later).toBe(2);
});

it('finds the assumption and the reconsideration condition that name an identity', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const found = read(store.handle, (view) =>
    readProjectAssumptionsNaming(
      view,
      {
        names: [store.requirement.entity_id],
        decisionRevisionIds: [store.decision.revision_id],
      },
      request
    )
  );

  expect(found.mentions.map((entry) => entry.where)).toEqual([
    'assumption',
    'reconsideration_condition',
  ]);
  expect(found.mentions[0]).toMatchObject({
    decision: { kind: 'decision', entity_id: store.decision.entity_id },
    position: 0,
    names: store.requirement.entity_id,
    authoredBy: { kind: 'actor', identity: 'owner@example.test' },
  });
  expect(found.mentions[0]!.text).toContain(store.requirement.entity_id);
  expect(found.read).toBe(1);
});

it('says the assumption read is bounded rather than reporting no mention', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const found = read(store.handle, (view) =>
    readProjectAssumptionsNaming(
      view,
      { names: [store.requirement.entity_id], decisionRevisionIds: [] },
      request
    )
  );

  expect(found.mentions).toEqual([]);
  const limit = found.limits.find((entry) => entry.kind === 'assumptions_not_indexed');
  expect(limit?.detail).toContain('no column indexes their words');
  expect(limit?.detail).toContain('is not reported as having no assumption about this change');
});

it('reaches an assessment by the expectation it concluded about and by an input it selected', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const found = read(store.handle, (view) =>
    readProjectAssessmentsNaming(
      view,
      {
        expectations: [store.requirement],
        inputs: [{ kind: 'file', identity: TOUCHED_FILE }],
      },
      request
    )
  );

  expect(found.assessments.map((entry) => entry.reached).sort()).toEqual([
    'expectation',
    'selected_input',
  ]);
  const byExpectation = found.assessments.find((entry) => entry.reached === 'expectation')!;
  expect(byExpectation.assessment.assessmentId).toBe(store.assessmentId);
  expect(byExpectation.conclusion).toBe('supported');
  const byInput = found.assessments.find((entry) => entry.reached === 'selected_input')!;
  expect(byInput.input).toEqual({ kind: 'file', identity: TOUCHED_FILE });
  expect(
    found.limits.find((entry) => entry.kind === 'selected_inputs_not_indexed')?.detail
  ).toContain('no index over them');
});

it('leaves an assessment published after the boundary out and names it', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, store.boundaries.linked);

  const found = read(store.handle, (view) =>
    readProjectAssessmentsNaming(view, { expectations: [store.requirement], inputs: [] }, request)
  );

  expect(found.assessments).toEqual([]);
  expect(found.later).toEqual([store.assessmentId]);
});

it('separates an artifact that recorded a touch of a path from one whose path matched a pattern', async () => {
  const store = await consequenceStore();

  const exact = read(store.handle, (view) => readProjectArtifactsTouching(view, TOUCHED_FILE));
  expect(exact.associations).toEqual([
    {
      artifactId: store.store.plan.artifactId,
      filePath: TOUCHED_FILE,
      asked: TOUCHED_FILE,
      recordedTouch: true,
    },
  ]);

  const matched = read(store.handle, (view) =>
    readProjectArtifactsTouching(view, 'packages/sync/src/*.ts')
  );
  expect(matched.associations.map((entry) => entry.filePath).sort()).toEqual([
    TOUCHED_FILE,
    OTHER_TOUCHED_FILE,
  ]);
  expect(matched.associations.every((entry) => !entry.recordedTouch)).toBe(true);
});

it('reports a path no artifact touched as a limit, not as nothing depending on it', async () => {
  const store = await consequenceStore();

  const found = read(store.handle, (view) =>
    readProjectArtifactsTouching(view, 'packages/sync/src/absent.ts')
  );

  expect(found.associations).toEqual([]);
  const limit = found.limits.find((entry) => entry.kind === 'no_code_association');
  expect(limit?.detail).toContain('not the same as nothing depending on it');
});

it('reads an artifact’s recorded files and its plan events', async () => {
  const store = await consequenceStore();
  const artifactId = store.store.plan.artifactId;

  const files = read(store.handle, (view) => readProjectFilesTouchedBy(view, [artifactId]));
  const events = read(store.handle, (view) => readProjectPlanEventsOf(view, [artifactId]));

  expect(files.map((entry) => entry.filePath).sort()).toEqual([TOUCHED_FILE, OTHER_TOUCHED_FILE]);
  expect(files.every((entry) => entry.recordedTouch)).toBe(true);
  expect(events).toEqual([{ artifactId, planEventId: store.store.plan.planEventId }]);
});

it('reaches a requirement sharing a subject and says which kinds it did not look for', async () => {
  const store = await consequenceStore();
  const revisions = read(store.handle, (view) =>
    view
      .all<{
        revision_id: string;
      }>(
        'SELECT revision_id FROM requirement_revisions WHERE requirement_id=? AND subject_id IS NOT NULL',
        store.requirement.entity_id
      )
      .map((row) => ({
        kind: 'requirement' as const,
        entity_id: store.requirement.entity_id,
        revision_id: row.revision_id,
      }))
  );

  const found = read(store.handle, (view) => readProjectIdentitiesSharingSubject(view, revisions));

  expect(found.neighbours.map((entry) => entry.identity.entity_id)).toEqual([
    store.sibling.entity_id,
  ]);
  expect(found.neighbours[0]!.subjectId).toBe(store.subjectId);
  expect(found.limits.find((entry) => entry.kind === 'subject_index_only')?.detail).toContain(
    'Decisions and claims record a subject with no index over it'
  );
});

it('lists the revisions an act moved after a boundary and says the sweep is unindexed', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const moved = read(store.handle, (view) =>
    readProjectStandingMovedSince(view, store.boundaries.adopted, request, { maxMoves: 50 })
  );
  const before = read(store.handle, (view) =>
    readProjectStandingMovedSince(view, 0, request, { maxMoves: 50 })
  );

  expect(moved.moves).toEqual([]);
  expect(before.moves.map((entry) => entry.because)).toEqual(['adoption']);
  expect(before.moves[0]!.revision).toEqual({
    kind: 'requirement',
    entity_id: store.requirement.entity_id,
    revision_id: store.requirement.revision_id,
  });
  expect(
    before.limits.find((entry) => entry.kind === 'standing_sweep_unindexed')?.detail
  ).toContain('Nothing indexes the write sequence an operation committed at');
});

it('names a truncated since-sweep rather than shortening it silently', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const moved = read(store.handle, (view) =>
    readProjectStandingMovedSince(view, 0, request, { maxMoves: 0 })
  );

  expect(moved.moves).toEqual([]);
  const limit = moved.limits.find((entry) => entry.kind === 'standing_moves_truncated');
  expect(limit?.detail).toContain('this answer follows at most 0');
});

it('holds nothing for an identity this history never recorded', async () => {
  const store = await consequenceStore();
  const request = requestAt(store, 'now');

  const found = read(store.handle, (view) =>
    readProjectRelationshipsOfIdentity(view, { kind: 'requirement', entity_id: uuidv7() }, request)
  );

  expect(found).toMatchObject({ established: [], suggested: [], later: 0 });
});
