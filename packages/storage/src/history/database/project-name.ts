import path from 'node:path';

import type { ProjectDatabase, ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { type ProjectOperationOptions, runProjectOperation } from './transactions.js';

export function repositoryDisplayName(commonDirectory: string): string {
  const directory =
    path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : commonDirectory;
  return path.basename(directory).replace(/\.git$/, '');
}

export function validateProjectDisplayName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide a project display name of 1–200 characters on one line'
    );
  return value.trim();
}

function selectedName(view: ProjectReadView): string | null {
  const row = view.get<{ name: string }>(
    `SELECT json_extract(result_json, '$.displayName') AS name FROM operations
     WHERE operation_kind = 'project.display_name' ORDER BY committed_write_sequence LIMIT 1`
  );
  if (!row) return null;
  try {
    return validateProjectDisplayName(row.name);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained project name is invalid; inspect its original operation record',
      { cause }
    );
  }
}

export function readProjectDisplayName(handle: ProjectDatabase): string | null {
  return handle.read(selectedName).value;
}

export async function retainProjectDisplayName(
  handle: ProjectDatabase,
  input: { operationId: string; displayName: string },
  options: ProjectOperationOptions = {}
): Promise<void> {
  const displayName = validateProjectDisplayName(input.displayName);
  // The retained operation result owns this create-once label; no second settings copy is needed.
  await runProjectOperation(
    handle,
    {
      operationId: input.operationId,
      kind: 'project.display_name',
      target: { projectId: handle.authority.projectId },
      payload: { displayName },
      expectedState: null,
      intentChange: false,
    },
    (view) => ({ displayName: selectedName(view) ?? displayName }),
    options
  );
}
