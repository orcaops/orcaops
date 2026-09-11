import { HistoryError } from '@orcaops/storage/history/authority';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

export function databaseSetupError(cause: unknown): ProjectDatabaseError {
  if (cause instanceof ProjectDatabaseError) return cause;
  if (cause instanceof HistoryError) {
    switch (cause.code) {
      case 'AUTHORITY_MISMATCH':
      case 'HISTORY_MISSING':
      case 'HISTORY_INACCESSIBLE':
      case 'HISTORY_UNWRITABLE':
      case 'HISTORY_UNEXPECTED_OWNER':
      case 'HISTORY_FORMAT_UNSUPPORTED':
      case 'HISTORY_INTEGRITY_REQUIRED':
      case 'IDENTITY_RECOVERY_REQUIRED':
      case 'CONVERSION_REQUIRED':
      case 'IDENTITY_CONFLICT':
      case 'ACTIVATION_PENDING':
        return new ProjectDatabaseError(cause.code, cause.message, { cause });
    }
  }
  return new ProjectDatabaseError(
    'HISTORY_INACCESSIBLE',
    'Setup state could not be inspected; check repository and storage access before retrying, preserving all existing history',
    { cause }
  );
}
