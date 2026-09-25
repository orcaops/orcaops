import { afterEach, expect, it } from 'vitest';

import { editProjectPromotedCriterion } from './knowledge-criterion-edits.js';
import { createProjectRequirement, readProjectRequirement } from './knowledge-requirements.js';
import { listProjectTaskUses, recordProjectTaskUses } from './knowledge-task-uses.js';
import {
  AGENT,
  captureFieldSource,
  counters,
  discardKnowledgeStores,
  OWNER,
  plannedKnowledgeStore,
  read,
  rowCount,
} from '../../../tests/knowledge-store.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';

afterEach(discardKnowledgeStores);

const AT = '2026-09-18T12:00:00.000Z';
const BY_OWNER = { kind: 'actor', actor: OWNER } as const;
const BY_AGENT = { kind: 'actor', actor: AGENT } as const;

async function store() {
  const { handle, plan } = await plannedKnowledgeStore();
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
      rationale: 'Captures must never depend on network availability.',
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
    sourceId,
    shared: { kind: 'requirement' as const, entity_id: criterionId, revision_id: revisionId },
  };
}

const sharedRevisionFields = (sourceId: string) => ({
  revision_id: uuidv7(),
  subject: null,
  applicability: { all_of: [] },
  duration: { kind: 'continuing' },
  source_ids: [sourceId],
  passages: [],
  source_standing: 'agent_proposal',
  recorded_at: AT,
});

const reviseShared = (shared: { kind: 'requirement'; entity_id: string; revision_id: string }) => ({
  action: 'revise_shared_requirement',
  requirement: shared,
  proposed_statement: 'Local capture and local search work with no Cloud connection.',
  rationale: 'Search is part of the offline promise.',
});

it('proposes a shared revision that continues the named one and moves no pinned use', async () => {
  const { handle, plan, sourceId, shared } = await store();
  await recordProjectTaskUses(handle, {
    operationId: uuidv7(),
    uses: [
      {
        artifact_id: plan.artifactId,
        plan_event_id: plan.planEventId,
        target: shared,
        role: 'preserve',
        local: null,
        exception_id: null,
      },
    ],
    discovery: { discovered_at: AT, discovered_by: { kind: 'actor', actor: AGENT } },
    secretAllow: [],
  });
  const fields = sharedRevisionFields(sourceId);
  const before = counters(handle);
  const edited = await editProjectPromotedCriterion(handle, {
    operationId: uuidv7(),
    edit: reviseShared(shared),
    attributedTo: BY_AGENT,
    secretAllow: [],
    sharedRevision: fields,
  });
  expect(edited.counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter + 1,
  });
  expect(edited.value).toMatchObject({
    action: 'revise_shared_requirement',
    requirementId: shared.entity_id,
    revisionId: fields.revision_id,
    recordedBy: 'shared_revision',
  });
  const retained = read(handle, (view) => readProjectRequirement(view, shared.entity_id))!;
  expect(retained.revisions.map((row) => row.revisionId)).toEqual([
    shared.revision_id,
    fields.revision_id,
  ]);
  expect(retained.revisions[1]!.previousRevisionId).toBe(shared.revision_id);
  const bytes = Buffer.from(retained.revisions[1]!.recordHex, 'hex');
  expect(digest(bytes)).toBe(retained.revisions[1]!.recordSha256);
  expect(JSON.parse(bytes.toString())).toEqual({
    ...fields,
    requirement_id: shared.entity_id,
    previous_revision_id: shared.revision_id,
    statement: reviseShared(shared).proposed_statement,
    rationale: reviseShared(shared).rationale,
    attributed_to: BY_AGENT,
  });
  expect(read(handle, (view) => listProjectTaskUses(view, plan.planEventId))[0]!.target).toEqual({
    kind: 'requirement',
    entityId: shared.entity_id,
    revisionId: shared.revision_id,
  });
  expect(rowCount(handle, 'adoptions')).toBe(0);
});

it('records nothing at all when a task changes its own acceptance conditions', async () => {
  const { handle, plan, shared } = await store();
  const before = counters(handle);
  const receipts = rowCount(handle, 'operations');
  const edited = await editProjectPromotedCriterion(handle, {
    operationId: uuidv7(),
    edit: {
      action: 'change_task_acceptance',
      requirement: shared,
      artifact_id: plan.artifactId,
      step_id: plan.steps[0]!.stepId,
      criterion_text: 'Retry never blocks a capture while offline.',
    },
    attributedTo: BY_AGENT,
    secretAllow: [],
  });
  expect(edited).toEqual({
    value: {
      action: 'change_task_acceptance',
      requirementId: shared.entity_id,
      revisionId: null,
      recordSha256: null,
      recordedBy: 'task_plan_revision',
    },
    replayed: true,
    counters: before,
  });
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
  expect(rowCount(handle, 'operations')).toBe(receipts);
});

it('refuses a task-local change whose attribution is not an actor or a detector', async () => {
  const { handle, plan, shared } = await store();
  const edit = {
    action: 'change_task_acceptance',
    requirement: shared,
    artifact_id: plan.artifactId,
    step_id: plan.steps[0]!.stepId,
    criterion_text: 'Retry never blocks a capture while offline.',
  };
  for (const attributedTo of [
    undefined,
    { kind: 'actor', actor: { identity: 'owner@example.test', basis: 'unknown' } },
    { kind: 'nobody' },
  ])
    await expect(
      editProjectPromotedCriterion(handle, {
        operationId: uuidv7(),
        edit,
        attributedTo: attributedTo as never,
        secretAllow: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('refuses an edit that names neither action before writing anything shared', async () => {
  const { handle, shared } = await store();
  await expect(
    editProjectPromotedCriterion(handle, {
      operationId: uuidv7(),
      edit: {
        requirement: shared,
        proposed_statement: 'Local capture and local search work with no Cloud connection.',
        rationale: 'Search is part of the offline promise.',
      },
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: sharedRevisionFields(uuidv7()),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
});

it('refuses a requirement, a revision or an artifact this history does not hold', async () => {
  const { handle, plan, sourceId, shared } = await store();
  await expect(
    editProjectPromotedCriterion(handle, {
      operationId: uuidv7(),
      edit: reviseShared({ ...shared, entity_id: uuidv7() }),
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: sharedRevisionFields(sourceId),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    editProjectPromotedCriterion(handle, {
      operationId: uuidv7(),
      edit: reviseShared({ ...shared, revision_id: uuidv7() }),
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: sharedRevisionFields(sourceId),
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  await expect(
    editProjectPromotedCriterion(handle, {
      operationId: uuidv7(),
      edit: {
        action: 'change_task_acceptance',
        requirement: shared,
        artifact_id: uuidv7(),
        step_id: plan.steps[0]!.stepId,
        criterion_text: 'Retry never blocks a capture while offline.',
      },
      attributedTo: BY_AGENT,
      secretAllow: [],
    })
  ).rejects.toMatchObject({ code: 'HISTORY_MISSING' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
});

it('refuses editing a requirement that was never promoted from a criterion', async () => {
  const { handle, sourceId } = await store();
  const authored = uuidv7();
  const revisionId = uuidv7();
  await createProjectRequirement(handle, {
    operationId: uuidv7(),
    identity: { requirement_id: authored, origin: { kind: 'authored', source_id: sourceId } },
    revision: {
      requirement_id: authored,
      revision_id: revisionId,
      previous_revision_id: null,
      statement: 'Restores say plainly what is not in the backup.',
      rationale: null,
      subject: null,
      applicability: { all_of: [] },
      duration: { kind: 'continuing' },
      source_ids: [sourceId],
      passages: [],
      source_standing: 'explicit_instruction',
      recorded_at: AT,
    },
    attributedTo: BY_OWNER,
    secretAllow: [],
  });
  await expect(
    editProjectPromotedCriterion(handle, {
      operationId: uuidv7(),
      edit: reviseShared({ kind: 'requirement', entity_id: authored, revision_id: revisionId }),
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: sharedRevisionFields(sourceId),
    })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(2);
});

it('refuses a shared revision that restates what the edit already says', async () => {
  const { handle, sourceId, shared } = await store();
  for (const contradiction of [
    { statement: 'Something else' },
    { rationale: 'Another reason' },
    { requirement_id: uuidv7() },
    { previous_revision_id: uuidv7() },
  ])
    await expect(
      editProjectPromotedCriterion(handle, {
        operationId: uuidv7(),
        edit: reviseShared(shared),
        attributedTo: BY_AGENT,
        secretAllow: [],
        sharedRevision: { ...sharedRevisionFields(sourceId), ...contradiction },
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(1);
});

it('replays the original result and refuses a changed authored field under one operation id', async () => {
  const { handle, sourceId, shared } = await store();
  const operationId = uuidv7();
  const fields = sharedRevisionFields(sourceId);
  const edited = await editProjectPromotedCriterion(handle, {
    operationId,
    edit: reviseShared(shared),
    attributedTo: BY_AGENT,
    secretAllow: [],
    sharedRevision: fields,
  });
  await editProjectPromotedCriterion(handle, {
    operationId: uuidv7(),
    edit: reviseShared(shared),
    attributedTo: BY_AGENT,
    secretAllow: [],
    sharedRevision: sharedRevisionFields(sourceId),
  });
  expect(
    await editProjectPromotedCriterion(handle, {
      operationId,
      edit: reviseShared(shared),
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: fields,
    })
  ).toEqual({ ...edited, replayed: true });
  const before = rowCount(handle, 'requirement_revisions');
  for (const changed of [
    {
      edit: { ...reviseShared(shared), rationale: 'A different reason' },
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: fields,
    },
    {
      edit: reviseShared(shared),
      attributedTo: BY_OWNER,
      secretAllow: [],
      sharedRevision: fields,
    },
    {
      edit: reviseShared(shared),
      attributedTo: BY_AGENT,
      secretAllow: [],
      sharedRevision: { ...fields, source_standing: 'extracted_candidate' },
    },
  ])
    await expect(
      editProjectPromotedCriterion(handle, { operationId, ...changed })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(rowCount(handle, 'requirement_revisions')).toBe(before);
});
