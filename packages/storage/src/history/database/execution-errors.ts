import { ZodError } from 'zod';

import { HistoryPersistenceError } from '../persistence-error.js';
import { ProjectDatabaseError } from './errors.js';

export const executionRecoveryActions = {
  IDENTITY_RECOVERY_REQUIRED:
    'Restore the registered repository and worktree identities before retrying execution.',
  EXECUTION_RECOVERY_REQUIRED:
    'Inspect the retained execution and resolve its original open checkpoint recovery explicitly.',
  IDEMPOTENCY_CONFLICT:
    'Keep the original operation content unchanged or choose an explicitly new operation identity.',
  STALE_BINDING_GENERATION:
    'Read the current binding and prepare an explicitly new operation against the intended owner.',
  EXECUTION_OWNER_CHANGED:
    'Inspect the current owner; explicitly choose handoff or prepare a new operation for that owner.',
  ARTIFACT_COMPLETED:
    'Select active work; completed history cannot be implicitly reopened for execution.',
  IMPORTED_READ_ONLY:
    'Select authored active work; imported history cannot acquire an execution owner.',
  INVALID_INPUT: 'Correct the execution request before attempting a new operation.',
  ALREADY_BOUND:
    'Use the existing binding or request an explicit handoff instead of first binding.',
  EXECUTION_UNBOUND:
    'Explicitly bind the artifact to a registered worktree before a task mutation.',
  IDENTITY_CONFLICT:
    'Use the artifact repository instance; execution cannot move between unrelated repositories.',
  INVALID_HANDOFF:
    'Request an explicit handoff to change worktrees; a context update cannot change ownership.',
  EXECUTION_UNCHANGED: 'Keep the existing execution context; no context transition is needed.',
  ALREADY_BOUND_HERE:
    'Keep the existing worktree binding or select a different explicit handoff target.',
  OPEN_CHECKPOINTS: 'Close the original open checkpoints before ordinary handoff or completion.',
  RECOVERY_REASON_REQUIRED: 'Supply the reason for explicit checkpoint or orphan recovery.',
  EXPLICIT_ARTIFACT_REQUIRED:
    'Select the exact artifact explicitly for historical mutation or recovery.',
  ARTIFACT_NOT_COMPLETED:
    'Use ordinary task capture for active work; summary amendment requires completed history.',
  TASK_ELIGIBILITY_REQUIRED: 'Use the current execution owner for active authored work.',
  EXECUTION_BOUND_ELSEWHERE: 'Continue in the owning worktree or request an explicit handoff.',
  EXECUTION_CONTEXT_CHANGED:
    'Validate the changed Git context through an explicit checkout transition.',
  CHECKPOINT_RECOVERY_UNAVAILABLE:
    'Select an original checkpoint belonging to the current recovery operation.',
  CHECKPOINT_ABANDONED:
    'Preserve the abandoned checkpoint; continuation requires a new checkpoint.',
} as const;
export type ProjectExecutionErrorCode = keyof typeof executionRecoveryActions;

export function translateExecutionFailure(cause: unknown): ProjectDatabaseError {
  if (cause instanceof ProjectDatabaseError) return cause;
  if (
    cause instanceof HistoryPersistenceError &&
    Object.hasOwn(executionRecoveryActions, cause.code)
  ) {
    const code = cause.code as ProjectExecutionErrorCode;
    return new ProjectDatabaseError(code, executionRecoveryActions[code], { cause });
  }
  if (cause instanceof ZodError)
    return new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide valid execution identities and context before a new operation.',
      { cause }
    );
  return new ProjectDatabaseError(
    'TRANSACTION_FAILED',
    'Execution preparation failed; preserve the original operation and inspect the diagnostic cause before retrying.',
    { cause }
  );
}
