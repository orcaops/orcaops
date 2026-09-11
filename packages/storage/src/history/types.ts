export interface HistoryRoot {
  resolvedRoot: string;
  rootKey: string;
}

export interface HistoryAuthority extends HistoryRoot {
  projectId: string;
  storeInstanceId: string;
  formatVersion: 1;
}

export interface GitAdministrativeContext {
  commonDir: string;
  gitDir: string;
  worktreeRoot: string;
  repositoryInstanceId: string | null;
  worktreeId: string | null;
  headOid: string | null;
  branch: string | null;
}

export type HistoryErrorCode =
  | 'AUTHORITY_MISMATCH'
  | 'PROJECT_IDENTITY_UNAVAILABLE'
  | 'ACTIVATION_PENDING'
  | 'HISTORY_MISSING'
  | 'HISTORY_INACCESSIBLE'
  | 'HISTORY_UNWRITABLE'
  | 'HISTORY_UNEXPECTED_OWNER'
  | 'HISTORY_FORMAT_UNSUPPORTED'
  | 'HISTORY_INTEGRITY_REQUIRED'
  | 'IDENTITY_RECOVERY_REQUIRED'
  | 'CONVERSION_REQUIRED'
  | 'IDENTITY_CONFLICT'
  | 'CONFLICT'
  | 'OPERATION_PENDING';

export class HistoryError extends Error {
  constructor(
    public readonly code: HistoryErrorCode,
    message: string,
    public readonly context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'HistoryError';
  }
}
