import { z } from 'zod';

import { assertNoSecretsInPayload, canonicalJson, SecretInPayloadError } from '@orcaops/storage';
import { HistoryError } from '@orcaops/storage/history/authority';
import {
  type DatabaseJson,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectOperation,
  type ProjectOperationOptions,
  type ProjectOperationResult,
  type ProjectSettlement,
  runProjectOperation,
} from '@orcaops/storage/history/database';

export const revisionId = z.uuidv7();
export const text = z.string().min(1);
export const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const authoritySchema = z.strictObject({
  resolvedRoot: text,
  rootKey: text,
  projectId: revisionId,
  storeInstanceId: revisionId,
  repositoryInstanceId: revisionId,
});
export const operationFields = {
  authority: authoritySchema,
  operationId: revisionId,
  secretAllow: z.array(z.string()),
};
export function invalid(message: string): never {
  throw new ProjectDatabaseError('INVALID_INPUT', message);
}
export function stale(message: string): never {
  throw new ProjectDatabaseError('STALE_CONTEXT', message);
}
export function integrity(message: string): never {
  throw new ProjectDatabaseError('HISTORY_INTEGRITY_REQUIRED', message);
}
export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalid('Provide a complete, valid review request before a new attempt');
  return result.data;
}
export function scanMetadata(value: unknown, allow: readonly string[]): void {
  try {
    assertNoSecretsInPayload(value, allow);
  } catch (cause) {
    if (!(cause instanceof SecretInPayloadError)) throw cause;
    throw new ProjectDatabaseError(
      'SECRET_IN_PAYLOAD',
      'Remove or redescribe refused review content before a new attempt',
      { cause }
    );
  }
}
export function json(value: unknown): DatabaseJson {
  return JSON.parse(canonicalJson(value)) as DatabaseJson;
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Review operation cancelled; retain its original identity for retry'
    );
}

function closeReviewDatabase(
  database: ProjectDatabase,
  primary: unknown,
  knownCommitted: boolean
): void {
  try {
    database.close();
  } catch (cause) {
    if (knownCommitted) return;
    if (primary instanceof ProjectDatabaseError)
      throw new ProjectDatabaseError(primary.code, primary.message, {
        cause: new AggregateError([primary, cause], 'Review operation and connection close failed'),
      });
    if (primary instanceof HistoryError)
      throw new HistoryError(primary.code, primary.message, {
        ...primary.context,
        cause: new AggregateError([primary, cause], 'Review operation and connection close failed'),
      });
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'Review connection could not close; inspect storage before retrying',
      {
        cause: primary === undefined ? cause : new AggregateError([primary, cause]),
      }
    );
  }
}
export async function withReviewDatabase<T>(
  authority: ProjectDatabaseAuthority,
  mode: 'reader' | 'writer',
  use: (database: ProjectDatabase) => Promise<T> | T,
  committed: (result: T) => boolean = () => false
): Promise<T> {
  const database = await openProjectDatabase({ authority, mode });
  let primary: unknown;
  let knownCommitted = false;
  try {
    const result = await use(database);
    knownCommitted = committed(result);
    return result;
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    closeReviewDatabase(database, primary, knownCommitted);
  }
}

export async function performReviewOperation<T extends DatabaseJson>(
  input: {
    authority: ProjectDatabaseAuthority;
    operation: ProjectOperation;
    settle: (transaction: ProjectSettlement) => T;
    prepareEvidence?: (database: ProjectDatabase) => Promise<void>;
    prepareReadOnly?: (database: ProjectDatabase) => Promise<void>;
  },
  options: ProjectOperationOptions
): Promise<ProjectOperationResult<T>> {
  options = { signal: options.signal, onWait: options.onWait };
  cancelled(options.signal);
  if (input.prepareReadOnly) {
    await withReviewDatabase(input.authority, 'reader', async (database) => {
      const exists = database.read((view) =>
        view.get(
          'SELECT operation_id FROM operations WHERE operation_id = ?',
          input.operation.operationId
        )
      ).value;
      if (!exists) await input.prepareReadOnly!(database);
    });
    cancelled(options.signal);
  }
  return withReviewDatabase(
    input.authority,
    'writer',
    async (database) => {
      const exists = database.read((view) =>
        view.get<{ operation_id: string }>(
          'SELECT operation_id FROM operations WHERE operation_id = ?',
          input.operation.operationId
        )
      ).value;
      // The transaction engine validates exact receipt content before invoking settlement.
      if (exists)
        return runProjectOperation<T>(
          database,
          input.operation,
          () => {
            integrity(
              'A retained review operation receipt vanished; preserve history for explicit repair'
            );
          },
          options
        );
      await input.prepareEvidence?.(database);
      cancelled(options.signal);
      return runProjectOperation(database, input.operation, input.settle, options);
    },
    () => true
  );
}
