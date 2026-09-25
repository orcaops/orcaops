import { afterEach, expect, it } from 'vitest';

import { createProjectRequirement } from './knowledge-requirements.js';
import { listProjectTaskUses, recordProjectTaskUses } from './knowledge-task-uses.js';
import {
  AGENT,
  BY_AGENT,
  BY_OWNER,
  captureCheckpoint,
  captureFieldSource,
  capturePlan,
  capturePlanWithTaskUses,
  counters,
  DETECTOR,
  discardKnowledgeStores,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-18T10:00:00.000Z';
const DISCOVERY = { discovered_at: AT, discovered_by: BY_AGENT };

async function store() {
  const { handle, plan, planOperationId, worktreeId } = await plannedKnowledgeStore();
  const sourceId = await captureFieldSource(handle, plan);
  const criterionId = plan.steps[0]!.criteria[0]!.criterionId;
  const revisionId = uuidv7();
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: {
      requirement_id: criterionId,
      origin: {
        kind: 'promoted_criterion',
        criterion: {
          artifact_id: plan.artifactId,
          plan_event_id: plan.planEventId,
          criterion_id: criterionId,
        },
      },
    },
    revision: {
      requirement_id: criterionId,
      revision_id: revisionId,
      previous_revision_id: null,
      statement: 'Local capture works with no Cloud connection.',
      rationale: null,
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: '2026-09-17T09:00:00.000Z',
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  return {
    handle,
    plan,
    planOperationId,
    worktreeId,
    target: { kind: 'requirement' as const, entity_id: criterionId, revision_id: revisionId },
  };
}

const use = (
  plan: { artifactId: string; planEventId: string },
  target: { kind: 'requirement'; entity_id: string; revision_id: string },
  extra: Record<string, unknown> = {}
) => ({
  artifact_id: plan.artifactId,
  plan_event_id: plan.planEventId,
  target,
  role: 'preserve',
  local: null,
  exception_id: null,
  ...extra,
});

it('records a later connection with who found it, and moves no intent counter', async () => {
  const { handle, plan, target } = await store();
  const before = counters(handle);
  const recorded = await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target, { local: { step_id: plan.steps[0]!.stepId, criterion_id: null } })],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  expect(recorded.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(recorded.value.uses[0]).toMatchObject({
    selectionKind: 'connected_later',
    published: true,
  });
  const [row] = read(handle, (view) => listProjectTaskUses(view, plan.planEventId));
  expect(row).toMatchObject({
    selectionKind: 'connected_later',
    discoveredAt: AT,
    discoveredBy: { kind: 'actor', name: AGENT.identity, basis: AGENT.basis },
    stepId: plan.steps[0]!.stepId,
  });
  const bytes = Buffer.from(row!.recordHex, 'hex');
  expect(digest(bytes)).toBe(row!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({
    ...use(plan, target, { local: { step_id: plan.steps[0]!.stepId, criterion_id: null } }),
    selection: { kind: 'connected_later', ...DISCOVERY },
  });
});

it('records a detector as the discoverer it is, and refuses one named as an actor', async () => {
  const { handle, plan, target } = await store();
  await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target, { role: 'background' })],
    discovery: { discovered_at: AT, discovered_by: DETECTOR },
    secretAllow: [],
  });
  const [row] = read(handle, (view) => listProjectTaskUses(view, plan.planEventId));
  expect(row!.discoveredBy).toEqual({ kind: 'detector', name: DETECTOR.detector, basis: null });

  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [use(plan, target, { role: 'background' })],
      discovery: {
        discovered_at: AT,
        discovered_by: { identity: DETECTOR.detector, basis: 'other_assertion' },
      },
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'task_uses')).toBe(1);
});

it('refuses a detector a role that claims what the task intended, and writes nothing', async () => {
  const { handle, plan, target } = await store();
  const before = counters(handle);

  for (const role of ['implement', 'preserve', 'assess', 'propose_change']) {
    await expect(
      recordProjectTaskUses(handle, {
        operationId: uuidv7(),
        uses: [use(plan, target, { role })],
        discovery: { discovered_at: AT, discovered_by: DETECTOR },
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }

  expect(rowCount(handle, 'task_uses')).toBe(0);
  expect(counters(handle).writeSequence).toBe(before.writeSequence);
});

it('leaves a person free to say what their own task did with a rule', async () => {
  const { handle, plan, target } = await store();

  await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target, { role: 'implement' })],
    discovery: DISCOVERY,
    secretAllow: [],
  });

  const [row] = read(handle, (view) => listProjectTaskUses(view, plan.planEventId));
  expect(row).toMatchObject({ role: 'implement', selectionKind: 'connected_later' });
  expect(row!.discoveredBy).toEqual({ kind: 'actor', name: AGENT.identity, basis: AGENT.basis });
});

it('records the same use once however often it is recorded, and writes nothing again', async () => {
  const { handle, plan, target } = await store();
  const first = await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target)],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  const before = counters(handle);
  const receipts = rowCount(handle, 'operations');
  const again = await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target)],
    discovery: { discovered_at: '2026-09-19T10:00:00.000Z', discovered_by: BY_OWNER },
    secretAllow: [],
  });
  expect(again).toEqual({
    value: { uses: [{ ...first.value.uses[0], published: false }] },
    replayed: true,
    counters: before,
  });
  expect(rowCount(handle, 'task_uses')).toBe(1);
  expect(rowCount(handle, 'operations')).toBe(receipts);
});

it('records only the use a call adds when the rest are already recorded', async () => {
  const { handle, plan, target } = await store();
  await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target)],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  const both = await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target), use(plan, target, { role: 'assess' })],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  expect(both.value.uses.map((entry) => entry.published)).toEqual([false, true]);
  expect(rowCount(handle, 'task_uses')).toBe(2);
});

it('refuses a discovery that is not an instant and an attribution', async () => {
  const { handle, plan, target } = await store();
  for (const discovery of [
    { discovered_at: 'yesterday', discovered_by: BY_AGENT },
    { discovered_at: AT, discovered_by: { kind: 'actor', actor: { identity: 'someone' } } },
    { discovered_at: AT },
    'yesterday',
  ])
    await expect(
      recordProjectTaskUses(handle, {
        operationId: uuidv7(),
        uses: [use(plan, target)],
        discovery,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'task_uses')).toBe(0);
});

it('reads a use the plan event’s own settlement wrote as selected with the plan', async () => {
  const { handle, target } = await store();
  const plan = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Retry offline' }] }],
  };
  const settled = await capturePlanWithTaskUses(handle, plan, [use(plan, target)]);
  expect(settled.value.uses[0]).toMatchObject({ selectionKind: 'selected_with_plan' });
  const [row] = read(handle, (view) => listProjectTaskUses(view, plan.planEventId));
  expect(row).toMatchObject({ selectionKind: 'selected_with_plan', discoveredAt: null });
  expect(
    read(handle, (view) =>
      view.get('SELECT operation_id FROM artifact_revisions WHERE artifact_id=?', plan.artifactId)
    )
  ).toEqual({ operation_id: row!.operationId });
});

it('attributes a use to the operation that wrote it, never to the plan event’s own', async () => {
  const { handle, plan, planOperationId, target } = await store();
  const recorded = await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target)],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  const [row] = read(handle, (view) => listProjectTaskUses(view, plan.planEventId));
  expect(row!.operationId).not.toBe(planOperationId);
  expect(row!.selectionKind).toBe('connected_later');
  expect(recorded.value.uses[0]!.selectionKind).toBe('connected_later');
});

it('refuses a later connection presented as an original selection', async () => {
  const { handle, plan, target } = await store();
  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [use(plan, target)],
      discovery: null,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [use(plan, target, { selection: { kind: 'selected_with_plan' } })],
      discovery: DISCOVERY,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'task_uses')).toBe(0);
});

it('refuses a use keyed to a capture event that is not a plan event', async () => {
  const { handle, plan, worktreeId, target } = await store();
  const checkpointId = await captureCheckpoint(handle, plan, worktreeId);
  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [{ ...use(plan, target), plan_event_id: checkpointId }],
      discovery: DISCOVERY,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'task_uses')).toBe(0);
});

it('refuses a plan event, target revision or exception this history does not hold', async () => {
  const { handle, plan, target } = await store();
  const other = {
    artifactId: uuidv7(),
    planEventId: uuidv7(),
    steps: [{ stepId: uuidv7(), criteria: [{ criterionId: uuidv7(), text: 'Another condition' }] }],
  };
  await capturePlan(handle, other);
  for (const refused of [
    { ...use(plan, target), plan_event_id: other.planEventId },
    use(plan, { ...target, revision_id: uuidv7() }),
    use(plan, target, { exception_id: uuidv7() }),
  ])
    await expect(
      recordProjectTaskUses(handle, {
        operationId: uuidv7(),
        uses: [refused],
        discovery: DISCOVERY,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'task_uses')).toBe(0);
});

it('replays the original result and refuses a changed authored field under one operation id', async () => {
  const { handle, plan, target } = await store();
  const operationId = uuidv7();
  const recorded = await recordProjectTaskUses(handle, {
    operationId,
    uses: [use(plan, target)],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [use(plan, target, { role: 'assess' })],
    discovery: DISCOVERY,
    secretAllow: [],
  });
  expect(
    await recordProjectTaskUses(handle, {
      operationId,
      uses: [use(plan, target)],
      discovery: DISCOVERY,
      secretAllow: [],
    })
  ).toEqual({ ...recorded, replayed: true });
  const before = rowCount(handle, 'task_uses');
  for (const changed of [
    { uses: [use(plan, target, { role: 'implement' })], discovery: DISCOVERY, secretAllow: [] },
    {
      uses: [use(plan, target)],
      discovery: { ...DISCOVERY, discovered_by: BY_OWNER },
      secretAllow: [],
    },
  ])
    await expect(recordProjectTaskUses(handle, { operationId, ...changed })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  expect(rowCount(handle, 'task_uses')).toBe(before);
});

it('refuses recording no uses at all', async () => {
  const { handle } = await store();
  await expect(
    recordProjectTaskUses(handle, {
      operationId: uuidv7(),
      uses: [],
      discovery: DISCOVERY,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
