import {
  assertProjectDatabasePath,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { isUuidV7 } from '../../ids/uuidv7.js';

export interface ProjectInitialization {
  readonly authority: Readonly<ProjectDatabaseAuthority>;
  readonly initializationOperationId: string;
  readonly initializedAt: string;
  readonly state: 'active';
}

export function readProjectInitialization(handle: ProjectDatabase): ProjectInitialization {
  assertProjectDatabasePath(handle);
  return handle.read((view) => {
    const row = view.get<{ initialization_operation_id: string; initialized_at: string }>(
      `SELECT i.initialization_operation_id, a.initialized_at
       FROM store_identity i JOIN activation a ON a.store_identity_id = i.singleton
       WHERE i.singleton = 1 AND a.state = 'active'`
    );
    if (
      !row ||
      !isUuidV7(row.initialization_operation_id) ||
      !Number.isFinite(Date.parse(row.initialized_at))
    ) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Committed initialization metadata is invalid; preserve history for explicit repair'
      );
    }
    return {
      authority: { ...handle.authority },
      initializationOperationId: row.initialization_operation_id,
      initializedAt: row.initialized_at,
      state: 'active' as const,
    };
  }).value;
}
