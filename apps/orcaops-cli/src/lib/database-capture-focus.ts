import type { RegisteredDatabaseContext } from '@orcaops/core/history/database-capture';
import { canonicalJson, uuidv7 } from '@orcaops/storage';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  type ProjectOperationOptions,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';
import {
  type ProjectFocusScope,
  publishProjectExecutionFocus,
  readProjectExecutionFocus,
} from '@orcaops/storage/history/database/execution-checkout';
import { createExecutionPin, type ShellKey } from '@orcaops/storage/history/execution-focus';

import { captureFailure } from './canonical-capture-outcome.js';

export interface DatabaseCaptureFocusInput {
  registered: RegisteredDatabaseContext;
  shellKey: ShellKey;
  artifactId: string;
  secretAllow: readonly string[];
}
export type DatabaseCaptureFocusOutcome =
  | { state: 'not_requested' }
  /** A replayed capture reads its receipt; it never restamps focus. */
  | { state: 'skipped'; reason: 'replay' }
  | {
      state: 'updated';
      operation_id: string;
      read_only: boolean;
      displaced_artifact_id: string | null;
    }
  | { state: 'cleared'; operation_id: string }
  | { state: 'failed'; error: ReturnType<typeof captureFailure> };

function focusScope(input: DatabaseCaptureFocusInput): ProjectFocusScope | null {
  if (input.shellKey.kind === 'none' || !input.registered.git.worktreeId) return null;
  return {
    rootKey: input.registered.authority.rootKey,
    projectId: input.registered.authority.projectId,
    storeInstanceId: input.registered.authority.storeInstanceId,
    repositoryInstanceId: input.registered.authority.repositoryInstanceId,
    worktreeId: input.registered.git.worktreeId,
    shellKey: input.shellKey,
  };
}

/**
 * Session focus after a capture is a separate publication from the capture itself:
 * it may fail without undoing the committed events, so callers report the failure
 * beside the primary result instead of throwing it.
 */
export async function focusDatabaseCapture(
  handle: ProjectDatabase,
  input: DatabaseCaptureFocusInput,
  options: ProjectOperationOptions = {}
): Promise<DatabaseCaptureFocusOutcome> {
  const scope = focusScope(input);
  if (!scope) return { state: 'not_requested' };
  try {
    const artifact = readProjectArtifact(handle, input.artifactId);
    const execution = readProjectExecution(handle, input.artifactId);
    if (!artifact || !execution)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The captured artifact or its execution history is unavailable for focus; preserve it for explicit repair'
      );
    const selected = readProjectExecutionFocus(handle, scope);
    const pinnedAt = new Date().toISOString();
    const pin = createExecutionPin({
      authority: { ...input.registered.authority, formatVersion: 1 },
      gitContext: input.registered.git,
      shellKey: input.shellKey,
      state: execution.state,
      pinnedAt,
    });
    const operationId = uuidv7();
    await publishProjectExecutionFocus(
      handle,
      {
        action: 'set',
        operationId,
        scope,
        expectedSelection: selected.selection,
        pinBytes: Buffer.from(canonicalJson(pin)),
        expectedArtifactRevision: artifact.revision,
        expectedExecutionVersion: execution.version,
        secretAllow: [...input.secretAllow],
      },
      options
    );
    return {
      state: 'updated',
      operation_id: operationId,
      read_only:
        execution.state.lifecycle === 'completed' || execution.state.origin_kind === 'git-import',
      displaced_artifact_id:
        selected.status === 'present' && selected.pin.artifact_id !== input.artifactId
          ? selected.pin.artifact_id
          : null,
    };
  } catch (cause) {
    return { state: 'failed', error: captureFailure(cause) };
  }
}

/** Clears the session focus only when it names this artifact; other shells' pins are untouched. */
export async function clearDatabaseCaptureFocus(
  handle: ProjectDatabase,
  input: DatabaseCaptureFocusInput,
  options: ProjectOperationOptions = {}
): Promise<DatabaseCaptureFocusOutcome> {
  const scope = focusScope(input);
  if (!scope) return { state: 'not_requested' };
  try {
    const selected = readProjectExecutionFocus(handle, scope);
    if (selected.status !== 'present' || selected.pin.artifact_id !== input.artifactId)
      return { state: 'not_requested' };
    const operationId = uuidv7();
    await publishProjectExecutionFocus(
      handle,
      {
        action: 'clear',
        operationId,
        scope,
        expectedSelection: selected.selection,
        secretAllow: [...input.secretAllow],
      },
      options
    );
    return { state: 'cleared', operation_id: operationId };
  } catch (cause) {
    return { state: 'failed', error: captureFailure(cause) };
  }
}
