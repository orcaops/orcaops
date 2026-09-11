import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertProjectDatabasePath,
  claimProjectConnection,
  createReadView,
  type ProjectCounters,
  type ProjectDatabase,
  type ProjectReadView,
  readProjectCounters,
  rollbackProjectConnection,
  validateProjectIdentity,
} from './connection.js';
import {
  isDatabaseContention,
  isRetryableTransactionFailure,
  ProjectDatabaseError,
  sqliteCode,
} from './errors.js';
import { assertCheckoutChildOperation } from './execution-checkout-identity.js';
import { type DatabaseJson, serializeDatabaseValue } from './values.js';
import { isUuidV7 } from '../../ids/uuidv7.js';

export interface ProjectOperation {
  readonly operationId: string;
  readonly kind: string;
  readonly target: DatabaseJson;
  readonly payload: DatabaseJson;
  readonly expectedState: DatabaseJson;
  readonly intentChange: boolean;
}

export interface ProjectSettlement extends ProjectReadView {
  run(sql: string, ...parameters: unknown[]): { changes: number };
}

export interface ProjectWait {
  operation: string;
  reason: 'admission' | 'transaction-retry';
  attempt: number;
}

export interface ProjectOperationOptions {
  signal?: AbortSignal;
  onWait?: (wait: ProjectWait) => void;
}

export interface ProjectOperationResult<T> {
  value: T;
  replayed: boolean;
  counters: ProjectCounters;
}

interface CommittedOperation {
  operation_kind: string;
  intent_change: number;
  target_json: string;
  payload_json: string;
  payload_hash: string;
  expected_state_json: string;
  result_json: string;
  committed_write_sequence: number;
  committed_intent_counter: number;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Operation cancelled before commit; retry the original operation ID if still wanted'
    );
  }
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) cancelled(signal);
    throw error;
  }
  cancelled(signal);
}

function freezeJson(value: DatabaseJson): DatabaseJson {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export async function runProjectOperation<T extends DatabaseJson>(
  handle: ProjectDatabase,
  operation: ProjectOperation,
  settle: (transaction: ProjectSettlement, prepared: Readonly<ProjectOperation>) => T,
  options: ProjectOperationOptions = {}
): Promise<ProjectOperationResult<T>> {
  const operationId = operation.operationId;
  const kind = operation.kind;
  const intentChange = operation.intentChange;
  if (
    !isUuidV7(operationId) ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(kind) ||
    typeof intentChange !== 'boolean'
  ) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide an original operation UUID, a bounded operation kind and explicit intent classification'
    );
  }
  const targetJson = serializeDatabaseValue(operation.target);
  const payloadJson = serializeDatabaseValue(operation.payload);
  const expectedStateJson = serializeDatabaseValue(operation.expectedState);
  const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
  const prepared = Object.freeze({
    operationId,
    kind,
    intentChange,
    target: freezeJson(JSON.parse(targetJson) as DatabaseJson),
    payload: freezeJson(JSON.parse(payloadJson) as DatabaseJson),
    expectedState: freezeJson(JSON.parse(expectedStateJson) as DatabaseJson),
  });
  const signal = options.signal;
  const observer = options.onWait;
  cancelled(signal);
  const state = claimProjectConnection(handle);
  const database = state.database;
  let wroteWait = false;
  const waiting = (reason: ProjectWait['reason'], attempt: number) => {
    if (observer) observer({ operation: kind, reason, attempt });
    else if (process.stderr.isTTY) {
      const frame = ['|', '/', '-', String.fromCharCode(92)][attempt % 4];
      process.stderr.write(`\r${frame} Waiting for ${kind}; Ctrl-C to cancel. `);
      wroteWait = true;
    } else if (!wroteWait) {
      process.stderr.write(`Waiting for ${kind}; Ctrl-C to cancel.\n`);
      wroteWait = true;
    }
  };
  try {
    for (let transactionAttempt = 0; transactionAttempt < 3; transactionAttempt++) {
      for (let admissionAttempt = 0; ; admissionAttempt++) {
        cancelled(signal);
        assertProjectDatabasePath(handle);
        try {
          database.exec('BEGIN IMMEDIATE');
          break;
        } catch (error) {
          if (database.inTransaction || !isDatabaseContention(error)) throw error;
          waiting('admission', admissionAttempt + 1);
          await pause(25, signal);
        }
      }
      let active = true;
      try {
        cancelled(signal);
        validateProjectIdentity(database, handle.authority);
        const existing = database
          .prepare('SELECT * FROM operations WHERE operation_id = ?')
          .get(operationId) as CommittedOperation | undefined;
        if (existing) {
          if (
            existing.operation_kind !== kind ||
            existing.intent_change !== Number(intentChange) ||
            existing.target_json !== targetJson ||
            existing.payload_json !== payloadJson ||
            existing.payload_hash !== payloadHash ||
            existing.expected_state_json !== expectedStateJson
          ) {
            throw new ProjectDatabaseError(
              'IDEMPOTENCY_CONFLICT',
              'This operation ID already identifies different content or context; use an explicitly new operation'
            );
          }
          const value = JSON.parse(existing.result_json) as T;
          const counters = {
            writeSequence: existing.committed_write_sequence,
            intentChangeCounter: existing.committed_intent_counter,
          };
          if (
            !Number.isSafeInteger(counters.writeSequence) ||
            !Number.isSafeInteger(counters.intentChangeCounter)
          ) {
            throw new ProjectDatabaseError(
              'HISTORY_INTEGRITY_REQUIRED',
              'The original operation counters are invalid; explicit repair is required'
            );
          }
          assertProjectDatabasePath(handle);
          database.exec('COMMIT');
          return { value, counters, replayed: true };
        }
        if (
          database
            .prepare(
              "SELECT transition_id FROM git_retention_transitions WHERE command_operation_id = ? AND kind = 'selected'"
            )
            .get(operationId)
        ) {
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'The retained Git selection is missing its original operation receipt; preserve history and use explicit repair'
          );
        }
        const read = createReadView(database, () => active && database.inTransaction);
        const transaction: ProjectSettlement = Object.freeze({
          ...read,
          run(sql: string, ...parameters: unknown[]) {
            if (!active || !database.inTransaction)
              throw new ProjectDatabaseError(
                'INVALID_INPUT',
                'The settlement transaction ended; start a new operation'
              );
            if (
              !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) ||
              /\b(store_identity|activation|repository_creation|project_counters|operations)\b/i.test(
                sql
              )
            ) {
              throw new ProjectDatabaseError(
                'INVALID_INPUT',
                'Settlement writes must target domain rows; connection, schema, counters and operation results belong to storage'
              );
            }
            return { changes: database.prepare(sql).run(...parameters).changes };
          },
        });
        assertCheckoutChildOperation(read, prepared);
        const resultJson = serializeDatabaseValue(settle(transaction, prepared));
        // A pending publication already owns its terminal ID before its receipt exists.
        if (
          database
            .prepare(
              `
            SELECT o.original_operation_id FROM git_retention_operations o
            WHERE o.original_operation_id = ? AND NOT EXISTS (
              SELECT 1 FROM git_retention_current c
              JOIN git_retention_transitions t ON t.transition_id = c.transition_id
                AND t.original_operation_id = c.original_operation_id
              WHERE c.original_operation_id = o.original_operation_id
                AND t.kind = 'selected' AND t.command_operation_id = o.original_operation_id
            )
          `
            )
            .get(operationId)
        ) {
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'This operation ID belongs to a retained Git publication; resume its original request or use an explicitly new operation ID'
          );
        }
        if (
          database
            .prepare(
              `SELECT p.push_id FROM artifact_push_requests p
          WHERE p.terminal_operation_id=? AND NOT EXISTS (
            SELECT 1 FROM artifact_push_terminals t WHERE t.push_id=p.push_id
              AND t.operation_id=p.terminal_operation_id AND ?='artifact.push.complete'
          )`
            )
            .get(operationId, kind)
        )
          throw new ProjectDatabaseError(
            'IDEMPOTENCY_CONFLICT',
            'This operation ID belongs to a retained artifact push; resume its original request or use an explicitly new operation ID'
          );
        cancelled(signal);
        const before = readProjectCounters(database);
        if (
          before.writeSequence === Number.MAX_SAFE_INTEGER ||
          (intentChange && before.intentChangeCounter === Number.MAX_SAFE_INTEGER)
        ) {
          throw new ProjectDatabaseError(
            'HISTORY_INTEGRITY_REQUIRED',
            'Project counter capacity is exhausted; explicit schema repair is required before more writes'
          );
        }
        const counters = {
          writeSequence: before.writeSequence + 1,
          intentChangeCounter: before.intentChangeCounter + Number(intentChange),
        };
        database
          .prepare(
            'UPDATE project_counters SET write_sequence = ?, intent_change_counter = ? WHERE singleton = 1'
          )
          .run(counters.writeSequence, counters.intentChangeCounter);
        database
          .prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            operationId,
            kind,
            Number(intentChange),
            targetJson,
            payloadJson,
            payloadHash,
            expectedStateJson,
            resultJson,
            counters.writeSequence,
            counters.intentChangeCounter
          );
        assertProjectDatabasePath(handle);
        database.exec('COMMIT');
        return { value: JSON.parse(resultJson) as T, counters, replayed: false };
      } catch (error) {
        active = false;
        rollbackProjectConnection(state, error);
        if (error instanceof ProjectDatabaseError) throw error;
        if (!isRetryableTransactionFailure(error)) {
          throw new ProjectDatabaseError(
            'TRANSACTION_FAILED',
            `Database transaction failed (${sqliteCode(error) ?? 'application error'}); correct input or repair storage before retrying the original operation`,
            { cause: error }
          );
        }
        if (transactionAttempt === 2) {
          throw new ProjectDatabaseError(
            'TRANSACTION_RETRY_EXHAUSTED',
            'Database retries exhausted; retry the same operation ID after contention is resolved',
            { cause: error }
          );
        }
        waiting('transaction-retry', transactionAttempt + 1);
        await pause(transactionAttempt === 0 ? 25 : 100, signal);
      } finally {
        active = false;
      }
    }
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'No transaction result was produced; inspect storage before retrying'
    );
  } catch (error) {
    rollbackProjectConnection(state, error);
    if (error instanceof ProjectDatabaseError) throw error;
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      `Database admission failed (${sqliteCode(error) ?? 'application error'}); correct input or repair storage before retrying the original operation`,
      { cause: error }
    );
  } finally {
    state.busy = false;
    if (wroteWait && process.stderr.isTTY) {
      try {
        process.stderr.write('\n');
      } catch {
        /* A failed progress stream cannot replace a committed result. */
      }
    }
  }
}
