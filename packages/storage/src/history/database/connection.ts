import type Database from 'better-sqlite3';
import { type BigIntStats, closeSync, fstatSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import path from 'node:path';

import { isUuidV7 } from '../../ids/uuidv7.js';
import { inspectHistoryPath } from '../metadata.js';
import { historyRootKey, normalizeHistoryRoot } from '../paths.js';
import { HistoryError } from '../types.js';
import { loadDatabase } from './driver.js';
import { ProjectDatabaseError, sqliteCode } from './errors.js';
import type { ProjectInitialization } from './initialization.js';
import { registerQueryFunctions } from './query-functions.js';
import { copyRepositoryCreation, type RepositoryCreation } from './repository-creation.js';
import { validateProjectSchemaDefinition } from './schema-validation.js';
import { projectSchemaVersionRefusal } from './schema-version.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { registerSearchFunctions } from './search-functions.js';
import { copyDatabaseValue } from './values.js';

export interface ProjectDatabaseAuthority {
  readonly resolvedRoot: string;
  readonly rootKey: string;
  readonly projectId: string;
  readonly storeInstanceId: string;
  readonly repositoryInstanceId: string;
}

export interface ProjectCounters {
  writeSequence: number;
  intentChangeCounter: number;
}

export interface ProjectReadView {
  all<T>(sql: string, ...parameters: unknown[]): T[];
  get<T>(sql: string, ...parameters: unknown[]): T | null;
}

export interface ProjectDatabase {
  readonly authority: ProjectDatabaseAuthority;
  readonly databasePath: string;
  read<T>(read: (view: ProjectReadView) => T): { value: T; counters: ProjectCounters };
  close(): void;
}

export interface ProjectInitializationObservation {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

type DatabaseFileIdentity = Omit<ProjectInitializationObservation, 'path'>;
const projectInitializationObservations = new WeakMap<
  ProjectDatabaseError,
  ProjectInitializationObservation
>();

export function readProjectInitializationObservation(
  cause: unknown
): ProjectInitializationObservation | undefined {
  return cause instanceof ProjectDatabaseError
    ? projectInitializationObservations.get(cause)
    : undefined;
}

interface ConnectionState {
  database: Database.Database;
  busy: boolean;
  poisoned: boolean;
  fileIdentity: DatabaseFileIdentity;
}
const connections = new WeakMap<ProjectDatabase, ConnectionState>();

function observeMainFile(file: string): DatabaseFileIdentity {
  let info: BigIntStats;
  try {
    info = lstatSync(file, { bigint: true });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    throw new ProjectDatabaseError(
      missing ? 'HISTORY_MISSING' : 'HISTORY_INACCESSIBLE',
      missing
        ? 'The expected main database is missing; explicit repair is required, never reinitialization'
        : 'The main database cannot be inspected; check permissions, mount and storage health before retrying; never reinitialize',
      { cause }
    );
  }
  if (!info.isFile() || info.nlink < 1n) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The main database is not a linked regular file; preserve the path for explicit history repair'
    );
  }
  return { dev: info.dev, ino: info.ino };
}

function assertMainFile(file: string, expected: DatabaseFileIdentity): void {
  const actual = observeMainFile(file);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The main database pathname identifies a different file; close this handle and use explicit history repair'
    );
  }
}

export function assertProjectDatabasePath(handle: ProjectDatabase): void {
  const state = connections.get(handle);
  if (!state)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Use a validated project database connection');
  assertMainFile(handle.databasePath, state.fileIdentity);
}

export function projectDatabasePath(authority: ProjectDatabaseAuthority): string {
  if (
    !path.isAbsolute(authority.resolvedRoot) ||
    path.normalize(authority.resolvedRoot) !== authority.resolvedRoot ||
    authority.rootKey !== historyRootKey(authority.resolvedRoot) ||
    ![authority.projectId, authority.storeInstanceId, authority.repositoryInstanceId].every(
      isUuidV7
    )
  ) {
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Select the canonical root and complete original project/store/repository identities'
    );
  }
  return path.join(authority.resolvedRoot, 'projects', authority.projectId, 'history.sqlite3');
}

async function validatePath(authority: ProjectDatabaseAuthority): Promise<string> {
  projectDatabasePath(authority);
  return validateProjectLocation(authority.resolvedRoot, authority.projectId);
}

async function validateProjectLocation(resolvedRoot: string, projectId: string): Promise<string> {
  try {
    const authority = { resolvedRoot, rootKey: historyRootKey(resolvedRoot) };
    const file = path.join(resolvedRoot, 'projects', projectId, 'history.sqlite3');
    const root = await normalizeHistoryRoot({ root: authority.resolvedRoot });
    if (root.resolvedRoot !== authority.resolvedRoot || root.rootKey !== authority.rootKey) {
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'The selected root changed; select the original registered authority'
      );
    }
    const directory = await inspectHistoryPath(authority.resolvedRoot, path.dirname(file));
    if (!directory?.isDirectory()) {
      throw new ProjectDatabaseError(
        'HISTORY_MISSING',
        'The expected project directory is missing. Preserve the registration, SQLite companion files and retained evidence, then run `orcaops doctor`. Restore only the verified original directory; setup cannot replace missing history.'
      );
    }
    const info = await inspectHistoryPath(authority.resolvedRoot, file);
    if (info && !info.isFile()) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The database path is not a regular file; explicit repair is required'
      );
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = await inspectHistoryPath(authority.resolvedRoot, `${file}${suffix}`);
      if (sidecar && !sidecar.isFile()) {
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'A database sidecar is not a regular file; explicit repair is required'
        );
      }
    }
    return file;
  } catch (cause) {
    if (
      cause instanceof HistoryError &&
      (cause.code === 'HISTORY_INACCESSIBLE' ||
        cause.code === 'HISTORY_UNEXPECTED_OWNER' ||
        cause.code === 'AUTHORITY_MISMATCH')
    )
      throw new ProjectDatabaseError(
        cause.code,
        'The selected history path cannot be validated; inspect ownership, permissions and original authority before retrying',
        { cause }
      );
    throw cause;
  }
}
// The conversion creates its target itself, so it needs the same validated pathname the
// normal open path derives without opening anything.
export function validateProjectDatabaseLocation(
  authority: ProjectDatabaseAuthority
): Promise<string> {
  return validatePath(authority);
}

export function validateProjectIdentity(
  database: Database.Database,
  authority: ProjectDatabaseAuthority
): void {
  const refusal = projectSchemaVersionRefusal(
    database.pragma('user_version', { simple: true }) as number
  );
  if (refusal) throw refusal;
  validateProjectStoreIdentity(database, authority);
}

// The identity and activation rows have had one shape since the first released schema, so the
// explicit upgrade and a backup's verification ask this of a store this build cannot open.
export function validateProjectStoreIdentity(
  database: Database.Database,
  authority: ProjectDatabaseAuthority
): void {
  const row = database
    .prepare(
      `SELECT i.*, a.state FROM store_identity i
    JOIN activation a ON a.store_identity_id = i.singleton WHERE i.singleton = 1`
    )
    .get() as Record<string, unknown> | undefined;
  if (!row || row.state !== 'active' || !isUuidV7(row.initialization_operation_id as string)) {
    throw new ProjectDatabaseError(
      'ACTIVATION_PENDING',
      'Database initialization is incomplete; retry the original setup operation or use explicit repair'
    );
  }
  if (
    row.resolved_root !== authority.resolvedRoot ||
    row.root_key !== authority.rootKey ||
    row.project_id !== authority.projectId ||
    row.repository_instance_id !== authority.repositoryInstanceId
  ) {
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      'Database authority differs from the requested root/project/repository; select the original authority'
    );
  }
  if (row.store_instance_id !== authority.storeInstanceId) {
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The expected store instance is missing; explicit history repair is required'
    );
  }
}

function syncDatabaseDirectory(file: string): void {
  const directory = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function configureWriter(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  if (process.platform === 'darwin') database.pragma('fullfsync = ON');
  if (
    database.pragma('journal_mode', { simple: true }) !== 'wal' ||
    database.pragma('synchronous', { simple: true }) !== 2 ||
    database.pragma('foreign_keys', { simple: true }) !== 1 ||
    (process.platform === 'darwin' && database.pragma('fullfsync', { simple: true }) !== 1)
  ) {
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'The database cannot establish required WAL/FULL durability; use supported local storage and explicit repair'
    );
  }
}

export function readProjectCounters(database: Database.Database): ProjectCounters {
  const row = database
    .prepare(
      'SELECT write_sequence, intent_change_counter FROM project_counters WHERE singleton = 1'
    )
    .get() as { write_sequence: number; intent_change_counter: number } | undefined;
  if (
    !row ||
    !Number.isSafeInteger(row.write_sequence) ||
    !Number.isSafeInteger(row.intent_change_counter) ||
    row.write_sequence < 0 ||
    row.intent_change_counter < 0
  ) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'Project counters are missing or outside the safe integer range; explicit repair is required'
    );
  }
  return { writeSequence: row.write_sequence, intentChangeCounter: row.intent_change_counter };
}

export function createReadView(
  database: Database.Database,
  isActive: () => boolean
): ProjectReadView {
  const statement = (sql: string) => {
    if (!isActive())
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'The read transaction ended; request a fresh materialized read'
      );
    if (!/^\s*(SELECT|WITH)\b/i.test(sql))
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Read views accept only readonly row queries'
      );
    const query = database.prepare(sql);
    if (!query.readonly || !query.reader)
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Read views accept only readonly row queries'
      );
    return query;
  };
  return Object.freeze({
    all<T>(sql: string, ...parameters: unknown[]): T[] {
      return copyDatabaseValue(statement(sql).all(...parameters) as T[]);
    },
    get<T>(sql: string, ...parameters: unknown[]): T | null {
      return copyDatabaseValue((statement(sql).get(...parameters) as T | undefined) ?? null);
    },
  });
}

export function claimProjectConnection(
  handle: ProjectDatabase,
  access: 'reader' | 'writer' = 'writer'
): ConnectionState {
  const state = connections.get(handle);
  if (state?.poisoned)
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'This connection is poisoned; inspect storage and open a new validated connection'
    );
  if (!state?.database.open)
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'The connection is closed; open and validate the existing project database again'
    );
  assertProjectDatabasePath(handle);
  if (access === 'writer' && state.database.readonly)
    throw new ProjectDatabaseError(
      'HISTORY_INACCESSIBLE',
      'This connection is readonly; an explicitly authorized writer is required'
    );
  if (state.busy || state.database.inTransaction)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Finish the current operation before reusing this project connection'
    );
  state.busy = true;
  return state;
}

export function rollbackProjectConnection(state: ConnectionState, cause: unknown): void {
  if (state.poisoned) return;
  try {
    if (state.database.inTransaction) state.database.exec('ROLLBACK');
  } catch (rollbackError) {
    state.poisoned = true;
    const failures = [cause, rollbackError];
    try {
      state.database.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    throw new ProjectDatabaseError(
      'TRANSACTION_FAILED',
      'Rollback failed; the connection is permanently unusable. Inspect storage before retrying the original operation',
      {
        cause: new AggregateError(failures, 'Operation and connection recovery failed'),
      }
    );
  }
}

function wrap(
  database: Database.Database,
  authority: ProjectDatabaseAuthority,
  databasePath: string,
  fileIdentity: DatabaseFileIdentity
): ProjectDatabase {
  assertMainFile(databasePath, fileIdentity);
  registerSearchFunctions(database);
  registerQueryFunctions(database);
  const handle: ProjectDatabase = Object.freeze({
    authority: Object.freeze({ ...authority }),
    databasePath,
    read<T>(read: (view: ProjectReadView) => T) {
      const state = claimProjectConnection(handle, 'reader');
      let active = true;
      try {
        database.exec('BEGIN');
        validateProjectIdentity(database, authority);
        const counters = readProjectCounters(database);
        const value = copyDatabaseValue(
          read(createReadView(database, () => active && database.inTransaction))
        );
        assertProjectDatabasePath(handle);
        database.exec('COMMIT');
        return { value, counters };
      } catch (error) {
        rollbackProjectConnection(state, error);
        throw error;
      } finally {
        active = false;
        state.busy = false;
      }
    },
    close() {
      const state = connections.get(handle)!;
      if (state.busy)
        throw new ProjectDatabaseError(
          'INVALID_INPUT',
          'Cancel or finish the active operation before closing its connection'
        );
      database.close();
    },
  });
  connections.set(handle, { database, busy: false, poisoned: false, fileIdentity });
  return handle;
}

export function openProjectDatabase(input: {
  authority: ProjectDatabaseAuthority;
  mode: 'reader' | 'writer';
  signal?: AbortSignal;
}): Promise<ProjectDatabase> {
  return openExistingProjectDatabase(input);
}

export function databaseValidationFailure(cause: unknown): ProjectDatabaseError {
  if (cause instanceof ProjectDatabaseError) return cause;
  const code = sqliteCode(cause);
  const invalid =
    code === 'SQLITE_ERROR' || code === 'SQLITE_NOTADB' || code?.startsWith('SQLITE_CORRUPT');
  return new ProjectDatabaseError(
    invalid ? 'HISTORY_INTEGRITY_REQUIRED' : 'HISTORY_INACCESSIBLE',
    invalid
      ? 'Canonical history contains invalid database or schema evidence; preserve it for explicit repair'
      : 'Canonical history is unavailable or could not be inspected; release contention or inspect storage access before retrying, never initialize a replacement',
    { cause }
  );
}

function closeUnreturnedDatabase(
  database: Database.Database,
  primary?: ProjectDatabaseError
): void {
  const failures: unknown[] = [];
  try {
    if (database.inTransaction) database.exec('ROLLBACK');
  } catch (cause) {
    failures.push(cause);
  }
  try {
    database.close();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length)
    throw new ProjectDatabaseError(
      primary?.code ?? 'HISTORY_INACCESSIBLE',
      primary?.message ??
        'Database connection cleanup failed; inspect storage before opening the existing history again',
      {
        cause: new AggregateError(
          primary ? [primary, ...failures] : failures,
          'Database validation and connection cleanup failed'
        ),
      }
    );
}

async function openExistingProjectDatabase(input: {
  authority: ProjectDatabaseAuthority;
  mode: 'reader' | 'writer';
  signal?: AbortSignal;
}): Promise<ProjectDatabase> {
  const mode = input.mode;
  if (mode !== 'reader' && mode !== 'writer')
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Choose an explicit reader or writer access mode before opening history'
    );
  const signal = input.signal;
  // Cancellation is observed where the open actually yields; a validation or schema read
  // already in the driver runs to completion, and no handle is returned once it is set.
  const cancelled = (): void => {
    if (signal?.aborted)
      throw new ProjectDatabaseError(
        'CANCELLED',
        'Opening project history was cancelled; nothing was created or changed'
      );
  };
  cancelled();
  const authority = Object.freeze({ ...input.authority });
  const file = await validatePath(authority);
  if (!(await inspectHistoryPath(authority.resolvedRoot, file))) {
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'Expected history is missing; explicit repair is required and no replacement was created'
    );
  }
  cancelled();
  const fileIdentity = observeMainFile(file);
  const DatabaseConstructor = loadDatabase();
  let readonly: Database.Database;
  try {
    readonly = new DatabaseConstructor(file, { readonly: true, fileMustExist: true, timeout: 100 });
  } catch (cause) {
    throw databaseValidationFailure(cause);
  }
  let returnedReader = false;
  let primary: ProjectDatabaseError | undefined;
  try {
    readonly.pragma('temp_store = MEMORY');
    readonly.exec('BEGIN');
    validateProjectIdentity(readonly, authority);
    readProjectCounters(readonly);
    validateProjectSchemaDefinition(readonly, PROJECT_DATABASE_SCHEMA_VERSION);
    if (readonly.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new ProjectDatabaseError(
        'HISTORY_FORMAT_UNSUPPORTED',
        'Project history is not WAL storage; use explicit schema repair'
      );
    }
    readonly.exec('COMMIT');
    if (mode === 'reader') {
      const handle = wrap(readonly, authority, file, fileIdentity);
      returnedReader = true;
      return handle;
    }
  } catch (cause) {
    primary = databaseValidationFailure(cause);
    throw primary;
  } finally {
    if (!returnedReader) closeUnreturnedDatabase(readonly, primary);
  }
  // Close validation before opening a writer, so a failed close cannot strand a writable handle.
  cancelled();
  assertMainFile(file, fileIdentity);
  let database: Database.Database;
  try {
    database = new DatabaseConstructor(file, { fileMustExist: true, timeout: 100 });
  } catch (cause) {
    throw databaseValidationFailure(cause);
  }
  try {
    assertMainFile(file, fileIdentity);
    validateProjectIdentity(database, authority);
    configureWriter(database);
    return wrap(database, authority, file, fileIdentity);
  } catch (cause) {
    const failure = databaseValidationFailure(cause);
    closeUnreturnedDatabase(database, failure);
    throw failure;
  }
}

export interface InitializeProjectDatabaseInput {
  authority: ProjectDatabaseAuthority;
  initializationOperationId: string;
  initializedAt: string;
  authorize: () => void;
}

export function initializeProjectDatabase(
  input: InitializeProjectDatabaseInput
): Promise<ProjectDatabase> {
  return initializeDatabase(input, null);
}

export function initializeRepositoryDatabase(
  input: InitializeProjectDatabaseInput & {
    repositoryCreation: RepositoryCreation;
  }
): Promise<ProjectDatabase> {
  return initializeDatabase(input, copyRepositoryCreation(input.repositoryCreation));
}

async function initializeDatabase(
  input: InitializeProjectDatabaseInput,
  repositoryCreation: Readonly<RepositoryCreation> | null
): Promise<ProjectDatabase> {
  const initializationOperationId = input.initializationOperationId;
  const initializedAt = input.initializedAt;
  const authority = Object.freeze({ ...input.authority });
  const authorization: unknown = input.authorize();
  if (authorization !== undefined)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Authorization and refusal checks must finish synchronously before database initialization'
    );
  if (!isUuidV7(initializationOperationId) || !Number.isFinite(Date.parse(initializedAt))) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide the original initialization operation ID and timestamp before initializing'
    );
  }
  const file = await validatePath(authority);
  let descriptor: number;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (repositoryCreation) {
        const candidate = await readProjectInitializationCandidate({
          root: authority.resolvedRoot,
          projectId: authority.projectId,
        });
        if (!candidate.repositoryCreation)
          throw new ProjectDatabaseError(
            'IDENTITY_RECOVERY_REQUIRED',
            'Existing history has no original repository creation evidence; use explicit identity repair'
          );
        if (
          Object.entries(authority).some(
            ([key, value]) => candidate.authority[key as keyof ProjectDatabaseAuthority] !== value
          ) ||
          candidate.initializationOperationId !== initializationOperationId ||
          candidate.initializedAt !== initializedAt ||
          JSON.stringify(candidate.repositoryCreation) !== JSON.stringify(repositoryCreation)
        )
          throw new ProjectDatabaseError(
            'IDENTITY_CONFLICT',
            'Initialization identities or creation facts differ; inspect and retry the original validated initialization'
          );
      }
      const existing = await openProjectDatabase({ authority, mode: 'writer' });
      try {
        syncDatabaseDirectory(file);
        return existing;
      } catch (cause) {
        existing.close();
        throw cause;
      }
    }
    throw error;
  }
  const createdFile = fstatSync(descriptor, { bigint: true });
  const fileIdentity = { dev: createdFile.dev, ino: createdFile.ino };
  closeSync(descriptor);
  assertMainFile(file, fileIdentity);
  const DatabaseConstructor = loadDatabase();
  const database = new DatabaseConstructor(file, { fileMustExist: true, timeout: 100 });
  try {
    configureWriter(database);
    database.exec('BEGIN IMMEDIATE');
    database.exec(PROJECT_DATABASE_SCHEMA);
    database
      .prepare('INSERT INTO store_identity VALUES (1, ?, ?, ?, ?, ?, ?)')
      .run(
        authority.resolvedRoot,
        authority.rootKey,
        authority.projectId,
        authority.storeInstanceId,
        authority.repositoryInstanceId,
        initializationOperationId
      );
    if (repositoryCreation)
      database
        .prepare('INSERT INTO repository_creation VALUES (1, 1, ?, ?, ?, ?)')
        .run(
          repositoryCreation.commonDirectory,
          repositoryCreation.device,
          repositoryCreation.inode,
          repositoryCreation.birthtimeNs
        );
    database.prepare("INSERT INTO activation VALUES (1, 1, ?, 'active')").run(initializedAt);
    database.prepare('INSERT INTO project_counters VALUES (1, 1, 0)').run();
    assertMainFile(file, fileIdentity);
    database.exec('COMMIT');
    syncDatabaseDirectory(file);
    return wrap(database, authority, file, fileIdentity);
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    database.close();
    throw error;
  }
}

export interface ProjectInitializationCandidate extends ProjectInitialization {
  readonly schemaVersion: number;
  readonly repositoryCreation: Readonly<RepositoryCreation> | null;
}

export async function readProjectInitializationCandidate(input: {
  root: string;
  projectId: string;
  expectedMainFileIdentity?: Readonly<DatabaseFileIdentity>;
}): Promise<ProjectInitializationCandidate> {
  const root = input.root;
  const projectId = input.projectId;
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    !isUuidV7(projectId)
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Select a canonical data root and original project ID before inspecting initialization'
    );
  const file = await validateProjectLocation(root, projectId);
  const fileIdentity = observeMainFile(file);
  if (
    input.expectedMainFileIdentity &&
    (fileIdentity.dev !== input.expectedMainFileIdentity.dev ||
      fileIdentity.ino !== input.expectedMainFileIdentity.ino)
  )
    throw new ProjectDatabaseError(
      'HISTORY_MISSING',
      'The main database changed after it was observed; preserve remaining evidence and use explicit repair'
    );
  let database: Database.Database | undefined;
  let primary: ProjectDatabaseError | undefined;
  try {
    const Constructor = loadDatabase();
    database = new Constructor(file, { readonly: true, fileMustExist: true, timeout: 100 });
    assertMainFile(file, fileIdentity);
    database.pragma('temp_store = MEMORY');
    database.exec('BEGIN');
    const schemaVersion = database.pragma('user_version', { simple: true }) as number;
    if (schemaVersion === 0 && !database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
      throw new ProjectDatabaseError(
        'ACTIVATION_PENDING',
        'The occupied empty database has no committed initialization; retry the original setup or use explicit repair, never initialize a replacement'
      );
    const refusal = projectSchemaVersionRefusal(schemaVersion);
    if (refusal) throw refusal;
    validateProjectSchemaDefinition(database, schemaVersion);
    const row = database
      .prepare(
        `SELECT i.*, a.initialized_at, a.state FROM store_identity i
      JOIN activation a ON a.store_identity_id = i.singleton WHERE i.singleton = 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row || row.state !== 'active')
      throw new ProjectDatabaseError(
        'ACTIVATION_PENDING',
        'Initialization did not commit a complete active identity; preserve this candidate for original-operation retry or explicit repair'
      );
    const authority = Object.freeze({
      resolvedRoot: row.resolved_root as string,
      rootKey: row.root_key as string,
      projectId: row.project_id as string,
      storeInstanceId: row.store_instance_id as string,
      repositoryInstanceId: row.repository_instance_id as string,
    });
    projectDatabasePath(authority);
    if (authority.resolvedRoot !== root || authority.projectId !== projectId)
      throw new ProjectDatabaseError(
        'AUTHORITY_MISMATCH',
        'Candidate authority differs from the selected root or project; use the original authority'
      );
    if (
      !isUuidV7(row.initialization_operation_id as string) ||
      typeof row.initialized_at !== 'string' ||
      !Number.isFinite(Date.parse(row.initialized_at))
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Original initialization metadata is invalid; preserve it for explicit repair'
      );
    if (database.pragma('journal_mode', { simple: true }) !== 'wal')
      throw new ProjectDatabaseError(
        'HISTORY_FORMAT_UNSUPPORTED',
        'Initialization candidate is not WAL storage; use explicit repair'
      );
    let repositoryCreation: Readonly<RepositoryCreation> | null = null;
    const creation = database
      .prepare('SELECT * FROM repository_creation WHERE singleton = 1')
      .get() as Record<string, unknown> | undefined;
    if (creation) {
      if (creation.store_identity_id !== 1)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'Creation evidence references a different identity; preserve history for explicit repair'
        );
      repositoryCreation = copyRepositoryCreation(
        {
          commonDirectory: creation.common_directory as string,
          device: creation.device as string,
          inode: creation.inode as string,
          birthtimeNs: creation.birthtime_ns as string | null,
        },
        'HISTORY_INTEGRITY_REQUIRED'
      );
    }
    assertMainFile(file, fileIdentity);
    database.exec('COMMIT');
    return Object.freeze({
      authority,
      initializationOperationId: row.initialization_operation_id as string,
      initializedAt: row.initialized_at,
      state: 'active',
      schemaVersion,
      repositoryCreation,
    });
  } catch (cause) {
    primary = databaseValidationFailure(cause);
    try {
      assertMainFile(file, fileIdentity);
    } catch (identityCause) {
      primary = databaseValidationFailure(identityCause);
    }
    projectInitializationObservations.set(
      primary,
      Object.freeze({ path: file, dev: fileIdentity.dev, ino: fileIdentity.ino })
    );
    throw primary;
  } finally {
    if (database) closeUnreturnedDatabase(database, primary);
  }
}
