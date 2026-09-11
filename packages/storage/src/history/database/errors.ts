import { loadDatabase } from './driver.js';
import type { ProjectExecutionErrorCode } from './execution-errors.js';

export type ProjectDatabaseErrorCode =
  | ProjectExecutionErrorCode
  | 'IDENTITY_RECOVERY_REQUIRED'
  | 'IDENTITY_CONFLICT'
  | 'CONVERSION_REQUIRED'
  | 'HISTORY_UNEXPECTED_OWNER'
  | 'HISTORY_UNWRITABLE'
  | 'AUTHORITY_MISMATCH'
  | 'HISTORY_MISSING'
  | 'HISTORY_INACCESSIBLE'
  | 'HISTORY_FORMAT_UNSUPPORTED'
  | 'HISTORY_INTEGRITY_REQUIRED'
  | 'ACTIVATION_PENDING'
  | 'SECRET_IN_PAYLOAD'
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_CONTEXT'
  | 'CANCELLED'
  | 'TRANSACTION_RETRY_EXHAUSTED'
  | 'TRANSACTION_FAILED';

export class ProjectDatabaseError extends Error {
  readonly reason: ProjectDatabaseFailureReason | undefined;

  constructor(
    readonly code: ProjectDatabaseErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ProjectDatabaseError';
    const primary =
      options?.cause instanceof AggregateError ? options.cause.errors[0] : options?.cause;
    this.reason =
      primary instanceof ProjectDatabaseError ? primary.reason : sqliteFailureReason(primary);
  }
}

export function sqliteCode(error: unknown): string | undefined {
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !error.code.startsWith('SQLITE_')
  )
    return undefined;
  const { SqliteError } = loadDatabase();
  return error instanceof SqliteError ? error.code : undefined;
}

const contentionCodes = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_LOCKED_VTAB',
]);

export function isDatabaseContention(error: unknown): boolean {
  const code = sqliteCode(error);
  return code !== undefined && contentionCodes.has(code);
}

function sqliteFailureReason(error: unknown): ProjectDatabaseFailureReason | undefined {
  if (isDatabaseContention(error)) return 'contention';
  switch (sqliteCode(error)?.split('_')[1]) {
    case 'READONLY':
      return 'read-only';
    case 'FULL':
      return 'disk-full';
    case 'CORRUPT':
    case 'NOTADB':
      return 'integrity';
    case 'CONSTRAINT':
      return 'constraint';
    case 'ERROR':
      return 'invalid-sql';
    case 'IOERR':
      return 'io';
    default:
      return undefined;
  }
}

export function isRetryableTransactionFailure(error: unknown): boolean {
  return isDatabaseContention(error);
}

export type ProjectDatabaseFailureReason =
  | 'contention'
  | 'read-only'
  | 'disk-full'
  | 'integrity'
  | 'constraint'
  | 'invalid-sql'
  | 'io';
