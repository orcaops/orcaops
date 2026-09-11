import { canonicalJson } from '../../events/canonical-json.js';
import { digest } from '../event-integrity.js';
import type { AppendProjectArtifactEvents } from './artifacts.js';
import type { ProjectDatabase } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  type CaptureExecutionContext,
  type prepareExecutionCaptureRequest,
  restoreExecutionCaptureRequest,
} from './execution-capture.js';
import { insertPendingPlanKeys } from './pending-plan-keys.js';
import {
  preparePlanCaptureInsertion,
  restorePlanCaptureCommand,
  selectPlanCaptureCommand,
} from './plan-capture.js';
import { assertCapturePublicationEvent } from './retention-event.js';
import type { GitRetentionPreparation } from './retention-input.js';
import { readRetentionRecords, retentionId, retentionIntegrity } from './retention-records.js';
import type { ProjectSettlement } from './transactions.js';
import type { DatabaseJson } from './values.js';

export type PendingCaptureInput = AppendProjectArtifactEvents & {
  execution: CaptureExecutionContext;
};
export type CapturePreparation = ReturnType<typeof prepareExecutionCaptureRequest>;

export function captureRetentionOperation(
  capture: CapturePreparation,
  retention: GitRetentionPreparation,
  mode: 'capture' | 'import' = 'capture'
) {
  return {
    operationId: retention.admissionOperationId,
    kind: `${mode}.retention.begin`,
    target: { originalOperationId: retention.operationId, artifactId: capture.request.artifactId },
    payload: JSON.parse(
      canonicalJson({ retention, capture: capture.operation.payload })
    ) as DatabaseJson,
    expectedState: JSON.parse(canonicalJson(retention.target)) as DatabaseJson,
    intentChange: false,
  };
}

export function assertCaptureRetentionInput(
  capture: CapturePreparation,
  retention: GitRetentionPreparation
): void {
  const { request, execution } = capture;
  const target = retention.target;
  if (
    target.kind !== 'capture' ||
    request.operationId !== retention.operationId ||
    request.artifactId !== target.artifactId ||
    canonicalJson(request.expected) !== canonicalJson(target.expectedRevision) ||
    execution.context.repository_instance_id !== retention.repositoryInstanceId ||
    (execution.kind === 'create' ? null : execution.expectedVersion) !==
      target.expectedExecutionVersion ||
    (execution.kind === 'create' ? null : execution.expectedGeneration) !==
      target.expectedBindingGeneration
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Retain the same original capture operation, artifact revision and execution expectation'
    );
  for (const publication of retention.publications) {
    const entry = request.incoming.find(
      ({ event }) => event.record.event_id === publication.targetId
    );
    if (!entry)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Capture publication must identify an event in this exact original pending request'
      );
    assertCapturePublicationEvent(target.artifactId, publication, entry.event);
  }
}

export function insertPendingCapture(tx: ProjectSettlement, capture: CapturePreparation): void {
  const { request, execution } = capture;
  const context = execution.context;
  tx.run(
    'INSERT INTO pending_capture_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    request.operationId,
    execution.kind,
    context.repository_instance_id,
    context.worktree_id,
    context.git_context.branch,
    context.git_context.head_sha,
    execution.kind === 'create' ? execution.ts : null,
    execution.kind === 'create' ? null : Number(execution.explicitTarget)
  );
  request.incoming.forEach(({ event, bytes, sidecar }, index) =>
    tx.run(
      'INSERT INTO pending_capture_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      request.operationId,
      index + 1,
      event.record.event_id,
      event.record.type,
      bytes,
      sidecar,
      event.record.checksum,
      digest(bytes),
      sidecar === null ? null : digest(sidecar)
    )
  );
  insertPendingPlanKeys(tx, capture);
}

export function readProjectPendingCapture(handle: ProjectDatabase, originalOperationId: string) {
  retentionId(originalOperationId);
  const observed = handle.read((view) => {
    const retention = readRetentionRecords(view, originalOperationId);
    if (!retention) return null;
    const request = view.get<{
      kind: CaptureExecutionContext['kind'];
      repository: string;
      worktree: string;
      branch: string | null;
      head: string | null;
      createdAt: string | null;
      explicit: number | null;
    }>(
      'SELECT capture_kind AS kind, repository_instance_id AS repository, worktree_id AS worktree, branch, head_oid AS head, created_at AS createdAt, explicit_target AS explicit FROM pending_capture_requests WHERE original_operation_id = ?',
      originalOperationId
    );
    if (!request) return { retention, request: null, rows: [], receipt: null };
    const rows = view.all<{
      ordinal: number;
      eventId: string;
      type: string;
      bytes: string;
      sidecar: string | null;
      checksum: string;
      hash: string;
      sidecarHash: string | null;
    }>(
      'SELECT ordinal, event_id AS eventId, event_type AS type, hex(event_bytes) AS bytes, CASE WHEN sidecar_bytes IS NULL THEN NULL ELSE hex(sidecar_bytes) END AS sidecar, event_checksum AS checksum, record_hash AS hash, sidecar_hash AS sidecarHash FROM pending_capture_events WHERE original_operation_id = ? ORDER BY ordinal',
      originalOperationId
    );
    const receipt = view.get<{ kind: string; target: string; payload: string; expected: string }>(
      'SELECT operation_kind AS kind, target_json AS target, payload_json AS payload, expected_state_json AS expected FROM operations WHERE operation_id = ?',
      retention.input.admissionOperationId
    );
    const planCommand =
      receipt?.kind === 'plan.capture.retention.begin'
        ? selectPlanCaptureCommand(view, { originalOperationId })
        : null;
    return { retention, request, rows, receipt, planCommand };
  });
  const value = observed.value;
  if (!value) return { value: null, counters: observed.counters };
  if (!value.request) {
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'This operation has no retained original capture input; preserve any refs and use its original domain operation or explicit repair'
    );
  }
  try {
    const { retention, request, rows, receipt } = value;
    const target = retention.input.target;
    if (target.kind !== 'capture' || !rows.length || !receipt) retentionIntegrity();
    const context = {
      repository_instance_id: request.repository,
      worktree_id: request.worktree,
      git_context: { branch: request.branch, head_sha: request.head },
    };
    const execution =
      request.kind === 'create'
        ? { kind: request.kind, context, ts: request.createdAt! }
        : {
            kind: request.kind,
            context,
            expectedVersion: target.expectedExecutionVersion!,
            expectedGeneration: target.expectedBindingGeneration!,
            explicitTarget: request.explicit === 1,
          };
    if (
      (request.kind === 'create') !== (request.createdAt !== null) ||
      (request.kind === 'create' ? request.explicit !== null : ![0, 1].includes(request.explicit!))
    )
      retentionIntegrity();
    const input: PendingCaptureInput = {
      operationId: originalOperationId,
      artifactId: target.artifactId,
      expectedRevision: target.expectedRevision,
      eventBytes: Buffer.concat(rows.map((row) => Buffer.from(row.bytes, 'hex'))),
      sidecarPayloads: rows
        .filter((row) => row.sidecar !== null)
        .map((row) => ({ eventId: row.eventId, bytes: Buffer.from(row.sidecar!, 'hex') })),
      secretAllow: [],
      execution,
    };
    const restored = restoreExecutionCaptureRequest(handle, input);
    if (restored.request.incoming.length !== rows.length) retentionIntegrity();
    rows.forEach((row, index) => {
      const { event, bytes, sidecar } = restored.request.incoming[index]!;
      if (
        row.ordinal !== index + 1 ||
        row.eventId !== event.record.event_id ||
        row.type !== event.record.type ||
        row.checksum !== event.record.checksum ||
        row.hash !== digest(bytes) ||
        row.sidecarHash !== (sidecar === null ? null : digest(sidecar))
      )
        retentionIntegrity();
    });
    assertCaptureRetentionInput(restored, retention.input);
    const mode = receipt.kind === 'import.retention.begin' ? 'import' : 'capture';
    const originalOperation = captureRetentionOperation(restored, retention.input, mode);
    let operation: ReturnType<typeof captureRetentionOperation> = originalOperation;
    if (receipt.kind === 'plan.capture.retention.begin') {
      if (!value.planCommand) retentionIntegrity();
      const { command } = restorePlanCaptureCommand(value.planCommand);
      const plan = preparePlanCaptureInsertion(command, restored, originalOperation.operationId);
      operation = {
        ...originalOperation,
        kind: 'plan.capture.retention.begin',
        payload: { capture: originalOperation.payload, command: plan.payload },
      };
    }
    if (
      receipt.kind !== operation.kind ||
      receipt.target !== canonicalJson(operation.target) ||
      receipt.payload !== canonicalJson(operation.payload) ||
      receipt.expected !== canonicalJson(operation.expectedState)
    )
      retentionIntegrity();
    return { value: { capture: input, retention, mode }, counters: observed.counters };
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Retained pending capture input or its original admission receipt is inconsistent; preserve history for explicit repair',
      { cause }
    );
  }
}
