import { afterEach, expect, it } from 'vitest';

import {
  admitProcessingJob,
  claimProcessingJob,
  type InterpretedRecord,
  openProjectDatabase,
  type ProjectDatabase,
  publishInterpretedKnowledge,
  publishInterpretedKnowledgeAndSettleAttempt,
  type PublishProcessingInterpretation,
  publishProjectKnowledgeSource,
  readInterpretationProgress,
  readProcessingAttempt,
  readProcessingJob,
  runProjectOperation,
  StaleInterpretedState,
  startProcessingAttempt,
  takeProcessingLease,
} from '../../src/history/database/index.js';
import { publishProjectSelection } from '../../src/history/database/knowledge-selections.js';
import { processingDispatchContext } from '../../src/history/database/processing-dispatch-context.js';
import { uuidv7 } from '../../src/ids/uuidv7.js';
import {
  interpretationScheduleId,
  interpretationSegmentId,
  interpretationUnitId,
} from '../../src/schema/knowledge-processing-contract.js';
import { prepareInterpretationText } from '../../src/text/interpretation-preparation.js';
import {
  acceptedSelection,
  AT,
  authorityStore,
  type AuthorityStore,
  informedBy,
} from '../knowledge-authority-store.js';
import { capturePlan, DETECTOR, discardKnowledgeStores, OWNER } from '../knowledge-store.js';

const NOW = '2026-09-19T12:00:00.000Z';
const CONFIGURATION = 'c'.repeat(64);
const MANIFEST = 'd'.repeat(64);
const PROCESSOR_CONTRACT = 'knowledge-interpretation@2';
const NOTHING_GOVERNS = {
  kind: 'observed' as const,
  selection_ids: [],
  correction_action_ids: [],
};
const extraHandles: ProjectDatabase[] = [];

afterEach(async () => {
  for (const handle of extraHandles.splice(0)) handle.close();
  await discardKnowledgeStores();
});

const later = (milliseconds: number) => new Date(Date.parse(NOW) + milliseconds).toISOString();

function sourceOf(store: AuthorityStore) {
  return {
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
  };
}

function correctionOf(
  store: AuthorityStore,
  actionId = uuidv7(),
  sourceId = sourceOf(store).source_id
): InterpretedRecord {
  return {
    kind: 'correction',
    action: {
      action_id: actionId,
      kind: 'challenge',
      targets: [store.target],
      scope: store.artifact,
      source_id: sourceId,
      authorization: null,
      expected_state: NOTHING_GOVERNS,
      explanation: 'The interpreted passage challenges the retained requirement.',
    },
    restsOn: [
      {
        target: { kind: store.target.kind, entity_id: store.target.entity_id },
        state: NOTHING_GOVERNS,
      },
    ],
  };
}

async function runningAttempt(
  store: AuthorityStore,
  unitPosition = { index: 0, count: 1 },
  reserveCall = false,
  attemptProcessorContract = PROCESSOR_CONTRACT,
  manifestSha256 = MANIFEST,
  attemptSource = {
    source_id: sourceOf(store).source_id,
    occurrence: sourceOf(store).occurrence,
  }
) {
  const jobId = uuidv7();
  const admissionOperationId = uuidv7();
  await runProjectOperation(
    store.handle,
    {
      operationId: admissionOperationId,
      kind: 'fixture.processing.admit',
      target: { jobId },
      payload: null,
      expectedState: null,
      intentChange: false,
    },
    (transaction) => {
      const admission = admitProcessingJob(
        transaction,
        {
          jobId,
          identity: {
            source: { kind: 'capture_event', event_id: store.plan.planEventId },
            processor_contract: PROCESSOR_CONTRACT,
          },
          path: 'live_capture_settlement',
          originKind: 'captured',
          settledEventTypes: ['plan_captured'],
          derivedByProcessing: false,
          withoutModel: false,
          admittedAt: NOW,
          context: processingDispatchContext({
            artifactId: store.plan.artifactId,
            worktreeRoot: store.handle.authority.resolvedRoot,
          }),
        },
        admissionOperationId
      );
      if (admission.outcome !== 'admitted') throw new Error('the job was not admitted');
      return { jobId };
    }
  );
  const lease = await takeProcessingLease(store.handle, {
    ownerId: 'completion-worker',
    now: NOW,
    expiresAt: later(1_000),
    maxTermMs: 60_000,
  });
  if (lease.outcome !== 'taken') throw new Error('the lease was not taken');
  const generation = lease.lease.ownerGeneration;
  const claim = await claimProcessingJob(store.handle, { generation, now: NOW });
  if (claim.outcome !== 'claimed' || claim.job.jobId !== jobId)
    throw new Error('the job was not claimed');
  const attemptId = uuidv7();
  const prepared = prepareInterpretationText('fixture');
  const units = Array.from({ length: unitPosition.count }, (_, index) => {
    const segmentIdentity = {
      source_id: attemptSource.source_id,
      occurrence: attemptSource.occurrence,
      role: (index === 0 ? 'task' : 'reason') as 'task' | 'reason',
      purpose: 'primary' as const,
      original_sha256: prepared.originalSha256,
      prepared_sha256: prepared.preparedSha256,
      mapping_version: prepared.mappingVersion,
      mapping_sha256: prepared.mappingSha256,
      prepared_range: { start: 0, end: Buffer.byteLength(prepared.prepared) },
      mapping: [...prepared.mapping],
    };
    const segment = { segment_id: interpretationSegmentId(segmentIdentity), ...segmentIdentity };
    return { unit_id: interpretationUnitId([segment]), segments: [segment] };
  });
  const scheduleIdentity = {
    schema: 'orcaops.processing_schedule/v1' as const,
    source_event_id: store.plan.planEventId,
    field_inventory_version: 'fixture-fields/v1',
    units,
    omissions: [],
    omissions_total: 0,
  };
  const schedule = {
    ...scheduleIdentity,
    schedule_id: interpretationScheduleId(scheduleIdentity),
  };
  const selectedUnit = units[unitPosition.index];
  if (selectedUnit === undefined) throw new Error('the selected fixture unit is missing');
  const permission = {
    v: 1 as const,
    confirmation_id: null,
    confirmed_terms: null,
    execution_terms: {
      v: 1 as const,
      project_id: store.handle.authority.projectId,
      job_id: jobId,
      source: claim.job.source,
      origin: { worktree_root: store.handle.authority.resolvedRoot },
      processor_contract: claim.job.processorContract,
      provider: { id: 'claude' as const, selection: 'explicit' as const },
      model: { selection: 'explicit' as const, id: 'fixture-model' },
      effort: { selection: 'provider_default' as const, value: null },
      tool_access: 'none' as const,
      limits: {
        max_cost_usd_per_call: 'none' as const,
        max_cost_usd_per_day: 'none' as const,
        max_calls_per_hour: 60,
        max_input_bytes: 131072,
        max_output_bytes: 131072,
      },
      output_token_cap: { kind: 'none' as const },
      timeout_ms: 120000,
      max_attempts: 3,
    },
    attempt_grant_id: 'grant-1',
  };
  const attempt = {
    generation,
    jobId,
    attemptId,
    startedAt: NOW,
    maxAttempts: 3,
    configurationIdentity: CONFIGURATION,
    configuration: {
      manifest_sha256: manifestSha256,
      processor_contract: attemptProcessorContract,
      schedule_binding: {
        schedule,
        schedule_attempt_id: attemptId,
        unit: {
          schedule_id: schedule.schedule_id,
          unit_id: selectedUnit.unit_id,
          index: unitPosition.index,
          count: unitPosition.count,
        },
      },
      permission,
    },
    confirmationId: null,
    grantId: 'grant-1',
  };
  const started = reserveCall
    ? await startProcessingAttempt(store.handle, {
        ...attempt,
        usageId: uuidv7(),
        maxCallsPerHour: 60,
      })
    : await startProcessingAttempt(store.handle, { ...attempt, usageId: null });
  if (reserveCall ? started.outcome !== 'started' : started.outcome !== 'started_without_call')
    throw new Error('the attempt was not started');
  return {
    jobId,
    attemptId,
    generation,
    manifestSha256,
    source: attemptSource,
    schedule,
    permission,
    segments: selectedUnit.segments,
    unit: {
      scheduleId: schedule.schedule_id,
      unitId: selectedUnit.unit_id,
      index: unitPosition.index,
      count: unitPosition.count,
    },
  };
}

async function retryAttempt(
  store: AuthorityStore,
  first: Awaited<ReturnType<typeof runningAttempt>>,
  unitIndex: number
) {
  const claim = await claimProcessingJob(store.handle, {
    generation: first.generation,
    now: later(500),
  });
  if (claim.outcome !== 'claimed' || claim.job.jobId !== first.jobId)
    throw new Error('the retryable job was not claimed');
  const unit = first.schedule.units[unitIndex];
  if (unit === undefined) throw new Error('the retry unit is missing');
  const attemptId = uuidv7();
  const started = await startProcessingAttempt(store.handle, {
    generation: first.generation,
    jobId: first.jobId,
    attemptId,
    startedAt: later(500),
    maxAttempts: 3,
    configurationIdentity: CONFIGURATION,
    configuration: {
      manifest_sha256: first.manifestSha256,
      processor_contract: PROCESSOR_CONTRACT,
      schedule_binding: {
        schedule: null,
        schedule_attempt_id: first.attemptId,
        unit: {
          schedule_id: first.schedule.schedule_id,
          unit_id: unit.unit_id,
          index: unitIndex,
          count: first.schedule.units.length,
        },
      },
      permission: first.permission,
    },
    confirmationId: null,
    grantId: 'grant-1',
    usageId: null,
  });
  if (started.outcome !== 'started_without_call') throw new Error('the retry did not start');
  return {
    ...first,
    attemptId,
    segments: unit.segments,
    unit: {
      scheduleId: first.schedule.schedule_id,
      unitId: unit.unit_id,
      index: unitIndex,
      count: first.schedule.units.length,
    },
  };
}

function completionInput(
  store: AuthorityStore,
  attempt: Awaited<ReturnType<typeof runningAttempt>>,
  records: InterpretedRecord[]
): PublishProcessingInterpretation {
  return {
    operationId: attempt.attemptId,
    sources: [{ ...sourceOf(store), source_id: attempt.source.source_id }],
    segments: attempt.segments,
    processorContract: PROCESSOR_CONTRACT,
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records,
    secretAllow: [],
    processing: {
      generation: attempt.generation,
      jobId: attempt.jobId,
      attemptId: attempt.attemptId,
      finishedAt: later(500),
      usage: null,
      manifestSha256: attempt.manifestSha256,
      unit: attempt.unit,
      quality: {
        schema: 'orcaops.interpretation_quality/v1',
        outcome: records.length === 0 ? 'empty' : 'accepted',
        proposed: {
          statements: 0,
          corrections: records.length,
          links: 0,
          uncertainties: 0,
        },
        accepted: {
          statements: 0,
          corrections: records.length,
          links: 0,
          uncertainties: 0,
        },
        held_back: { statements: 0, corrections: 0, links: 0, uncertainties: 0 },
        rejected: { statements: 0, corrections: 0, links: 0, uncertainties: 0 },
        diagnostics: [],
        diagnostics_total: 0,
        diagnostics_omitted: 0,
      },
      outcome: {
        kind: 'completed',
        result: { source_coverage: 'complete' },
        detail: { unit_settled: true },
      },
    },
  };
}

it('commits publication and processing progress under one exact receipt', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const input = completionInput(store, attempt, [correctionOf(store)]);

  const first = await publishInterpretedKnowledgeAndSettleAttempt(store.handle, input);
  const replay = await publishInterpretedKnowledgeAndSettleAttempt(store.handle, input);

  expect(first.replayed).toBe(false);
  expect(first.value.publishingOperationId).toBe(attempt.attemptId);
  expect(replay).toEqual({ ...first, replayed: true });
  expect(readProcessingAttempt(store.handle, attempt.attemptId)).toMatchObject({
    outcome: 'succeeded',
    publishingOperationId: attempt.attemptId,
  });
  expect(readProcessingJob(store.handle, attempt.jobId)?.state).toBe('completed');

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, {
      ...input,
      processing: {
        ...input.processing,
        unit: { ...input.processing.unit, index: 1, count: 2 },
      },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

it('commits an intermediate publication with its next-unit progress', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store, { index: 0, count: 2 });
  const input = completionInput(store, attempt, [correctionOf(store)]);
  input.processing.outcome = {
    kind: 'unit_completed',
    retryAt: later(500),
    detail: { unit_settled: true },
  };

  const completed = await publishInterpretedKnowledgeAndSettleAttempt(store.handle, input);

  expect(completed.value.publishingOperationId).toBe(attempt.attemptId);
  expect(readProcessingAttempt(store.handle, attempt.attemptId)).toMatchObject({
    outcome: 'failed',
    publishingOperationId: attempt.attemptId,
    detail: {
      unit_settled: true,
    },
  });
  expect(readProcessingJob(store.handle, attempt.jobId)).toMatchObject({
    state: 'retryable_failure',
    waitReason: 'source_unit_pending',
  });
});

it('rejects a scheduled unit before its preceding units have receipts', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store, { index: 1, count: 2 });
  const before = store.handle.read(() => null).counters;

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, completionInput(store, attempt, []))
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
  expect(readInterpretationProgress(store.handle, attempt.jobId)?.receipts).toEqual([]);
});

it('rejects a second attempt to settle a unit that already has a receipt', async () => {
  const store = await authorityStore();
  const first = await runningAttempt(store, { index: 0, count: 2 });
  const firstInput = completionInput(store, first, []);
  firstInput.processing.outcome = {
    kind: 'unit_completed',
    retryAt: later(500),
    detail: { unit_settled: true },
  };
  await publishInterpretedKnowledgeAndSettleAttempt(store.handle, firstInput);
  const duplicate = await retryAttempt(store, first, 0);
  const duplicateInput = completionInput(store, duplicate, []);
  duplicateInput.processing.outcome = {
    kind: 'unit_completed',
    retryAt: later(750),
    detail: { unit_settled: true },
  };
  const before = store.handle.read(() => null).counters;

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, duplicateInput)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingAttempt(store.handle, duplicate.attemptId)?.outcome).toBeNull();
  expect(readInterpretationProgress(store.handle, first.jobId)?.receipts).toHaveLength(1);
});

it('refuses a source occurrence restricted after its unit was scheduled', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const canonicalSourceId = uuidv7();
  await publishProjectKnowledgeSource(store.handle, {
    operationId: uuidv7(),
    source: {
      ...sourceOf(store),
      source_id: canonicalSourceId,
      access_restriction: 'owner only',
    },
    recordedBy: OWNER,
    secretAllow: [],
  });
  const actionId = uuidv7();
  const before = store.handle.read(() => null).counters;

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(
      store.handle,
      completionInput(store, attempt, [correctionOf(store, actionId)])
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
  expect(readInterpretationProgress(store.handle, attempt.jobId)?.receipts).toEqual([]);
  expect(
    store.handle.read((view) =>
      view.get('SELECT action_id FROM correction_actions WHERE action_id=?', actionId)
    ).value
  ).toBeNull();
  expect(
    store.handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', attempt.attemptId)
    ).value
  ).toBeNull();
});

it('refuses restricted sources when every proposed record is already retained', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const canonicalSourceId = uuidv7();
  const actionId = uuidv7();
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    source: {
      ...sourceOf(store),
      source_id: canonicalSourceId,
      access_restriction: 'owner only',
    },
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records: [correctionOf(store, actionId, canonicalSourceId)],
    secretAllow: [],
  });
  const before = store.handle.read(() => null).counters;

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(
      store.handle,
      completionInput(store, attempt, [correctionOf(store, actionId)])
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
  expect(readInterpretationProgress(store.handle, attempt.jobId)?.receipts).toEqual([]);
  expect(
    store.handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', attempt.attemptId)
    ).value
  ).toBeNull();
});

it('rejects a completion from a different manifest than the retained attempt', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const input = completionInput(store, attempt, []);
  input.processing.manifestSha256 = 'e'.repeat(64);

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, input)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
});

it('rejects another field from the job event even when its unit tuple matches', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const original = completionInput(store, attempt, []);
  const input: PublishProcessingInterpretation = {
    ...original,
    sources: [
      {
        ...sourceOf(store),
        source_id: `${store.plan.planEventId}#label#0`,
        occurrence: { ...sourceOf(store).occurrence, field_path: 'label' },
      },
    ],
  };

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, input)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
});

it('binds the requested source identity when its occurrence maps to a retained source', async () => {
  const store = await authorityStore();
  const source = sourceOf(store);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    source,
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records: [correctionOf(store)],
    secretAllow: [],
  });
  const requestedSource = { source_id: uuidv7(), occurrence: source.occurrence };
  const attempt = await runningAttempt(
    store,
    undefined,
    false,
    PROCESSOR_CONTRACT,
    MANIFEST,
    requestedSource
  );
  const original = completionInput(store, attempt, []);
  const input: PublishProcessingInterpretation = {
    ...original,
    sources: [{ ...source, source_id: requestedSource.source_id }],
  };

  const completed = await publishInterpretedKnowledgeAndSettleAttempt(store.handle, input);

  expect(completed.value.publication).toMatchObject({
    sourceId: source.source_id,
    sourceReplay: true,
  });
  expect(readProcessingJob(store.handle, attempt.jobId)?.state).toBe('completed');
});

it('rejects completion terms that do not belong to the retained attempt and source', async () => {
  const nonfinalStore = await authorityStore();
  const nonfinalAttempt = await runningAttempt(nonfinalStore, { index: 0, count: 2 });
  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(
      nonfinalStore.handle,
      completionInput(nonfinalStore, nonfinalAttempt, [])
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  const finalStore = await authorityStore();
  const finalAttempt = await runningAttempt(finalStore);
  const pendingFinal = completionInput(finalStore, finalAttempt, []);
  pendingFinal.processing.outcome = {
    kind: 'unit_completed',
    retryAt: later(500),
    detail: { unit_settled: true },
  };
  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(finalStore.handle, pendingFinal)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  const changedPlanStore = await authorityStore();
  const changedPlanAttempt = await runningAttempt(changedPlanStore);
  const changedPlan = completionInput(changedPlanStore, changedPlanAttempt, []);
  changedPlan.processing.unit = { ...changedPlan.processing.unit, scheduleId: 'b'.repeat(64) };
  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(changedPlanStore.handle, changedPlan)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  const sourceStore = await authorityStore();
  const sourceAttempt = await runningAttempt(sourceStore);
  const unrelatedArtifactId = uuidv7();
  const unrelatedEventId = uuidv7();
  await capturePlan(sourceStore.handle, {
    artifactId: unrelatedArtifactId,
    planEventId: unrelatedEventId,
    task: 'An unrelated capture must not settle this job.',
    steps: [{ stepId: uuidv7(), criteria: [] }],
  });
  const wrongSource = {
    ...completionInput(sourceStore, sourceAttempt, []),
    sources: [
      {
        ...sourceOf(sourceStore),
        source_id: `${unrelatedEventId}#task#0`,
        occurrence: {
          ...sourceOf(sourceStore).occurrence,
          artifact_id: unrelatedArtifactId,
          event_id: unrelatedEventId,
        },
      },
    ],
  };
  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(sourceStore.handle, wrongSource)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  const contractStore = await authorityStore();
  const contractAttempt = await runningAttempt(
    contractStore,
    undefined,
    false,
    'knowledge-interpretation@other'
  );
  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(
      contractStore.handle,
      completionInput(contractStore, contractAttempt, [])
    )
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

it('leaves publication and progress absent after ownership moves', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const actionId = uuidv7();
  const input = completionInput(store, attempt, [correctionOf(store, actionId)]);
  const replacement = await takeProcessingLease(store.handle, {
    ownerId: 'replacement-worker',
    now: later(1_001),
    expiresAt: later(20_000),
    maxTermMs: 60_000,
  });
  expect(replacement.outcome).toBe('taken');

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, input)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
  expect(
    store.handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', attempt.attemptId)
    ).value
  ).toBeNull();
  expect(
    store.handle.read((view) =>
      view.get('SELECT action_id FROM correction_actions WHERE action_id=?', actionId)
    ).value
  ).toBeNull();
});

it('rolls publication back when progress cannot settle after domain inserts', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store, undefined, true);
  const actionId = uuidv7();
  const input = completionInput(store, attempt, [correctionOf(store, actionId)]);
  const before = store.handle.read(() => null).counters;

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, input)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });

  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
  expect(
    store.handle.read((view) =>
      view.get('SELECT action_id FROM correction_actions WHERE action_id=?', actionId)
    ).value
  ).toBeNull();
  expect(
    store.handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', attempt.attemptId)
    ).value
  ).toBeNull();
});

it('settles concurrent empty completions with one source publication', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const input = completionInput(store, attempt, []);
  const before = store.handle.read(() => null).counters;
  const other = await openProjectDatabase({ authority: store.authority, mode: 'writer' });
  extraHandles.push(other);

  const [first, second] = await Promise.all([
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, input),
    publishInterpretedKnowledgeAndSettleAttempt(other, input),
  ]);

  expect(first.value).toEqual(second.value);
  expect(store.handle.read(() => null).counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
  expect(readProcessingJob(store.handle, attempt.jobId)?.state).toBe('completed');
  expect(
    store.handle.read((view) =>
      view.get('SELECT operation_id FROM operations WHERE operation_id=?', attempt.attemptId)
    ).value
  ).toEqual({ operation_id: attempt.attemptId });
});

it('rejects changed settlement and source requests after an empty completion', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const input = completionInput(store, attempt, []);
  const before = store.handle.read(() => null).counters;

  await publishInterpretedKnowledgeAndSettleAttempt(store.handle, input);

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, {
      ...input,
      processing: { ...input.processing, finishedAt: later(600) },
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(store.handle, {
      ...input,
      sources: [{ ...sourceOf(store), access_restriction: 'owner only' }],
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(store.handle.read(() => null).counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
});

it('settles a held-back-only successful unit with its source publication', async () => {
  const store = await authorityStore();
  const attempt = await runningAttempt(store);
  const input = completionInput(store, attempt, []);
  const heldBack = [
    { kind: 'requirement_revision', reason: 'The candidate was not strong enough to publish.' },
  ];
  input.processing.outcome = {
    kind: 'completed',
    result: { source_coverage: 'complete', held_back: heldBack },
    detail: { unit_settled: true, held_back: heldBack },
  };
  const before = store.handle.read(() => null).counters;

  const completed = await publishInterpretedKnowledgeAndSettleAttempt(store.handle, input);

  expect(completed.value).toMatchObject({
    publishingOperationId: attempt.attemptId,
    publication: { published: [] },
  });
  expect(readProcessingAttempt(store.handle, attempt.attemptId)).toMatchObject({
    outcome: 'succeeded',
    detail: { unit_settled: true, held_back: heldBack },
  });
  expect(readProcessingJob(store.handle, attempt.jobId)?.state).toBe('completed');
  expect(store.handle.read(() => null).counters).toEqual({
    writeSequence: before.writeSequence + 1,
    intentChangeCounter: before.intentChangeCounter,
  });
});

it('advances an all-replay completion without an authored operation', async () => {
  const store = await authorityStore();
  const actionId = uuidv7();
  const record = correctionOf(store, actionId);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    source: sourceOf(store),
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records: [record],
    secretAllow: [],
  });
  const attempt = await runningAttempt(store);
  const before = store.handle.read(() => null).counters;

  const completed = await publishInterpretedKnowledgeAndSettleAttempt(
    store.handle,
    completionInput(store, attempt, [record])
  );

  expect(completed.replayed).toBe(true);
  expect(completed.value.publication.published).toEqual([
    {
      kind: 'correction',
      id: actionId,
      revisionId: null,
      replay: true,
    },
  ]);
  expect(completed.value.publishingOperationId).toBeNull();
  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingJob(store.handle, attempt.jobId)?.state).toBe('completed');
});

it('revalidates governing state before an all-replay completion advances', async () => {
  const store = await authorityStore();
  const record = correctionOf(store);
  await publishInterpretedKnowledge(store.handle, {
    operationId: uuidv7(),
    source: sourceOf(store),
    recordedBy: OWNER,
    attributedTo: DETECTOR,
    scope: store.artifact,
    records: [record],
    secretAllow: [],
  });
  const attempt = await runningAttempt(store);
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
  const before = store.handle.read(() => null).counters;

  await expect(
    publishInterpretedKnowledgeAndSettleAttempt(
      store.handle,
      completionInput(store, attempt, [record])
    )
  ).rejects.toBeInstanceOf(StaleInterpretedState);
  expect(store.handle.read(() => null).counters).toEqual(before);
  expect(readProcessingAttempt(store.handle, attempt.attemptId)?.outcome).toBeNull();
});
