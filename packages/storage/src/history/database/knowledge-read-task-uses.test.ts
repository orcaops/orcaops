// What a plan event's uses said at a boundary, with the uses a later operation connected kept out
// of the uses the plan event's own settlement wrote.
import { afterEach, expect, it } from 'vitest';

import { type KnowledgeBoundary, knowledgeReadRequest } from './knowledge-read-boundary.js';
import { readProjectTaskUsesAtBoundary } from './knowledge-read-task-uses.js';
import { publishProjectSelection } from './knowledge-selections.js';
import { recordProjectTaskUses } from './knowledge-task-uses.js';
import {
  acceptedSelection,
  AT,
  type AuthorityStore,
  authorityStore,
  instructedBy,
} from '../../../tests/knowledge-authority-store.js';
import {
  BY_AGENT,
  capturePlanWithTaskUses,
  counters,
  discardKnowledgeStores,
  OWNER,
  read,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';

afterEach(discardKnowledgeStores);

const DISCOVERY = { discovered_at: '2026-09-18T10:00:00.000Z', discovered_by: BY_AGENT };

const usesAt = (store: AuthorityStore, planEventId: string, boundary: KnowledgeBoundary) =>
  read(store.handle, (view) =>
    readProjectTaskUsesAtBoundary(
      view,
      planEventId,
      store.authority.projectId,
      knowledgeReadRequest(view, {
        scope: store.project,
        mode: boundary === 'now' ? 'current' : 'historical',
        boundary,
      })
    )
  );

const use = (
  plan: { artifactId: string; planEventId: string },
  store: AuthorityStore,
  role = 'preserve'
) => ({
  artifact_id: plan.artifactId,
  plan_event_id: plan.planEventId,
  target: store.target,
  role,
  local: null,
  exception_id: null,
});

/** A plan event whose own settlement selected one use, and a later operation connected another. */
async function planWithBothKinds(store: AuthorityStore) {
  const plan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Retry offline' }] }],
  };
  await capturePlanWithTaskUses(store.handle, plan, [use(plan, store)]);
  const selectedAt = counters(store.handle).writeSequence;
  await recordProjectTaskUses(store.handle, {
    operationId: uuidv7(),
    uses: [use(plan, store, 'assess')],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  return { plan, selectedAt };
}

it('never reports a use connected later as selected with the plan', async () => {
  const store = await authorityStore();
  const { plan } = await planWithBothKinds(store);
  const answer = usesAt(store, plan.planEventId, 'now');
  expect(answer.selectedWithPlan.map((entry) => entry.use.role)).toEqual(['preserve']);
  expect(answer.connectedLater.map((entry) => entry.use.role)).toEqual(['assess']);
  expect(answer.selectedWithPlan[0]?.use.discoveredBy).toBeNull();
  expect(answer.connectedLater[0]?.use.discoveredBy).toEqual({
    kind: 'actor',
    name: BY_AGENT.actor.identity,
    basis: BY_AGENT.actor.basis,
  });
});

it('leaves a use connected after the boundary out of the answer', async () => {
  const store = await authorityStore();
  const { plan, selectedAt } = await planWithBothKinds(store);
  const answer = usesAt(store, plan.planEventId, selectedAt);
  expect(answer.connectedLater).toEqual([]);
  expect(answer.selectedWithPlan).toHaveLength(1);
  expect(answer.coverage.boundary).toBe(selectedAt);
});

it('says what became of each use’s target revision at the boundary', async () => {
  const store = await authorityStore();
  const { plan, selectedAt } = await planWithBothKinds(store);
  expect(usesAt(store, plan.planEventId, selectedAt).selectedWithPlan[0]?.standing).toBe(
    'not_standing'
  );
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.project,
      instructedBy(store.instructionId, store.project)
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  const now = usesAt(store, plan.planEventId, 'now');
  expect(now.selectedWithPlan[0]?.standing).toBe('adopted');
  expect(now.selectedWithPlan[0]?.entries).toEqual([
    expect.objectContaining({ standing: 'stands', designation: 'adopted' }),
  ]);
  // The adoption is later than the earlier boundary, so the earlier read still says nothing stands.
  expect(usesAt(store, plan.planEventId, selectedAt).selectedWithPlan[0]?.standing).toBe(
    'not_standing'
  );
});

it('reads a use of a revision background-designated as background', async () => {
  const store = await authorityStore();
  const { plan } = await planWithBothKinds(store);
  await publishProjectSelection(store.handle, {
    operationId: uuidv7(),
    selection: acceptedSelection(
      store.target,
      store.project,
      instructedBy(store.instructionId, store.project),
      { designation: 'background' }
    ),
    selectedBy: OWNER,
    acceptedAt: AT,
    secretAllow: [],
  });
  expect(usesAt(store, plan.planEventId, 'now').connectedLater[0]?.standing).toBe('background');
});

it('returns every column of a use it reports', async () => {
  const store = await authorityStore();
  const { plan } = await planWithBothKinds(store);
  const [selected] = usesAt(store, plan.planEventId, 'now').selectedWithPlan;
  expect(selected?.use).toMatchObject({
    artifactId: plan.artifactId,
    planEventId: plan.planEventId,
    target: {
      kind: 'requirement',
      entityId: store.requirementId,
      revisionId: store.revisionId,
    },
    role: 'preserve',
    stepId: null,
    criterionId: null,
    exceptionId: null,
    selectionKind: 'selected_with_plan',
    discoveredAt: null,
    recordHex: expect.any(String),
    recordSha256: expect.any(String),
    operationId: expect.any(String),
  });
  expect(selected?.writeSequence).toBeGreaterThan(0);
});
