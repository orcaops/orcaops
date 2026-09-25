import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import {
  appendProjectPlanCapture,
  beginProjectPlanCaptureRetention,
  listProjectTaskUses,
  planCaptureCommand,
  type PreparedTaskUses,
  preparePlanCaptureCommand,
  preparePlanCaptureInput,
  preparePlanTaskUses,
  prepareProjectGitRetention,
  type ProjectDatabase,
  projectDatabasePath,
  publishProjectRequirementRevision,
  readProjectPendingCapture,
  recordProjectTaskUses,
  replayProjectPlanCapture,
  runProjectOperation,
  settleProjectCaptureRetention,
  settleProjectTaskUses,
} from '../../src/history/database/index.js';
import { digest, recordChecksum } from '../../src/history/event-integrity.js';
import { uuidv7 } from '../../src/ids/uuidv7.js';
import { CapturePlanInputSchema, type KnowledgeUseInput } from '../../src/schema/capture-input.js';
import * as secretGuard from '../../src/text/secret-guard.js';
import { authorityStore, BY_OWNER, requirementRevision } from '../knowledge-authority-store.js';
import { discardKnowledgeStores } from '../knowledge-store.js';

afterEach(discardKnowledgeStores);

function captureInput(
  handle: ProjectDatabase,
  uses?: KnowledgeUseInput[],
  secretAllow: string[] = [],
  pending = false
) {
  const authored = CapturePlanInputSchema.parse({
    idempotency_key: uuidv7(),
    ...(uses === undefined ? {} : { knowledge_uses: uses }),
    task: 'Keep the original selection',
    label: 'Original selection',
    plan_steps: [
      {
        text: 'Retain immutable input',
        label: 'Retain input',
        acceptance_criteria: [{ text: 'Original input survives' }],
      },
    ],
  });
  const prepared = preparePlanCaptureInput({ authored, sourcePlan: null }, secretAllow);
  const artifactId = uuidv7();
  const operationId = uuidv7();
  const eventId = uuidv7();
  const plan = {
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'a'.repeat(40),
    agent: 'codex',
    agent_session_id: null,
    task: authored.task,
    label: authored.label,
    plan_steps: authored.plan_steps.map((step) => ({
      ...step,
      step_id: uuidv7(),
      acceptance_criteria: step.acceptance_criteria.map((criterion) => ({
        ...criterion,
        criterion_id: uuidv7(),
      })),
    })),
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-01T00:00:00.000Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    prior_plan_event_id: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    ...(pending ? { baseline_seed_tree_sha: 'c'.repeat(40) } : {}),
  };
  const record = {
    event_id: eventId,
    type: 'plan_captured' as const,
    ts: plan.started_at,
    schema_version: 1,
    idempotency_key: authored.idempotency_key,
    payload: plan,
  };
  const capture: Parameters<typeof appendProjectPlanCapture>[1]['capture'] = {
    artifactId,
    operationId,
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...record, checksum: recordChecksum(record) }) + '\n'),
    sidecarPayloads: [],
    secretAllow,
    execution: {
      kind: 'create',
      ts: plan.started_at,
      context: {
        repository_instance_id: handle.authority.repositoryInstanceId,
        worktree_id: uuidv7(),
        git_context: { branch: 'main', head_sha: 'a'.repeat(40) },
      },
    },
  };
  const admissionOperationId = pending ? uuidv7() : operationId;
  const command = preparePlanCaptureCommand(prepared, {
    artifactId,
    planEventId: eventId,
    originalOperationId: operationId,
    admissionOperationId,
  });
  const retention = pending
    ? prepareProjectGitRetention({
        operationId,
        admissionOperationId,
        preparedTransitionId: uuidv7(),
        repositoryInstanceId: handle.authority.repositoryInstanceId,
        objectFormat: 'sha1',
        createdAt: plan.started_at,
        target: {
          kind: 'capture',
          artifactId,
          expectedRevision: null,
          expectedExecutionVersion: null,
          expectedBindingGeneration: null,
          expectedBaselinePublicationId: null,
        },
        publications: [
          {
            publicationId: uuidv7(),
            role: 'baseline',
            targetId: eventId,
            checkpointNumber: null,
            checkpointPhase: null,
            objectOid: 'b'.repeat(40),
            treeOid: 'c'.repeat(40),
          },
        ],
        secretAllow: [],
      })
    : null;
  return {
    command,
    capture,
    uses: preparePlanTaskUses({ artifactId, planEventId: eventId, uses, secretAllow }),
    eventId,
    retention,
  };
}

it('replays a direct plan with its original selected revisions and rejects changed uses', async () => {
  const store = await authorityStore();
  const selected: KnowledgeUseInput = {
    kind: 'requirement',
    entity_id: store.requirementId,
    revision_id: store.revisionId,
    role: 'implement',
  };
  const original = captureInput(store.handle, [selected]);
  const first = await appendProjectPlanCapture(store.handle, original);
  const before = store.handle.read((view) => ({
    uses: listProjectTaskUses(view, original.eventId),
    operations: view.all('SELECT * FROM operations ORDER BY committed_write_sequence'),
  }));

  await expect(replayProjectPlanCapture(store.handle, original.command)).resolves.toEqual({
    ...first,
    replayed: true,
  });
  await expect(
    appendProjectPlanCapture(store.handle, {
      ...original,
      uses: preparePlanTaskUses({
        artifactId: original.capture.artifactId,
        planEventId: original.eventId,
        uses: [{ ...selected, role: 'preserve' }],
        secretAllow: [],
      }),
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    appendProjectPlanCapture(store.handle, { ...original, uses: null })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const command = planCaptureCommand(original.command);
  const changedCommand = preparePlanCaptureCommand(
    preparePlanCaptureInput(
      {
        authored: { ...command.authored, knowledge_uses: [{ ...selected, role: 'preserve' }] },
        sourcePlan: command.sourcePlan,
      },
      []
    ),
    {
      artifactId: command.artifactId,
      planEventId: command.planEventId,
      originalOperationId: command.originalOperationId,
      admissionOperationId: command.admissionOperationId,
    }
  );
  await expect(replayProjectPlanCapture(store.handle, changedCommand)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(
    store.handle.read((view) => ({
      uses: listProjectTaskUses(view, original.eventId),
      operations: view.all('SELECT * FROM operations ORDER BY committed_write_sequence'),
    }))
  ).toEqual(before);
});

it('derives the original selection from the command and ignores later connections during replay', async () => {
  const store = await authorityStore();
  const original = captureInput(store.handle, [{ ...store.target, role: 'implement' }]);
  await appendProjectPlanCapture(store.handle, {
    capture: original.capture,
    command: original.command,
  });
  expect(
    store.handle.read((view) => listProjectTaskUses(view, original.eventId)).value
  ).toMatchObject([{ role: 'implement', selectionKind: 'selected_with_plan' }]);
  await recordProjectTaskUses(store.handle, {
    operationId: uuidv7(),
    uses: [{ ...original.uses!.uses[0], role: 'background' }],
    discovery: { discovered_at: '2026-09-18T00:00:00.000Z', discovered_by: BY_OWNER },
    secretAllow: [],
  });
  const before = store.handle.read((view) => listProjectTaskUses(view, original.eventId));
  await expect(replayProjectPlanCapture(store.handle, original.command)).resolves.toMatchObject({
    replayed: true,
  });
  expect(store.handle.read((view) => listProjectTaskUses(view, original.eventId))).toEqual(before);
  expect(before.value.map((row) => row.selectionKind).sort()).toEqual([
    'connected_later',
    'selected_with_plan',
  ]);
});

it.each([undefined, []])(
  'omits selection hashes for an empty authored selection: %j',
  async (uses) => {
    const store = await authorityStore();
    const original = captureInput(store.handle, uses);
    const first = await appendProjectPlanCapture(store.handle, original);
    const payload = store.handle.read((view) =>
      view.get<{ payload_json: string }>(
        'SELECT payload_json FROM operations WHERE operation_id=?',
        original.capture.operationId
      )
    ).value!;
    expect(JSON.parse(payload.payload_json)).not.toHaveProperty('knowledge_uses');
    await expect(replayProjectPlanCapture(store.handle, original.command)).resolves.toEqual({
      ...first,
      replayed: true,
    });
  }
);

it('replays an accepted selection without applying a new secret allowlist', async () => {
  const store = await authorityStore();
  const revisionId = 'ghp_' + 'a'.repeat(36);
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: requirementRevision(store.requirementId, store.sourceId, {
      revisionId,
      previousRevisionId: store.revisionId,
    }),
    attributedTo: BY_OWNER,
    secretAllow: [revisionId],
  });
  const selected: KnowledgeUseInput = {
    ...store.target,
    revision_id: revisionId,
    role: 'implement',
  };
  expect(() => captureInput(store.handle, [selected])).toThrow(
    expect.objectContaining({ code: 'SECRET_IN_PAYLOAD' })
  );
  const original = captureInput(store.handle, [selected], [revisionId]);
  const first = await appendProjectPlanCapture(store.handle, original);
  const before = store.handle.read((view) => listProjectTaskUses(view, original.eventId));
  await expect(replayProjectPlanCapture(store.handle, original.command)).resolves.toEqual({
    ...first,
    replayed: true,
  });
  expect(store.handle.read((view) => listProjectTaskUses(view, original.eventId))).toEqual(before);
});

it('settles a pending accepted selection without applying a new secret allowlist', async () => {
  const store = await authorityStore();
  const revisionId = 'ghp_' + 'b'.repeat(36);
  await publishProjectRequirementRevision(store.handle, {
    operationId: uuidv7(),
    revision: requirementRevision(store.requirementId, store.sourceId, {
      revisionId,
      previousRevisionId: store.revisionId,
    }),
    attributedTo: BY_OWNER,
    secretAllow: [revisionId],
  });
  const selected: KnowledgeUseInput = {
    ...store.target,
    revision_id: revisionId,
    role: 'implement',
  };
  const original = captureInput(store.handle, [selected], [revisionId], true);
  const admitted = await beginProjectPlanCaptureRetention(store.handle, {
    capture: original.capture,
    command: original.command,
    retention: original.retention!,
  });
  const guard = vi.spyOn(secretGuard, 'assertNoSecretsInPayload').mockImplementation(() => {
    throw new Error('A later policy must not recheck accepted bytes');
  });

  const recovered = readProjectPendingCapture(store.handle, original.capture.operationId).value!;
  const acceptedUse = recovered.planUses!.uses[0]!;
  expect(Object.isFrozen(recovered.planUses)).toBe(true);
  expect(Object.isFrozen(recovered.planUses!.uses)).toBe(true);
  expect(Object.isFrozen(acceptedUse.target)).toBe(true);
  expect(Reflect.set(acceptedUse.target, 'revision_id', store.revisionId)).toBe(false);
  await expect(
    runProjectOperation(
      store.handle,
      {
        operationId: uuidv7(),
        kind: 'test.task.uses.reuse',
        target: null,
        payload: null,
        expectedState: null,
        intentChange: false,
      },
      (transaction, operation) =>
        settleProjectTaskUses(transaction, operation, recovered.planUses!, null)
    )
  ).rejects.toMatchObject({ code: 'HISTORY_INTEGRITY_REQUIRED' });
  const first = await settleProjectCaptureRetention(store.handle, {
    originalOperationId: original.capture.operationId,
    expectedTransitionId: admitted.value.transitionId,
    selectedTransitionId: uuidv7(),
  });
  const beforeReplay = store.handle.read((view) => ({
    uses: listProjectTaskUses(view, original.eventId),
    operations: view.all('SELECT * FROM operations ORDER BY committed_write_sequence'),
  }));
  expect(guard).not.toHaveBeenCalled();
  guard.mockRestore();
  expect(recovered.planUses?.authoredSha256).toHaveLength(1);
  expect(beforeReplay.value.uses).toHaveLength(1);
  const retained = beforeReplay.value.uses[0]!;
  expect(retained).toMatchObject({
    target: { revisionId },
    selectionKind: 'selected_with_plan',
    operationId: original.capture.operationId,
  });
  const retainedBytes = Buffer.from(retained.recordHex, 'hex');
  expect(JSON.parse(retainedBytes.toString('utf8'))).toEqual({
    artifact_id: original.capture.artifactId,
    plan_event_id: original.eventId,
    target: {
      kind: 'requirement',
      entity_id: store.requirementId,
      revision_id: revisionId,
    },
    role: 'implement',
    local: null,
    exception_id: null,
    selection: { kind: 'selected_with_plan' },
  });
  expect(retained.recordSha256).toBe(digest(retainedBytes));

  const forged: PreparedTaskUses = {
    uses: recovered.planUses!.uses.map((use) => ({
      ...use,
      target: { ...use.target },
    })),
    allow: [],
    authoredSha256: [...recovered.planUses!.authoredSha256],
  };
  await expect(
    runProjectOperation(
      store.handle,
      {
        operationId: uuidv7(),
        kind: 'test.task.uses.forged',
        target: null,
        payload: null,
        expectedState: null,
        intentChange: false,
      },
      (transaction, operation) =>
        settleProjectTaskUses(transaction, operation, forged, {
          discovered_at: '2026-09-18T00:00:00.000Z',
          discovered_by: BY_OWNER,
        })
    )
  ).rejects.toMatchObject({ code: 'SECRET_IN_PAYLOAD' });

  await expect(
    settleProjectCaptureRetention(store.handle, {
      originalOperationId: original.capture.operationId,
      expectedTransitionId: admitted.value.transitionId,
      selectedTransitionId: first.value.transitionId,
    })
  ).resolves.toEqual({ ...first, replayed: true });
  expect(
    store.handle.read((view) => ({
      uses: listProjectTaskUses(view, original.eventId),
      operations: view.all('SELECT * FROM operations ORDER BY committed_write_sequence'),
    }))
  ).toEqual(beforeReplay);
});

it('refuses a pending selection when its retained admission receipt changes', async () => {
  const store = await authorityStore();
  const original = captureInput(store.handle, [{ ...store.target, role: 'implement' }], [], true);
  await beginProjectPlanCaptureRetention(store.handle, {
    capture: original.capture,
    command: original.command,
    retention: original.retention!,
  });
  const database = new Database(projectDatabasePath(store.handle.authority));
  const trigger = database
    .prepare("SELECT sql FROM sqlite_schema WHERE name='operations_no_update'")
    .get() as { sql: string };
  try {
    database.exec('DROP TRIGGER operations_no_update');
    database
      .prepare('UPDATE operations SET payload_json=? WHERE operation_id=?')
      .run('null', planCaptureCommand(original.command).admissionOperationId);
    database.exec(trigger.sql);
  } finally {
    database.close();
  }
  expect(() => readProjectPendingCapture(store.handle, original.capture.operationId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(store.handle.read((view) => listProjectTaskUses(view, original.eventId)).value).toEqual(
    []
  );
});
