import { captureIntegrity } from './capture-records.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import type { CapturePreparation } from './pending-capture.js';
import type { ProjectSettlement } from './transactions.js';
import type { EventRecord } from '../../events/event-log.js';

interface PendingPlanKey {
  readonly eventId: string;
  readonly originalOperationId: string;
  readonly idempotencyKey: string;
}
function pendingPlanKey(record: EventRecord, originalOperationId: string): PendingPlanKey {
  return Object.freeze({
    eventId: record.event_id,
    originalOperationId,
    idempotencyKey: record.idempotency_key,
  });
}

function insertKey(tx: Pick<ProjectSettlement, 'run'>, row: PendingPlanKey): void {
  tx.run(
    'INSERT INTO pending_plan_keys VALUES (?, ?, ?)',
    row.eventId,
    row.originalOperationId,
    row.idempotencyKey
  );
}

function assertPendingPlanKeyMembership(
  view: ProjectReadView,
  admittingOperationId: string | null = null
): void {
  if (
    view.get(
      `SELECT e.event_id FROM pending_capture_events e
      LEFT JOIN pending_plan_keys k ON k.event_id = e.event_id
      WHERE e.event_type = 'plan_captured'
        AND ((k.event_id IS NULL AND e.original_operation_id IS NOT ?)
          OR (k.event_id IS NOT NULL AND k.original_operation_id != e.original_operation_id)) LIMIT 1`,
      admittingOperationId
    ) ||
    view.get(`SELECT k.event_id FROM pending_plan_keys k LEFT JOIN pending_capture_events e
      ON e.event_id = k.event_id WHERE e.event_id IS NULL OR e.event_type != 'plan_captured' LIMIT 1`)
  )
    captureIntegrity(
      'Pending plan key membership is incomplete; preserve original input for explicit repair'
    );
}

export function assertPendingPlanKeyOwnership(
  view: ProjectReadView,
  key: string,
  owner?: { eventId: string; originalOperationId?: string }
): void {
  assertPendingPlanKeyMembership(view);
  const conflicting = view.get<{ originalOperationId: string }>(
    `SELECT original_operation_id AS originalOperationId FROM pending_plan_keys
      WHERE idempotency_key = ? AND NOT (event_id IS ?
        AND (? IS NULL OR original_operation_id = ?)) LIMIT 1`,
    key,
    owner?.eventId ?? null,
    owner?.originalOperationId ?? null,
    owner?.originalOperationId ?? null
  );
  if (conflicting)
    throw new ProjectDatabaseError(
      'STALE_CONTEXT',
      `The plan key belongs to retained pending input for operation ${conflicting.originalOperationId}; recover that original operation ID or use an explicitly new key, without inventing its missing command input`
    );
}

export function insertPendingPlanKeys(tx: ProjectSettlement, capture: CapturePreparation): void {
  const rows = capture.request.incoming
    .filter(({ event }) => event.record.type === 'plan_captured')
    .map(({ event }) => pendingPlanKey(event.record, capture.request.operationId));
  // This admission has inserted its original events, but not their derived keys yet.
  assertPendingPlanKeyMembership(tx, capture.request.operationId);
  for (const row of rows) {
    const conflict = tx.get(
      `SELECT idempotency_key FROM plan_capture_commands
      WHERE idempotency_key = ? AND (original_operation_id != ? OR plan_event_id != ?)
      UNION ALL SELECT idempotency_key FROM plan_idempotency_records WHERE idempotency_key = ?
      UNION ALL SELECT idempotency_key FROM pending_plan_keys WHERE idempotency_key = ? LIMIT 1`,
      row.idempotencyKey,
      row.originalOperationId,
      row.eventId,
      row.idempotencyKey,
      row.idempotencyKey
    );
    if (conflict)
      throw new ProjectDatabaseError(
        'IDEMPOTENCY_CONFLICT',
        'The pending plan key already has original ownership; look up its retained operation without retargeting'
      );
    insertKey(tx, row);
  }
}
