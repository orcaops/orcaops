import path from 'node:path';

import { isUuidV7 } from '@orcaops/storage';
import {
  HistoryError,
  type HistoryRoot,
  normalizeHistoryRoot,
} from '@orcaops/storage/history/authority';
import {
  openProjectDatabase,
  type ProjectDatabaseAuthority,
  ProjectDatabaseError,
  type ProjectInitialization,
  readProjectInitialization,
} from '@orcaops/storage/history/database';

import {
  decodeRegistration,
  type ProjectCatalogEntry,
  projectCatalogSchema,
  registrationBytes,
  type RepositoryRegistration,
  repositoryRegistrationSchema,
  sealRegistration,
  type WorktreeRegistration,
  worktreeRegistrationSchema,
} from './registration-files-format.js';
import { readRegistrationBytes, validateRegistrationRoot } from './registration-files-io.js';
import { prepareRegistration } from './registration-files-publication.js';

export type {
  ProjectCatalogEntry,
  RepositoryRegistration,
  WorktreeRegistration,
} from './registration-files-format.js';
export { isPreparedCatalogEntryName } from './registration-files-publication.js';

export async function readRepositoryRegistration(input: {
  commonDir: string;
  requestedRoot?: HistoryRoot;
}): Promise<RepositoryRegistration | null> {
  const commonDir = input.commonDir;
  const requestedRoot = input.requestedRoot && { ...input.requestedRoot };
  await validateRegistrationRoot(commonDir, true);
  const file = path.join(commonDir, 'orcaops', 'registration.json');
  const bytes = await readRegistrationBytes(commonDir, file);
  if (!bytes) return null;
  const value = decodeRegistration(bytes, repositoryRegistrationSchema, 'Repository registration');
  const registered = value.authority.resolved_root;
  const normalized = await normalizeHistoryRoot({ root: registered });
  if (normalized.resolvedRoot !== registered || normalized.rootKey !== value.authority.root_key)
    throw new HistoryError(
      'AUTHORITY_MISMATCH',
      `This repository is registered to data root ${registered} (${file}), which no longer resolves to itself; it was moved or replaced and needs explicit repair. Nothing was changed.`,
      { registered_root: registered, registration: file }
    );
  if (
    requestedRoot &&
    (requestedRoot.resolvedRoot !== normalized.resolvedRoot ||
      requestedRoot.rootKey !== normalized.rootKey)
  )
    throw new HistoryError(
      'AUTHORITY_MISMATCH',
      `This repository is registered to data root ${registered} (${file}), not ${requestedRoot.resolvedRoot}. Set ORCAOPS_DATA_DIR to the registered root, or use a separate clone for a different root. Nothing was changed.`,
      {
        registered_root: registered,
        requested_root: requestedRoot.resolvedRoot,
        registration: file,
      }
    );
  return value;
}

export async function readWorktreeRegistration(input: {
  gitDir: string;
  repositoryInstanceId: string;
}): Promise<WorktreeRegistration | null> {
  const { gitDir, repositoryInstanceId } = input;
  await validateRegistrationRoot(gitDir, true);
  const bytes = await readRegistrationBytes(gitDir, path.join(gitDir, 'orcaops', 'worktree.json'));
  if (!bytes) return null;
  const value = decodeRegistration(bytes, worktreeRegistrationSchema, 'Worktree registration');
  if (value.repository_instance_id !== repositoryInstanceId) {
    throw new HistoryError(
      'IDENTITY_CONFLICT',
      'Worktree registration belongs to another repository; inspect its Git authority'
    );
  }
  return value;
}

export async function readProjectCatalogEntry(input: {
  root: HistoryRoot;
  projectId: string;
}): Promise<ProjectCatalogEntry | null> {
  const projectId = input.projectId;
  const root = { ...input.root };
  if (!isUuidV7(projectId))
    throw new HistoryError('HISTORY_INTEGRITY_REQUIRED', 'Catalog project identity is invalid');
  const normalized = await normalizeHistoryRoot({ root: root.resolvedRoot });
  if (normalized.resolvedRoot !== root.resolvedRoot || normalized.rootKey !== root.rootKey) {
    throw new HistoryError(
      'AUTHORITY_MISMATCH',
      'Catalog root differs from its normalized authority'
    );
  }
  await validateRegistrationRoot(normalized.resolvedRoot, false);
  const bytes = await readRegistrationBytes(
    normalized.resolvedRoot,
    path.join(normalized.resolvedRoot, 'projects', 'catalog', `${projectId}.json`)
  );
  if (!bytes) return null;
  const value = decodeRegistration(bytes, projectCatalogSchema, 'Project catalog entry');
  if (value.project_id !== projectId) {
    throw new HistoryError(
      'IDENTITY_CONFLICT',
      'Catalog filename and retained project identity differ; preserve both for explicit repair'
    );
  }
  return value;
}

interface InitializationRequest {
  expected: ProjectDatabaseAuthority;
  initializationOperationId: string;
  signal?: AbortSignal;
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProjectDatabaseError(
      'CANCELLED',
      'Registration cancelled before publication; retry the original operation when ready'
    );
}

async function certifyInitialization(
  expected: ProjectDatabaseAuthority,
  operationId: string
): Promise<ProjectInitialization> {
  const database = await openProjectDatabase({ authority: expected, mode: 'reader' });
  try {
    const initialization = readProjectInitialization(database);
    if (initialization.initializationOperationId !== operationId) {
      throw new HistoryError(
        'IDENTITY_CONFLICT',
        'Registration must retain the original committed initialization operation; inspect its existing authority'
      );
    }
    return initialization;
  } finally {
    database.close();
  }
}

export async function publishRepositoryRegistration(
  input: InitializationRequest & {
    commonDir: string;
  }
): Promise<{ registration: RepositoryRegistration; publication: 'created' | 'existing' }> {
  const { commonDir, initializationOperationId, signal } = input;
  const expected = Object.freeze({ ...input.expected });
  checkCancellation(signal);
  if (!isUuidV7(initializationOperationId))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original initialization operation UUID before publishing registration'
    );
  const initialization = await certifyInitialization(expected, initializationOperationId);
  await readRepositoryRegistration({ commonDir, requestedRoot: expected });
  const registration = sealRegistration({
    schema_version: 1 as const,
    repository_instance_id: initialization.authority.repositoryInstanceId,
    authority: {
      resolved_root: initialization.authority.resolvedRoot,
      root_key: initialization.authority.rootKey,
      project_id: initialization.authority.projectId,
      store_instance_id: initialization.authority.storeInstanceId,
    },
    initialization_operation_id: initialization.initializationOperationId,
  });
  checkCancellation(signal);
  const prepared = await prepareRegistration({
    root: commonDir,
    file: path.join(commonDir, 'orcaops', 'registration.json'),
    bytes: registrationBytes(registration),
    schema: repositoryRegistrationSchema,
    operationId: initializationOperationId,
  });
  let failure: unknown;
  try {
    await certifyInitialization(expected, initializationOperationId);
    checkCancellation(signal);
    return { registration, publication: await prepared.publish(signal) };
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    await prepared.dispose(failure);
  }
}

export async function publishProjectCatalogEntry(
  input: InitializationRequest
): Promise<{ entry: ProjectCatalogEntry; publication: 'created' | 'existing' }> {
  const { initializationOperationId, signal } = input;
  const expected = Object.freeze({ ...input.expected });
  checkCancellation(signal);
  if (!isUuidV7(initializationOperationId))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original initialization operation UUID before publishing a catalog entry'
    );
  const initialization = await certifyInitialization(expected, initializationOperationId);
  const entry = sealRegistration({
    schema_version: 1 as const,
    project_id: initialization.authority.projectId,
    creation: {
      operation_id: initialization.initializationOperationId,
      created_at: initialization.initializedAt,
    },
  });
  checkCancellation(signal);
  const prepared = await prepareRegistration({
    root: expected.resolvedRoot,
    file: path.join(expected.resolvedRoot, 'projects', 'catalog', `${expected.projectId}.json`),
    bytes: registrationBytes(entry),
    schema: projectCatalogSchema,
    operationId: initializationOperationId,
  });
  let failure: unknown;
  try {
    const current = await certifyInitialization(expected, initializationOperationId);
    if (current.initializedAt !== initialization.initializedAt)
      throw new HistoryError(
        'IDENTITY_CONFLICT',
        'Committed initialization changed before catalog publication; preserve it for explicit repair'
      );
    checkCancellation(signal);
    return { entry, publication: await prepared.publish(signal) };
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    await prepared.dispose(failure);
  }
}

export async function publishWorktreeRegistration(input: {
  gitDir: string;
  repositoryInstanceId: string;
  worktreeId: string;
  operationId: string;
  signal?: AbortSignal;
}): Promise<{ registration: WorktreeRegistration; publication: 'created' | 'existing' }> {
  const { gitDir, repositoryInstanceId, worktreeId, operationId, signal } = input;
  checkCancellation(signal);
  if (![repositoryInstanceId, worktreeId, operationId].every(isUuidV7))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide repository, worktree and original operation UUIDs before publishing registration'
    );
  await readWorktreeRegistration({ gitDir, repositoryInstanceId });
  const registration = sealRegistration({
    schema_version: 1 as const,
    repository_instance_id: repositoryInstanceId,
    worktree_id: worktreeId,
  });
  checkCancellation(signal);
  const prepared = await prepareRegistration({
    root: gitDir,
    file: path.join(gitDir, 'orcaops', 'worktree.json'),
    bytes: registrationBytes(registration),
    schema: worktreeRegistrationSchema,
    operationId,
  });
  let failure: unknown;
  try {
    checkCancellation(signal);
    return { registration, publication: await prepared.publish(signal) };
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    await prepared.dispose(failure);
  }
}
