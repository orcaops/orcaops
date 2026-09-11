import type Database from 'better-sqlite3';

import { matchesAnyGlob } from '@orcaops/evaluator-protocol';

import { ProjectDatabaseError } from './errors.js';

export function registerQueryFunctions(database: Database.Database): void {
  database.function('orcaops_history_time', { deterministic: true }, (value) => {
    if (value === null) return null;
    if (typeof value !== 'string')
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'History timestamp metadata is invalid; explicitly rebuild from original records'
      );
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  });
  database.function('orcaops_history_touching', { deterministic: true }, (file, pattern) => {
    if (typeof file !== 'string' || typeof pattern !== 'string')
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'History path metadata is invalid; explicitly rebuild from original records'
      );
    return matchesAnyGlob(file.replace(/^\.\//, ''), [pattern]) ? 1 : 0;
  });
}
