import { type ProjectDatabase, ProjectDatabaseError } from '@orcaops/storage/history/database';

import { databaseSetupError } from './errors.js';

export function closeSetupDatabase(handle: ProjectDatabase, primary?: unknown): void {
  try {
    handle.close();
  } catch (cause) {
    if (primary !== undefined) {
      const original = databaseSetupError(primary);
      throw new ProjectDatabaseError(original.code, original.message, {
        cause: new AggregateError([original, cause], 'Setup read and connection close failed'),
      });
    }
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'Setup reader could not close cleanly; inspect storage access before retrying without replacing history',
      { cause }
    );
  }
}
