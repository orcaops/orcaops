import { isDeepStrictEqual } from 'node:util';

import { readProjectArtifact } from './artifacts.js';
import { hydratePlanIdempotencyRecord, selectPlanIdempotencyRecord } from './capture-lifecycles.js';
import { captureIntegrity } from './capture-records.js';
import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { prepareExecutionCaptureRequest } from './execution-capture.js';
import { assertPendingPlanKeyOwnership } from './pending-plan-keys.js';
import {
  assertSamePlanCaptureInput,
  planCaptureCommand,
  planCaptureInput,
  type PreparedPlanCaptureCommand,
  type PreparedPlanCaptureInput,
  preparePlanCaptureCommand,
  restorePlanCaptureInput,
} from './plan-capture-input.js';
import type { ProjectSettlement } from './transactions.js';
import type { EventWithPayload } from '../../events/rebuilders.js';
import { DecisionBaseSchema } from '../../schema/decision.js';
import { PlanInputSchema } from '../../schema/plan.js';
import { SourcePlanPinSchema } from '../../schema/source-plan.js';

interface CommandRow {
  idempotencyKey: string;
  originalOperationId: string;
  admissionOperationId: string;
  artifactId: string;
  planEventId: string;
  requestHex: string;
  requestHash: string;
  retainedAdmission: string | null;
}
export function selectPlanCaptureCommand(
  view: ProjectReadView,
  selected: { key: string } | { originalOperationId: string }
) {
  return (
    view.get<CommandRow>(
      `SELECT c.idempotency_key AS idempotencyKey, c.original_operation_id AS originalOperationId,
      c.admission_operation_id AS admissionOperationId, c.artifact_id AS artifactId,
      c.plan_event_id AS planEventId, hex(c.request_bytes) AS requestHex, c.request_hash AS requestHash,
      o.operation_id AS retainedAdmission
     FROM plan_capture_commands c LEFT JOIN operations o ON o.operation_id=c.admission_operation_id
     WHERE ${'key' in selected ? 'c.idempotency_key' : 'c.original_operation_id'}=?`,
      'key' in selected ? selected.key : selected.originalOperationId
    ) ?? null
  );
}

export function readProjectPlanCapture(handle: ProjectDatabase, input: PreparedPlanCaptureInput) {
  const expected = planCaptureInput(input);
  assertProjectDatabasePath(handle);
  const snapshot = handle.read((view) => {
    const command = selectPlanCaptureCommand(view, { key: expected.idempotencyKey });
    const historical = selectPlanIdempotencyRecord(view, expected.idempotencyKey);
    const owner = command
      ? { eventId: command.planEventId, originalOperationId: command.originalOperationId }
      : historical
        ? (view.get<{ eventId: string }>(
            `SELECT e.event_id AS eventId FROM artifact_events e JOIN pending_plan_keys k ON k.event_id=e.event_id
            JOIN pending_capture_events p ON p.event_id=k.event_id AND p.original_operation_id=k.original_operation_id
            JOIN git_retention_capture_targets t ON t.original_operation_id=k.original_operation_id
            WHERE e.artifact_id=? AND t.artifact_id=e.artifact_id AND e.event_type='plan_captured'
              AND p.event_bytes=e.record_bytes AND p.sidecar_bytes IS e.sidecar_payload_bytes
              AND k.idempotency_key=? LIMIT 1`,
            historical.artifactId,
            expected.idempotencyKey
          ) ?? undefined)
        : undefined;
    assertPendingPlanKeyOwnership(view, expected.idempotencyKey, owner);
    return { command, historical };
  });
  if (snapshot.value.command && snapshot.value.historical)
    captureIntegrity('A plan key has conflicting historical and command ownership');
  const row = snapshot.value.command;
  if (row) {
    const { command, original } = restorePlanCaptureCommand(row);
    assertSamePlanCaptureInput(input, original);
    return { kind: 'command' as const, command, counters: snapshot.counters };
  }
  const historical = hydratePlanIdempotencyRecord({
    value: snapshot.value.historical,
    counters: snapshot.counters,
  });
  if (!historical) return null;
  const artifact = readProjectArtifact(handle, historical.record.artifact_id);
  if (!artifact)
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The committed plan key identifies missing artifact history; preserve its original key for explicit repair'
    );
  const event = artifact.thread.events.find(
    (event) =>
      event.record.type === 'plan_captured' &&
      event.record.idempotency_key === expected.idempotencyKey
  );
  if (!event)
    captureIntegrity('The committed plan key does not identify its retained original plan event');
  assertPlanCaptureMeaning(input, event);
  return {
    kind: 'historical' as const,
    historical,
    artifact,
    planEventId: event.record.event_id,
    counters: snapshot.counters,
  };
}

export function restorePlanCaptureCommand(row: CommandRow) {
  let command: PreparedPlanCaptureCommand;
  let original: PreparedPlanCaptureInput;
  try {
    if (row.retainedAdmission !== row.admissionOperationId)
      throw new Error('Admission receipt is missing');
    original = restorePlanCaptureInput(
      Buffer.from(row.requestHex, 'hex').toString('utf8'),
      row.requestHash
    );
    if (row.idempotencyKey !== planCaptureInput(original).idempotencyKey)
      throw new Error('Key differs from original request');
    command = preparePlanCaptureCommand(original, {
      originalOperationId: row.originalOperationId,
      admissionOperationId: row.admissionOperationId,
      artifactId: row.artifactId,
      planEventId: row.planEventId,
    });
  } catch (cause) {
    captureIntegrity('The original plan command cannot be restored', cause);
  }
  return { command, original };
}

export function assertPlanCaptureMeaning(input: PreparedPlanCaptureInput, event: EventWithPayload) {
  const expected = planCaptureInput(input);
  try {
    if (
      event.record.type !== 'plan_captured' ||
      event.record.idempotency_key !== expected.idempotencyKey
    )
      throw new Error('The original keyed initial event is unavailable');
    const plan = PlanInputSchema.parse(event.payload);
    if (plan.revision_n !== 0 || plan.origin)
      throw new Error('Original authored plan is unavailable');
    const source = event.payload as { source_plan?: unknown };
    const sourcePlan = SourcePlanPinSchema.nullable().parse(source.source_plan ?? null);
    const authored = expected.authored;
    if (
      !isDeepStrictEqual(
        {
          task: plan.task,
          label: plan.label,
          plan_steps: plan.plan_steps.map((step) => ({
            text: step.text,
            label: step.label,
            acceptance_criteria: step.acceptance_criteria.map(({ text }) => ({ text })),
          })),
          touched_scope: plan.touched_scope,
          non_goals: plan.non_goals,
          decisions: plan.decisions.map((decision) => DecisionBaseSchema.parse(decision)),
          sourcePlan,
        },
        {
          task: authored.task,
          label: authored.label,
          plan_steps: authored.plan_steps,
          touched_scope: authored.touched_scope,
          non_goals: authored.non_goals,
          decisions: authored.decisions,
          sourcePlan: expected.sourcePlan,
        }
      ) ||
      (authored.branch !== undefined && authored.branch !== plan.branch) ||
      (authored.agent_session_id !== undefined &&
        authored.agent_session_id !== plan.agent_session_id)
    )
      throw new Error('Original plan meaning differs');
    return plan;
  } catch (cause) {
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'The original key cannot prove the same authored plan and source pin; retain its original input or use an explicitly new key',
      { cause }
    );
  }
}

export function preparePlanCaptureInsertion(
  command: PreparedPlanCaptureCommand,
  capture: ReturnType<typeof prepareExecutionCaptureRequest>,
  admissionOperationId: string
) {
  const record = planCaptureCommand(command);
  const first = capture.request.incoming[0];
  if (
    capture.execution.kind !== 'create' ||
    capture.request.expected !== null ||
    capture.request.operationId !== record.originalOperationId ||
    capture.request.artifactId !== record.artifactId ||
    admissionOperationId !== record.admissionOperationId ||
    first?.event.record.event_id !== record.planEventId
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Compose original plan command IDs with their exact creation and admission'
    );
  const original = restorePlanCaptureInput(record.requestBytes, record.requestHash);
  const plan = assertPlanCaptureMeaning(original, first.event);
  if (plan.artifact_id !== record.artifactId)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'The original plan event identifies a different artifact'
    );
  const parameters = [
    record.idempotencyKey,
    record.originalOperationId,
    record.admissionOperationId,
    record.artifactId,
    record.planEventId,
    Buffer.from(record.requestBytes),
    record.requestHash,
  ];
  return {
    payload: {
      idempotencyKey: record.idempotencyKey,
      requestHash: record.requestHash,
      originalOperationId: record.originalOperationId,
      admissionOperationId: record.admissionOperationId,
      artifactId: record.artifactId,
      planEventId: record.planEventId,
    },
    settle(transaction: ProjectSettlement) {
      if (
        transaction.get(
          `SELECT operation_id FROM operations WHERE operation_id IN (?, ?)
          UNION ALL SELECT original_operation_id FROM git_retention_operations
          WHERE original_operation_id IN (?, ?) LIMIT 1`,
          record.originalOperationId,
          record.admissionOperationId,
          record.originalOperationId,
          record.admissionOperationId
        )
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'The original plan operation identity already belongs to a retained operation or committed receipt; retain that operation and use explicitly new identities'
        );
      if (
        selectPlanCaptureCommand(transaction, { key: record.idempotencyKey }) ||
        selectPlanIdempotencyRecord(transaction, record.idempotencyKey)
      )
        throw new ProjectDatabaseError(
          'IDEMPOTENCY_CONFLICT',
          'This key acquired original ownership before admission; look up that command without retargeting'
        );
      assertPendingPlanKeyOwnership(transaction, record.idempotencyKey);
      transaction.run(
        'INSERT INTO plan_capture_commands VALUES (?, ?, ?, ?, ?, ?, ?)',
        ...parameters
      );
    },
  };
}

export function composePlanCaptureOperation(
  capture: ReturnType<typeof prepareExecutionCaptureRequest>,
  plan: ReturnType<typeof preparePlanCaptureInsertion>,
  useHashes: readonly string[]
) {
  return {
    ...capture.operation,
    kind: 'plan.capture.append',
    payload: {
      capture: capture.operation.payload,
      command: plan.payload,
      ...(useHashes.length > 0 ? { knowledge_uses: [...useHashes] } : {}),
    },
  };
}
