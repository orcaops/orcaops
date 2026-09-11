import { isUuidV7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import type { ExecutionPin } from '../execution-focus.js';
import type { ArtifactRevision } from './artifacts.js';
import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  decodeRetainedFocusPin,
  type PreparedProjectFocus,
  prepareProjectFocus,
  type ProjectFocusChange,
  type ProjectFocusScope,
  projectFocusScopeJson,
  type ProjectFocusSelection,
} from './execution-focus-input.js';
import { readProjectExecutionFocusOperation } from './execution-focus-operation.js';
import {
  type ProjectOperationOptions,
  type ProjectOperationResult,
  runProjectOperation,
} from './transactions.js';

export type ProjectExecutionFocusSnapshot = { counters: ProjectCounters } & (
  | { status: 'absent'; selection: null }
  | { status: 'cleared'; selection: ProjectFocusSelection }
  | {
      status: 'present';
      selection: ProjectFocusSelection;
      pin: ExecutionPin;
      pinBytes: Buffer;
      pinHash: string;
    }
);
export type ProjectFocusPublication = {
  status: 'present' | 'cleared';
  selection: ProjectFocusSelection;
};

function invalid(message: string): never {
  throw new ProjectDatabaseError(
    'HISTORY_INTEGRITY_REQUIRED',
    `${message}; preserve retained focus and execution history for explicit repair`
  );
}
function stale(): never {
  throw new ProjectDatabaseError(
    'STALE_CONTEXT',
    'The focus selection or intended artifact/execution version changed; prepare an explicitly new focus operation'
  );
}
function validateAuthority(handle: ProjectDatabase, scopeJson: string): void {
  assertProjectDatabasePath(handle);
  const scope = JSON.parse(scopeJson) as ProjectFocusScope;
  if (
    scope.rootKey !== handle.authority.rootKey ||
    scope.projectId !== handle.authority.projectId ||
    scope.storeInstanceId !== handle.authority.storeInstanceId ||
    scope.repositoryInstanceId !== handle.authority.repositoryInstanceId
  )
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Select the validated project store and repository instance that own this focus namespace'
    );
}

interface SelectedFocus extends ProjectFocusSelection {
  cleared: number;
}
function assertFocusReceipts(view: ProjectReadView, scopeJson: string): void {
  const scopeHash = digest(scopeJson);
  if (
    view.get(
      `SELECT o.operation_id FROM operations o
       LEFT JOIN execution_focus_records r ON r.operation_id=o.operation_id AND r.scope_json=?
       WHERE o.operation_kind='execution.focus' AND json_extract(o.target_json,'$.scopeHash')=?
         AND r.operation_id IS NULL LIMIT 1`,
      scopeJson,
      scopeHash
    ) ||
    view.get(
      `SELECT r.operation_id FROM execution_focus_records r
       LEFT JOIN operations o ON o.operation_id=r.operation_id AND o.operation_kind='execution.focus'
         AND json_extract(o.target_json,'$.scopeHash')=?
       WHERE r.scope_json=? AND o.operation_id IS NULL LIMIT 1`,
      scopeHash,
      scopeJson
    )
  )
    invalid('Original focus history or its scoped publication receipt is missing');
}
function currentFocus(view: ProjectReadView, scopeJson: string): SelectedFocus | null {
  assertFocusReceipts(view, scopeJson);
  const current = view.get<
    SelectedFocus & { recordId: string | null; publicationId: string | null }
  >(
    `SELECT c.operation_id AS operationId, c.version, r.operation_id AS recordId,
      o.operation_id AS publicationId, r.pin_bytes IS NULL AS cleared
     FROM execution_focus_current c
     LEFT JOIN execution_focus_records r ON r.scope_json = c.scope_json AND r.operation_id = c.operation_id
     LEFT JOIN operations o ON o.operation_id = r.operation_id
     WHERE c.scope_json = ?`,
    scopeJson
  );
  if (!current) {
    if (
      view.get(
        'SELECT operation_id FROM execution_focus_records WHERE scope_json = ? LIMIT 1',
        scopeJson
      )
    )
      invalid('The current focus selection is missing despite retained publications');
    return null;
  }
  if (
    !isUuidV7(current.operationId) ||
    !Number.isSafeInteger(current.version) ||
    current.version < 1 ||
    current.recordId !== current.operationId ||
    current.publicationId !== current.operationId ||
    (current.cleared !== 0 && current.cleared !== 1)
  )
    invalid('The selected focus record or original publication is missing or inconsistent');
  return {
    operationId: current.operationId,
    version: current.version,
    cleared: current.cleared,
  };
}

export function prepareProjectFocusRead(handle: ProjectDatabase, scope: ProjectFocusScope): string {
  const scopeJson = projectFocusScopeJson(scope);
  validateAuthority(handle, scopeJson);
  return scopeJson;
}

export function selectProjectExecutionFocus(view: ProjectReadView, scopeJson: string) {
  const selected = currentFocus(view, scopeJson);
  if (!selected) return null;
  const record = view.get<{ pinBytes: string; pinHash: string | null }>(
    `SELECT hex(pin_bytes) AS pinBytes, pin_hash AS pinHash
       FROM execution_focus_records WHERE scope_json = ? AND operation_id = ?`,
    scopeJson,
    selected.operationId
  );
  if (!record) invalid('The selected focus record is missing');
  return { selected, record };
}

export function hydrateProjectExecutionFocus(
  scopeJson: string,
  snapshot: { value: ReturnType<typeof selectProjectExecutionFocus>; counters: ProjectCounters }
): ProjectExecutionFocusSnapshot {
  if (!snapshot.value) return { status: 'absent', selection: null, counters: snapshot.counters };
  const { selected, record } = snapshot.value;
  const selection = { operationId: selected.operationId, version: selected.version };
  if (selected.cleared) {
    if (record.pinHash !== null) invalid('The selected clear record is inconsistent');
    return { status: 'cleared', selection, counters: snapshot.counters };
  }
  if (typeof record.pinHash !== 'string' || typeof record.pinBytes !== 'string')
    invalid('The selected pin bytes or checksum are missing');
  const pinBytes = Buffer.from(record.pinBytes, 'hex');
  return {
    status: 'present',
    selection,
    pin: decodeRetainedFocusPin(scopeJson, pinBytes, record.pinHash),
    pinBytes,
    pinHash: record.pinHash,
    counters: snapshot.counters,
  };
}

export function readProjectExecutionFocus(
  handle: ProjectDatabase,
  scope: ProjectFocusScope
): ProjectExecutionFocusSnapshot {
  const scopeJson = prepareProjectFocusRead(handle, scope);
  return hydrateProjectExecutionFocus(
    scopeJson,
    handle.read((view) => selectProjectExecutionFocus(view, scopeJson))
  );
}

function validateTarget(
  view: ProjectReadView,
  prepared: Extract<PreparedProjectFocus, { action: 'set' }>
): void {
  const target = prepared.target;
  const revision = view.get<ArtifactRevision>(
    `SELECT r.generation, r.ordered_hash AS orderedHash, r.event_count AS eventCount,
       r.byte_length AS byteLength, r.tail_event_id AS tailEventId
     FROM artifacts a JOIN artifact_revisions r
       ON r.artifact_id = a.artifact_id AND r.generation = a.current_generation
     WHERE a.artifact_id = ?`,
    target.artifactId
  );
  if (!revision) {
    if (view.get('SELECT artifact_id FROM artifacts WHERE artifact_id = ?', target.artifactId))
      invalid('The intended artifact current revision is missing');
    stale();
  }
  const execution = view.get<{
    version: number;
    bindingGeneration: number;
    transitionId: string;
  }>(
    `SELECT c.version, c.binding_generation AS bindingGeneration, t.operation_id AS transitionId
     FROM execution_current c
     JOIN execution_initializations i ON i.artifact_id = c.artifact_id
     JOIN execution_transitions t ON t.artifact_id = c.artifact_id
       AND t.operation_id = c.transition_operation_id AND t.generation = c.binding_generation
     WHERE c.artifact_id = ?`,
    target.artifactId
  );
  if (!execution)
    invalid('The intended artifact execution selection or retained transition is missing');
  if (
    !Number.isSafeInteger(execution.version) ||
    execution.version < 1 ||
    !Number.isSafeInteger(execution.bindingGeneration) ||
    execution.bindingGeneration < 0 ||
    !isUuidV7(execution.transitionId)
  )
    invalid('The intended artifact execution identity is invalid');
  if (
    revision.generation !== target.revision.generation ||
    revision.orderedHash !== target.revision.orderedHash ||
    revision.eventCount !== target.revision.eventCount ||
    revision.byteLength !== target.revision.byteLength ||
    revision.tailEventId !== target.revision.tailEventId ||
    execution.version !== target.executionVersion ||
    execution.bindingGeneration !== target.bindingGeneration
  )
    stale();
  if (
    view.get(
      'SELECT operation_id FROM execution_transitions WHERE artifact_id = ? AND operation_id = ?',
      target.artifactId,
      prepared.operationId
    )
  )
    throw new ProjectDatabaseError(
      'IDEMPOTENCY_CONFLICT',
      'A binding transition already owns this identity; retain a separate focus operation ID for retries'
    );
}

export async function publishProjectExecutionFocus(
  handle: ProjectDatabase,
  input: ProjectFocusChange,
  options: ProjectOperationOptions = {}
): Promise<ProjectOperationResult<ProjectFocusPublication>> {
  const prepared = prepareProjectFocus(input);
  const copiedOptions = { signal: options.signal, onWait: options.onWait };
  validateAuthority(handle, prepared.scopeJson);
  handle.read((view) => {
    currentFocus(view, prepared.scopeJson);
    return null;
  });
  readProjectExecutionFocusOperation(handle, prepared.operationId);
  const bytes =
    prepared.pinBytesBase64 === null ? null : Buffer.from(prepared.pinBytesBase64, 'base64');
  return runProjectOperation(
    handle,
    {
      operationId: prepared.operationId,
      kind: 'execution.focus',
      target: { scopeHash: prepared.scopeHash },
      payload: { action: prepared.action, pinHash: prepared.pinHash },
      expectedState: {
        selection: prepared.expectedSelection === null ? null : { ...prepared.expectedSelection },
        target:
          prepared.target === null
            ? null
            : {
                artifactId: prepared.target.artifactId,
                revision: { ...prepared.target.revision },
                executionVersion: prepared.target.executionVersion,
                bindingGeneration: prepared.target.bindingGeneration,
              },
      },
      intentChange: false,
    },
    (transaction) => {
      const current = currentFocus(transaction, prepared.scopeJson);
      const expected = prepared.expectedSelection;
      if (
        (current === null) !== (expected === null) ||
        (current &&
          expected &&
          (current.operationId !== expected.operationId || current.version !== expected.version))
      )
        stale();
      if (prepared.action === 'set') validateTarget(transaction, prepared);
      const version = (current?.version ?? 0) + 1;
      if (!Number.isSafeInteger(version)) invalid('Focus selection version capacity is exhausted');
      transaction.run(
        'INSERT INTO execution_focus_records VALUES (?, ?, ?, ?)',
        prepared.operationId,
        prepared.scopeJson,
        bytes,
        prepared.pinHash
      );
      if (current) {
        const result = transaction.run(
          `UPDATE execution_focus_current SET operation_id = ?, version = ?
           WHERE scope_json = ? AND operation_id = ? AND version = ?`,
          prepared.operationId,
          version,
          prepared.scopeJson,
          current.operationId,
          current.version
        );
        if (result.changes !== 1) stale();
      } else {
        transaction.run(
          'INSERT INTO execution_focus_current VALUES (?, ?, ?)',
          prepared.scopeJson,
          prepared.operationId,
          version
        );
      }
      return {
        status: prepared.action === 'clear' ? 'cleared' : 'present',
        selection: { operationId: prepared.operationId, version },
      };
    },
    copiedOptions
  );
}
