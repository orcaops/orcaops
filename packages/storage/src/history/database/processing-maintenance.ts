// Scheduling writes are maintenance data. A lease, a claim, a heartbeat, a budget reservation and
// a settlement publish no authored record, so each runs here instead of through the operation
// funnel: its own short BEGIN IMMEDIATE with no operation receipt and no movement of the write
// sequence or the intent counter. Processing can therefore never invalidate the rendered views it
// reads, and a worker's own bookkeeping never reads as a change of intent.
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertProjectDatabasePath,
  claimProjectConnection,
  createReadView,
  type ProjectDatabase,
  type ProjectReadView,
  rollbackProjectConnection,
  validateProjectIdentity,
} from './connection.js';
import {
  isDatabaseContention,
  isRetryableTransactionFailure,
  ProjectDatabaseError,
  sqliteCode,
} from './errors.js';
import type { ProjectOperationOptions, ProjectWait } from './transactions.js';
import { isUuidV7 } from '../../ids/uuidv7.js';

export interface ProcessingMaintenance extends ProjectReadView {
  run(sql: string, ...parameters: unknown[]): { changes: number };
}

// A maintenance transaction exists to move scheduling state and nothing else, so it accepts no
// other target. Deletion is left out: every scheduling table retains its rows.
const SCHEDULING_WRITE =
  /^\s*(?:INSERT\s+INTO|UPDATE)\s+processing_(?:jobs|attempts|lease|usage|control|model_confirmations|job_reopenings)\b/i;

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

function cancelled(name: string, signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      `Background processing ${name} was cancelled before commit; nothing was written`
    );
}

async function pause(name: string, milliseconds: number, signal?: AbortSignal): Promise<void> {
  cancelled(name, signal);
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (cause) {
    cancelled(name, signal);
    throw cause;
  }
  cancelled(name, signal);
}

/**
 * Run one scheduling write as its own immediate transaction on a writer
 * connection. Nothing here writes an operation receipt or touches the project
 * counters, and the settle callback may only write scheduling rows.
 */
export async function runProcessingMaintenance<T>(
  handle: ProjectDatabase,
  name: string,
  settle: (transaction: ProcessingMaintenance) => T,
  options: ProjectOperationOptions = {}
): Promise<T> {
  if (typeof name !== 'string' || !NAME.test(name))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Name the scheduling write with a bounded maintenance name'
    );
  const signal = options.signal;
  const observer = options.onWait;
  cancelled(name, signal);
  const state = claimProjectConnection(handle);
  const database = state.database;
  let wroteWait = false;
  const waiting = (reason: ProjectWait['reason'], attempt: number) => {
    if (observer) observer({ operation: name, reason, attempt });
    else if (!wroteWait && !process.stderr.isTTY) {
      process.stderr.write(`Waiting for ${name}.\n`);
      wroteWait = true;
    }
  };
  try {
    for (let transactionAttempt = 0; transactionAttempt < 3; transactionAttempt++) {
      for (let admissionAttempt = 0; ; admissionAttempt++) {
        cancelled(name, signal);
        assertProjectDatabasePath(handle);
        try {
          database.exec('BEGIN IMMEDIATE');
          break;
        } catch (cause) {
          if (database.inTransaction || !isDatabaseContention(cause)) throw cause;
          waiting('admission', admissionAttempt + 1);
          await pause(name, 25, signal);
        }
      }
      let active = true;
      try {
        cancelled(name, signal);
        validateProjectIdentity(database, handle.authority);
        const read = createReadView(database, () => active && database.inTransaction);
        const transaction: ProcessingMaintenance = Object.freeze({
          ...read,
          run(sql: string, ...parameters: unknown[]) {
            if (!active || !database.inTransaction)
              throw new ProjectDatabaseError(
                'INVALID_INPUT',
                'The scheduling transaction ended; start a new maintenance write'
              );
            if (!SCHEDULING_WRITE.test(sql))
              throw new ProjectDatabaseError(
                'INVALID_INPUT',
                'A maintenance transaction writes scheduling rows only; authored records belong to an operation'
              );
            return { changes: database.prepare(sql).run(...parameters).changes };
          },
        });
        const value = settle(transaction);
        cancelled(name, signal);
        assertProjectDatabasePath(handle);
        database.exec('COMMIT');
        return value;
      } catch (cause) {
        active = false;
        rollbackProjectConnection(state, cause);
        if (cause instanceof ProjectDatabaseError) throw cause;
        if (!isRetryableTransactionFailure(cause))
          throw new ProjectDatabaseError(
            'TRANSACTION_FAILED',
            `Background processing ${name} failed (${sqliteCode(cause) ?? 'application error'}); correct input or repair storage before retrying`,
            { cause }
          );
        if (transactionAttempt === 2)
          throw new ProjectDatabaseError(
            'TRANSACTION_RETRY_EXHAUSTED',
            `Background processing ${name} retries exhausted; retry after contention is resolved`,
            { cause }
          );
        waiting('transaction-retry', transactionAttempt + 1);
        await pause(name, transactionAttempt === 0 ? 25 : 100, signal);
      } finally {
        active = false;
      }
    }
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      `Background processing ${name} produced no result; inspect storage before retrying`
    );
  } catch (cause) {
    rollbackProjectConnection(state, cause);
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      `Background processing ${name} could not start (${sqliteCode(cause) ?? 'application error'}); correct input or repair storage before retrying`,
      { cause }
    );
  } finally {
    state.busy = false;
  }
}

/**
 * Times reach storage as parameters and are compared as stored text, so every
 * one of them is required in the single canonical UTC spelling. Two spellings
 * of the same instant would order differently in a window or a retry
 * comparison.
 */
export function processingInstant(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      `Provide ${what} as a canonical UTC timestamp such as 2026-09-01T00:00:00.000Z`
    );
  return value;
}

export function processingGeneration(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      `Provide ${what} as the lease generation the write acts under`
    );
  return value as number;
}

export function processingRecordId(value: unknown, what: string): string {
  if (!isUuidV7(value as string))
    throw new ProjectDatabaseError('INVALID_INPUT', `Provide an original ${what} identifier`);
  return value as string;
}

export function processingText(value: unknown, what: string, limit = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit)
    throw new ProjectDatabaseError('INVALID_INPUT', `Provide ${what} as bounded, non-empty text`);
  return value;
}

export function processingBound(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ProjectDatabaseError('INVALID_INPUT', `Provide ${what} as a positive whole number`);
  return value as number;
}

/**
 * Money is stored as REAL but compared against a configured limit, so every
 * comparison is made on whole micro-dollars: `0.1 + 0.2 > 0.3` would otherwise
 * refuse a call that fits its budget exactly.
 */
export function processingMicros(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new ProjectDatabaseError('INVALID_INPUT', `Provide ${what} as a non-negative amount`);
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros))
    throw new ProjectDatabaseError('INVALID_INPUT', `Provide ${what} within the recordable range`);
  return micros;
}
