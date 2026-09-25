// Verified backups of a project database and the explicit restore from one.
//
// A backup is a directory under `upgrade-backups/` beside the database: the database as one
// self-contained file and a manifest that says what the file must hold and what the database
// names outside itself. It appears under its final name only after it has been verified, and
// nothing here ever deletes one.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import {
  configureWriter,
  databaseValidationFailure,
  type ProjectCounters,
  type ProjectDatabaseAuthority,
  readProjectCounters,
  validateProjectDatabaseLocation,
  validateProjectStoreIdentity,
} from './connection.js';
import { digestOfDigests, digestTables, type TableDigest } from './content-digest.js';
import { loadDatabase } from './driver.js';
import { isDatabaseContention, ProjectDatabaseError } from './errors.js';
import { readSchemaObjects, schemaSqlDigest } from './released-schema.js';
import { inspectRetainedReferences, type RetainedReferences } from './retained-references.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';

export const BACKUP_DIRECTORY = 'upgrade-backups';
export const BACKUP_DATABASE_FILE = 'history-backup.sqlite3';
export const BACKUP_MANIFEST_FILE = 'manifest.json';
const PENDING_PREFIX = '.pending-';
const BACKUP_NAME =
  /^schema-\d{1,9}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const counter = z.number().int().nonnegative();
const presence = z.enum(['present', 'changed', 'absent', 'unknown']);
const manifestBody = z.strictObject({
  manifest_version: z.literal(1),
  name: z.string().regex(BACKUP_NAME),
  created_at: z.string().datetime(),
  reason: z.literal('schema_upgrade'),
  store: z.strictObject({
    resolved_root: z.string().min(1),
    root_key: z.string().min(1),
    project_id: z.string().min(1),
    store_instance_id: z.string().min(1),
    repository_instance_id: z.string().min(1),
  }),
  source: z.strictObject({
    schema_version: z.number().int().positive(),
    schema_sql_sha256: sha256Hex,
    write_sequence: counter,
    intent_change_counter: counter,
  }),
  database: z.strictObject({
    file: z.literal(BACKUP_DATABASE_FILE),
    bytes: counter,
    sha256: sha256Hex,
    content_sha256: sha256Hex,
    tables: z.record(z.string(), z.strictObject({ rows: counter, sha256: sha256Hex })),
  }),
  retained_references: z.strictObject({
    git_common_directory: z.string().nullable(),
    git_references: z.array(
      z.strictObject({
        ref: z.string(),
        object_oid: z.string(),
        named_by: z.enum(['git_retention_publications', 'legacy_import.git_resources_json']),
        retention_state: z.string().nullable(),
        presence,
      })
    ),
    evidence_files: z.array(
      z.strictObject({
        relative_path: z.string(),
        sha256: z.string(),
        byte_length: counter,
        named_by: z.enum([
          'review_evidence_members',
          'pending_review_evidence_members',
          'review_semantic_terminals',
        ]),
        presence,
      })
    ),
  }),
});
const manifestSchema = manifestBody.extend({ hash: sha256Hex });
export type ProjectDatabaseBackupManifest = z.infer<typeof manifestSchema>;

export interface VerifiedBackupContent {
  readonly schemaVersion: number;
  readonly schemaSqlSha256: string;
  readonly counters: ProjectCounters;
  readonly tables: Readonly<Record<string, TableDigest>>;
  readonly contentSha256: string;
}

export interface PendingProjectDatabaseBackup {
  readonly name: string;
  readonly pendingDirectory: string;
  readonly finalDirectory: string;
  readonly content: VerifiedBackupContent;
  readonly retainedReferences: RetainedReferences;
}

export interface ProjectDatabaseBackupLocation {
  readonly name: string;
  readonly directory: string;
  readonly databaseFile: string;
  readonly manifestFile: string;
}

const hashBytes = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const exists = (file: string) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

// A project history can be hundreds of megabytes, so a file is hashed in fixed-size reads
// instead of being held in memory. Synchronously: a backup is verified between steps that must
// not interleave with other work on the same file.
const HASH_CHUNK_BYTES = 1 << 20;
function hashFile(file: string): string {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const descriptor = openSync(file, 'r');
  try {
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) return hash.digest('hex');
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
}

const NOT_REPLACED = 'the database was not replaced';
const NOT_RESTORABLE = 'it cannot be restored from';

function unverified(message: string, cause?: unknown): ProjectDatabaseError {
  return new ProjectDatabaseError('HISTORY_BACKUP_UNVERIFIED', message, { cause });
}

function unwritable(message: string, cause?: unknown): ProjectDatabaseError {
  return new ProjectDatabaseError('HISTORY_UNWRITABLE', message, { cause });
}

function syncPath(file: string): void {
  const descriptor = openSync(file, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function backupLocation(projectDirectory: string, name: string) {
  const directory = path.join(projectDirectory, BACKUP_DIRECTORY, name);
  return {
    name,
    directory,
    databaseFile: path.join(directory, BACKUP_DATABASE_FILE),
    manifestFile: path.join(directory, BACKUP_MANIFEST_FILE),
  } satisfies ProjectDatabaseBackupLocation;
}

// What a database file holds, read in one transaction so the version, the counters and every
// table digest describe the same snapshot.
export function readDatabaseContent(database: Database.Database): VerifiedBackupContent {
  database.exec('BEGIN');
  try {
    const tables = digestTables(database);
    return {
      schemaVersion: database.pragma('user_version', { simple: true }) as number,
      schemaSqlSha256: schemaSqlDigest(readSchemaObjects(database)),
      counters: readProjectCounters(database),
      tables,
      contentSha256: digestOfDigests(tables),
    };
  } finally {
    database.exec('COMMIT');
  }
}

function verifyDatabaseFile(
  file: string,
  authority: ProjectDatabaseAuthority,
  unchanged: string
): VerifiedBackupContent {
  const Constructor = loadDatabase();
  let database: Database.Database;
  try {
    database = new Constructor(file, { readonly: true, fileMustExist: true });
  } catch (cause) {
    throw unverified(`The backup cannot be opened; ${unchanged}`, cause);
  }
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok')
      throw unverified(`The backup failed its integrity check; ${unchanged}`);
    if ((database.pragma('foreign_key_check') as unknown[]).length)
      throw unverified(`The backup holds broken references; ${unchanged}`);
    validateProjectStoreIdentity(database, authority);
    return readDatabaseContent(database);
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw unverified(`The backup cannot be read back; ${unchanged}`, cause);
  } finally {
    database.close();
  }
}

function manifestFor(
  authority: ProjectDatabaseAuthority,
  backup: Omit<PendingProjectDatabaseBackup, 'finalDirectory'>,
  createdAt: string
): ProjectDatabaseBackupManifest {
  const file = path.join(backup.pendingDirectory, BACKUP_DATABASE_FILE);
  const body = manifestBody.parse({
    manifest_version: 1,
    name: backup.name,
    created_at: createdAt,
    reason: 'schema_upgrade',
    store: {
      resolved_root: authority.resolvedRoot,
      root_key: authority.rootKey,
      project_id: authority.projectId,
      store_instance_id: authority.storeInstanceId,
      repository_instance_id: authority.repositoryInstanceId,
    },
    source: {
      schema_version: backup.content.schemaVersion,
      schema_sql_sha256: backup.content.schemaSqlSha256,
      write_sequence: backup.content.counters.writeSequence,
      intent_change_counter: backup.content.counters.intentChangeCounter,
    },
    database: {
      file: BACKUP_DATABASE_FILE,
      bytes: lstatSync(file).size,
      sha256: hashFile(file),
      content_sha256: backup.content.contentSha256,
      tables: backup.content.tables,
    },
    retained_references: {
      git_common_directory: backup.retainedReferences.gitCommonDirectory,
      git_references: backup.retainedReferences.gitReferences.map((entry) => ({
        ref: entry.ref,
        object_oid: entry.objectOid,
        named_by: entry.namedBy,
        retention_state: entry.retentionState,
        presence: entry.presence,
      })),
      evidence_files: backup.retainedReferences.evidenceFiles.map((entry) => ({
        relative_path: entry.relativePath,
        sha256: entry.sha256,
        byte_length: entry.byteLength,
        named_by: entry.namedBy,
        presence: entry.presence,
      })),
    },
  });
  return { ...body, hash: hashBytes(canonicalJson(body)) };
}

// Writes the backup under a pending name and verifies it there. The source is read through its
// write-ahead log, so rows that exist only in the log are in the copy.
export async function writePendingBackup(input: {
  file: string;
  authority: ProjectDatabaseAuthority;
  gitCommonDirectory?: string | null;
}): Promise<PendingProjectDatabaseBackup> {
  const projectDirectory = path.dirname(input.file);
  const parent = path.join(projectDirectory, BACKUP_DIRECTORY);
  const id = uuidv7();
  const pendingDirectory = path.join(parent, `${PENDING_PREFIX}${id}`);
  const Constructor = loadDatabase();
  try {
    if (!exists(parent)) {
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o700);
      syncPath(projectDirectory);
    }
    mkdirSync(pendingDirectory, { mode: 0o700 });
    chmodSync(pendingDirectory, 0o700);
  } catch (cause) {
    throw new ProjectDatabaseError(
      'HISTORY_UNWRITABLE',
      'The backup directory cannot be created beside the database; nothing was changed',
      { cause }
    );
  }
  try {
    const file = path.join(pendingDirectory, BACKUP_DATABASE_FILE);
    let source: Database.Database;
    try {
      source = new Constructor(input.file, { readonly: true, fileMustExist: true, timeout: 100 });
    } catch (cause) {
      throw databaseValidationFailure(cause);
    }
    try {
      await source.backup(file);
    } catch (cause) {
      throw unverified('The backup could not be written; nothing was changed', cause);
    } finally {
      source.close();
    }
    // The copy inherits the source's journal mode. As a rollback-journal file it is complete on
    // its own, and reading it back creates no log or shared-memory file beside it.
    const copy = new Constructor(file, { fileMustExist: true });
    try {
      if (copy.pragma('journal_mode = DELETE', { simple: true }) !== 'delete')
        throw unverified('The backup could not be made self-contained; nothing was changed');
    } finally {
      copy.close();
    }
    chmodSync(file, 0o600);
    syncPath(file);
    const content = verifyDatabaseFile(file, input.authority, 'nothing was changed');

    const inspected = new Constructor(file, { readonly: true, fileMustExist: true });
    let retainedReferences: RetainedReferences;
    try {
      retainedReferences = inspectRetainedReferences(inspected, {
        projectDirectory,
        gitCommonDirectory: input.gitCommonDirectory,
      });
    } finally {
      inspected.close();
    }
    const name = `schema-${content.schemaVersion}-${id}`;
    const pending = { name, pendingDirectory, content, retainedReferences };
    const manifestFile = path.join(pendingDirectory, BACKUP_MANIFEST_FILE);
    writeFileSync(
      manifestFile,
      `${JSON.stringify(manifestFor(input.authority, pending, new Date().toISOString()), null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    );
    chmodSync(manifestFile, 0o600);
    syncPath(manifestFile);
    syncPath(pendingDirectory);
    return { ...pending, finalDirectory: path.join(parent, name) };
  } catch (cause) {
    discardPendingBackup(pendingDirectory);
    // Nothing here has touched the database, so even a bare filesystem failure leaves as a
    // refusal that says so rather than as whatever the platform raised.
    throw cause instanceof ProjectDatabaseError
      ? cause
      : new ProjectDatabaseError(
          'HISTORY_UNWRITABLE',
          'The backup could not be written beside the database; nothing was changed',
          { cause }
        );
  }
}

// Only ever given a pending directory this operation created: a published backup is never removed.
export function discardPendingBackup(pendingDirectory: string): void {
  if (!path.basename(pendingDirectory).startsWith(PENDING_PREFIX)) return;
  rmSync(pendingDirectory, { recursive: true, force: true });
}

export function publishPendingBackup(
  backup: PendingProjectDatabaseBackup
): ProjectDatabaseBackupLocation {
  renameSync(backup.pendingDirectory, backup.finalDirectory);
  syncPath(path.dirname(backup.finalDirectory));
  return backupLocation(path.dirname(path.dirname(backup.finalDirectory)), backup.name);
}

export interface ReusableProjectDatabaseBackup {
  readonly location: ProjectDatabaseBackupLocation;
  readonly content: VerifiedBackupContent;
  readonly retainedReferences: RetainedReferences;
}

// A backup this database already has: one published earlier that holds it exactly as it is now.
// A transition that refuses leaves its verified backup behind, so without this every retry of a
// database the transition keeps refusing would publish another full copy of it.
//
// The candidate is verified again here the way a restore verifies the one it is about to put
// back: its file against the hash its manifest records, then what it holds against that manifest.
// Nothing is written, and a candidate that fails any of it is passed over rather than refused,
// because copying the database again is always available and is what this saves, never
// something it is allowed to skip.
export function reusablePublishedBackup(input: {
  file: string;
  authority: ProjectDatabaseAuthority;
  gitCommonDirectory?: string | null;
}): ReusableProjectDatabaseBackup | null {
  const projectDirectory = path.dirname(input.file);
  const parent = path.join(projectDirectory, BACKUP_DIRECTORY);
  if (!exists(parent)) return null;
  // Newest first: a backup directory is named for the UUIDv7 it was taken under.
  const candidates = readdirSync(parent)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse()
    .flatMap((name) => {
      const location = backupLocation(projectDirectory, name);
      try {
        const manifest = readManifest(location, NOT_RESTORABLE);
        return manifest.store.project_id === input.authority.projectId &&
          manifest.store.store_instance_id === input.authority.storeInstanceId &&
          manifest.store.repository_instance_id === input.authority.repositoryInstanceId
          ? [{ location, manifest }]
          : [];
      } catch {
        return [];
      }
    });
  if (candidates.length === 0) return null;

  const Constructor = loadDatabase();
  let source: Database.Database;
  try {
    source = new Constructor(input.file, { readonly: true, fileMustExist: true, timeout: 100 });
  } catch (cause) {
    throw databaseValidationFailure(cause);
  }
  let matching: typeof candidates;
  try {
    // One read transaction, so the counters, the definition and the rows a manifest is held
    // against are the same snapshot of the source.
    source.exec('BEGIN');
    try {
      const schemaVersion = source.pragma('user_version', { simple: true }) as number;
      const schemaSqlSha256 = schemaSqlDigest(readSchemaObjects(source));
      const counters = readProjectCounters(source);
      matching = candidates.filter(
        ({ manifest }) =>
          manifest.source.schema_version === schemaVersion &&
          manifest.source.schema_sql_sha256 === schemaSqlSha256 &&
          manifest.source.write_sequence === counters.writeSequence &&
          manifest.source.intent_change_counter === counters.intentChangeCounter
      );
      // The content digest is a pass over every row, so it is taken only once a manifest agrees
      // about what is cheap to read.
      if (matching.length > 0) {
        const contentSha256 = digestOfDigests(digestTables(source));
        matching = matching.filter(
          ({ manifest }) => manifest.database.content_sha256 === contentSha256
        );
      }
    } finally {
      if (source.inTransaction) source.exec('COMMIT');
    }
  } catch (cause) {
    throw databaseValidationFailure(cause);
  } finally {
    source.close();
  }

  for (const { location, manifest } of matching) {
    try {
      if (hashFile(location.databaseFile) !== manifest.database.sha256) continue;
      const content = verifyDatabaseFile(
        location.databaseFile,
        input.authority,
        'nothing was changed'
      );
      if (
        content.schemaVersion !== manifest.source.schema_version ||
        content.schemaSqlSha256 !== manifest.source.schema_sql_sha256 ||
        content.counters.writeSequence !== manifest.source.write_sequence ||
        content.counters.intentChangeCounter !== manifest.source.intent_change_counter ||
        content.contentSha256 !== manifest.database.content_sha256 ||
        canonicalJson(content.tables) !== canonicalJson(manifest.database.tables)
      )
        continue;
      // What the database names outside itself is looked up now rather than read from the
      // manifest, because a caller is told what is missing today, not what was missing when the
      // copy was taken. The manifest itself is never rewritten.
      const inspected = new Constructor(location.databaseFile, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        return {
          location,
          content,
          retainedReferences: inspectRetainedReferences(inspected, {
            projectDirectory,
            gitCommonDirectory: input.gitCommonDirectory,
          }),
        };
      } finally {
        inspected.close();
      }
    } catch {
      continue;
    }
  }
  return null;
}

// `unusable` names what the caller loses by the manifest being unreadable, because the same
// refusal is raised on the way to a restore and while listing what could be restored.
function readManifest(
  location: ProjectDatabaseBackupLocation,
  unusable: string
): ProjectDatabaseBackupManifest {
  let parsed: ProjectDatabaseBackupManifest;
  try {
    parsed = manifestSchema.parse(JSON.parse(readFileSync(location.manifestFile, 'utf8')));
  } catch (cause) {
    throw unverified(`The backup has no readable manifest; ${unusable}`, cause);
  }
  const { hash, ...body } = parsed;
  if (hash !== hashBytes(canonicalJson(body)) || parsed.name !== location.name)
    throw unverified(`The backup manifest does not match its hash; ${unusable}`);
  return parsed;
}

export interface ProjectDatabaseBackupSummary extends ProjectDatabaseBackupLocation {
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly counters: ProjectCounters;
}

// A directory of the published shape whose manifest cannot be read. It is listed with the reason
// rather than dropped: someone looking for their backup has to see that it is there and why it
// cannot be used, not an empty list.
export interface UnreadableProjectDatabaseBackup extends ProjectDatabaseBackupLocation {
  readonly unreadable: string;
}

export type ListedProjectDatabaseBackup =
  | (ProjectDatabaseBackupSummary & { readonly unreadable?: undefined })
  | UnreadableProjectDatabaseBackup;

// Lists what the manifests say. A backup is verified when it is restored, not when it is listed.
export async function listProjectDatabaseBackups(input: {
  authority: ProjectDatabaseAuthority;
}): Promise<ListedProjectDatabaseBackup[]> {
  const file = await validateProjectDatabaseLocation(input.authority);
  const projectDirectory = path.dirname(file);
  const parent = path.join(projectDirectory, BACKUP_DIRECTORY);
  if (!exists(parent)) return [];
  return readdirSync(parent)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .map((name) => {
      const location = backupLocation(projectDirectory, name);
      try {
        const manifest = readManifest(location, NOT_RESTORABLE);
        return {
          ...location,
          createdAt: manifest.created_at,
          schemaVersion: manifest.source.schema_version,
          counters: {
            writeSequence: manifest.source.write_sequence,
            intentChangeCounter: manifest.source.intent_change_counter,
          },
        };
      } catch (cause) {
        return { ...location, unreadable: (cause as Error).message };
      }
    });
}

export interface RestoreProjectDatabaseBackupResult {
  readonly backup: ProjectDatabaseBackupSummary;
  readonly databasePath: string;
  // The database that was in place, kept whole under this name until the caller removes it.
  // Null when no database file was there.
  readonly replaced: {
    readonly databaseFile: string;
    readonly schemaVersion: number | null;
    readonly counters: ProjectCounters | null;
  } | null;
  // Everything written after the backup was taken exists only in the replaced database.
  readonly workWrittenAfterBackup: 'not-restored';
  // What another session could do while the file in place was exchanged. `refused-across-the-swap`
  // is the database held for this restore alone, from the moment it was proved idle until the
  // restored file took its place. `nothing-to-lock` is a file that could not be opened as this
  // store, or no file at all, which is a database no lock could have been taken on.
  readonly otherSessions: 'refused-across-the-swap' | 'nothing-to-lock';
}

// The points at which a restore can be interrupted, in the order it reaches them. A caller that
// stops at one of them leaves the project directory with a database it can still open: the one
// in place until `backup-in-place`, and the restored one after it.
export type ProjectDatabaseRestoreStage =
  | 'backup-staged'
  | 'database-settled'
  | 'database-set-aside'
  | 'log-set-aside'
  | 'backup-in-place';

interface SettledDatabase {
  readonly schemaVersion: number | null;
  readonly counters: ProjectCounters | null;
  // Open and inside its own write transaction until the restored file is in place. Null when the
  // file in place could not be opened as this store, so there was no lock to take.
  readonly writeLock: Database.Database | null;
}

const UNREADABLE_IN_PLACE = { schemaVersion: null, counters: null, writeLock: null } as const;

// What the database in place says about itself, or null when it says nothing this store can
// read. Read through a read-only connection on purpose: a file a restore exists for is set aside
// exactly as it is, and a connection opened for writing folds its log into the main file and
// deletes the log when it closes, whether or not it could read a row.
function inspectCurrentDatabase(
  file: string,
  authority: ProjectDatabaseAuthority
): Omit<SettledDatabase, 'writeLock'> | null {
  let reader: Database.Database;
  try {
    reader = new (loadDatabase())(file, { readonly: true, fileMustExist: true, timeout: 100 });
  } catch {
    return null;
  }
  try {
    validateProjectStoreIdentity(reader, authority);
    return {
      schemaVersion: reader.pragma('user_version', { simple: true }) as number,
      counters: readProjectCounters(reader),
    };
  } catch (cause) {
    if (
      cause instanceof ProjectDatabaseError &&
      (cause.code === 'AUTHORITY_MISMATCH' || cause.code === 'HISTORY_MISSING')
    )
      throw new ProjectDatabaseError(
        cause.code,
        `The database in place belongs to a different store; ${NOT_REPLACED}`,
        { cause }
      );
    if (isDatabaseContention(cause)) throw inUse();
    return null;
  } finally {
    reader.close();
  }
}

const unheld = (cause: unknown) =>
  new ProjectDatabaseError(
    'HISTORY_INACCESSIBLE',
    `The database in place could not be held for the swap; ${NOT_REPLACED}`,
    { cause }
  );

// Takes the database being replaced for this restore alone and folds its log into the main file,
// so it is whole as one file and nothing can write to it while it is exchanged.
//
// Exclusive locking mode is what makes that hold mean anything. A truncating checkpoint on its
// own reports the database idle whenever the log is empty, even with another session sitting in
// a read transaction, and the write lock a transaction takes excludes writers but not readers.
// Under exclusive locking mode the first statement takes a lock on the database file that any
// other open connection refuses, and it refuses before reading or writing a byte, so a database
// something else is using is left exactly as it was. A database that cannot be read is what a
// restore is for: it is set aside as it is, with whatever log it has, and nothing here writes to
// it or locks it.
async function settleCurrentDatabase(
  file: string,
  authority: ProjectDatabaseAuthority,
  busyTimeoutMs: number,
  signal?: AbortSignal
): Promise<SettledDatabase> {
  const current = inspectCurrentDatabase(file, authority);
  if (!current) return UNREADABLE_IN_PLACE;
  let database: Database.Database;
  try {
    database = new (loadDatabase())(file, { fileMustExist: true, timeout: 100 });
  } catch (cause) {
    throw unheld(cause);
  }
  let locked = false;
  try {
    if (database.pragma('locking_mode = EXCLUSIVE', { simple: true }) !== 'exclusive')
      throw unheld(new Error('This build of SQLite does not offer exclusive locking'));
    const deadline = Date.now() + busyTimeoutMs;
    for (;;) {
      try {
        if ((database.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0]?.busy === 0) {
          database.exec('BEGIN IMMEDIATE');
          locked = true;
          return { ...current, writeLock: database };
        }
      } catch (cause) {
        if (!isDatabaseContention(cause)) throw unheld(cause);
      }
      if (Date.now() >= deadline) throw inUse();
      try {
        await delay(25, undefined, { signal });
      } catch {
        throw new ProjectDatabaseError('CANCELLED', `Restore cancelled; ${NOT_REPLACED}`);
      }
    }
  } finally {
    if (!locked) database.close();
  }
}

// Closing rolls the empty write transaction back. Nothing may release the lock before the
// restored file is in place: until then the path still names the database being set aside, and a
// session that began writing there would write into a file about to leave.
function releaseWriteLock(settled: SettledDatabase | null): void {
  const lock = settled?.writeLock;
  if (!lock) return;
  try {
    if (lock.inTransaction) lock.exec('ROLLBACK');
    lock.close();
  } catch {
    // The lock has no work left to do, so failing to put it down decides nothing.
  }
}

function inUse(): ProjectDatabaseError {
  return new ProjectDatabaseError(
    'TRANSACTION_RETRY_EXHAUSTED',
    `The database is in use; close other sessions and retry; ${NOT_REPLACED}`
  );
}

// A backup whose own rows name another store cannot take this store's place, whatever its
// manifest claims. The refusal keeps its code and gains the sentence every restore failure owes
// its caller: what state the database is in.
function verifiedBackupContent(
  file: string,
  authority: ProjectDatabaseAuthority
): VerifiedBackupContent {
  try {
    return verifyDatabaseFile(file, authority, NOT_REPLACED);
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && !cause.message.endsWith(NOT_REPLACED))
      throw new ProjectDatabaseError(cause.code, `${cause.message}; ${NOT_REPLACED}`, { cause });
    throw cause;
  }
}

// Copies the backup beside the database under a name of this run's own and admits it only when
// the file, its manifest and the manifest's own hash all agree. Nothing here touches the
// database in place.
function stageVerifiedCopy(
  location: ProjectDatabaseBackupLocation,
  manifest: ProjectDatabaseBackupManifest,
  incoming: string,
  authority: ProjectDatabaseAuthority
): VerifiedBackupContent {
  if (!exists(location.databaseFile))
    throw unverified(`The backup has no database file beside its manifest; ${NOT_REPLACED}`);
  try {
    copyFileSync(location.databaseFile, incoming, constants.COPYFILE_EXCL);
    chmodSync(incoming, 0o600);
    if (hashFile(incoming) !== manifest.database.sha256)
      throw unverified(`The backup differs from its manifest; ${NOT_REPLACED}`);
    const content = verifiedBackupContent(incoming, authority);
    if (
      content.schemaVersion !== manifest.source.schema_version ||
      content.schemaSqlSha256 !== manifest.source.schema_sql_sha256 ||
      content.counters.writeSequence !== manifest.source.write_sequence ||
      content.counters.intentChangeCounter !== manifest.source.intent_change_counter ||
      content.contentSha256 !== manifest.database.content_sha256 ||
      canonicalJson(content.tables) !== canonicalJson(manifest.database.tables)
    )
      throw unverified(`The backup differs from its manifest; ${NOT_REPLACED}`);

    // A project database is a write-ahead-log database; the backup was kept as a single file.
    const writer = new (loadDatabase())(incoming, { fileMustExist: true });
    try {
      configureWriter(writer);
    } finally {
      writer.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${incoming}${suffix}`, { force: true });
    syncPath(incoming);
    return content;
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError) throw cause;
    throw unwritable(`The backup could not be put beside the database; ${NOT_REPLACED}`, cause);
  }
}

// This run's own file, and failing to remove it must never hide why the restore failed.
function discardStagedCopy(incoming: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    try {
      rmSync(`${incoming}${suffix}`, { force: true });
    } catch {
      // Leaving the file behind matters less than the failure on its way to the caller.
    }
}

// Once the last rename is made the backup is the database, whatever fails next. A caller told
// anything else would look for its work in the wrong file.
function replacedAlready(
  cause: unknown,
  file: string,
  replacedFile: string | null
): ProjectDatabaseError {
  return unwritable(
    `The restore failed after the database was replaced: the backup is now ${file}${
      replacedFile ? `, and the database it replaced is kept at ${replacedFile}` : ''
    }`,
    cause
  );
}

// Puts back whatever moved beside the database and says which of the two states the project is
// in, because the difference decides where the caller looks for its history.
function movedBack(
  cause: unknown,
  file: string,
  replacedFile: string,
  moved: readonly string[]
): ProjectDatabaseError {
  try {
    for (const suffix of moved) renameSync(`${replacedFile}${suffix}`, `${file}${suffix}`);
    rmSync(replacedFile, { force: true });
  } catch (recovery) {
    return unwritable(
      `The database in place could not be exchanged for the backup, and what had moved beside it could not be moved back; ${NOT_REPLACED}, and the rest of it is beside ${replacedFile}`,
      new AggregateError([cause, recovery], 'The restore and its recovery both failed')
    );
  }
  return unwritable(
    `The database in place could not be exchanged for the backup; ${NOT_REPLACED}`,
    cause
  );
}

// Replaces the database in place with a verified copy of one of its backups.
//
// What the swap promises about other sessions: the database being replaced is held for this
// restore alone, from the moment it is proved idle until the restored file has taken its place.
// A session that already has it open is refused before anything moves, with `close other
// sessions and retry`, and one that opens it while the swap is under way is refused too, so
// nothing is ever told a write succeeded into a file that is then set aside. The promise covers
// only a database this store can read: a file it cannot open is set aside exactly as it is, and
// a session holding that file is beyond reach, which is the difference `otherSessions` reports.
// Everything written after the backup was taken is in the set-aside file and nowhere in the
// restored one, which is what `workWrittenAfterBackup` says.
export async function restoreDatabaseFileBackup(
  input: {
    file: string;
    authority: ProjectDatabaseAuthority;
    backup: string;
    busyTimeoutMs?: number;
    signal?: AbortSignal;
  },
  observe: (stage: ProjectDatabaseRestoreStage) => void = () => {}
): Promise<RestoreProjectDatabaseBackupResult> {
  if (!BACKUP_NAME.test(input.backup))
    throw new ProjectDatabaseError('INVALID_INPUT', 'Name a backup of this project database');
  const projectDirectory = path.dirname(input.file);
  const location = backupLocation(projectDirectory, input.backup);
  const manifest = readManifest(location, NOT_REPLACED);
  if (
    manifest.store.project_id !== input.authority.projectId ||
    manifest.store.store_instance_id !== input.authority.storeInstanceId ||
    manifest.store.repository_instance_id !== input.authority.repositoryInstanceId
  )
    throw new ProjectDatabaseError(
      'AUTHORITY_MISMATCH',
      `The backup belongs to a different store; ${NOT_REPLACED}`
    );

  const id = uuidv7();
  const incoming = `${input.file}.restoring-${id}`;
  const replacedFile = `${input.file}.replaced-${id}`;
  try {
    const content = stageVerifiedCopy(location, manifest, incoming, input.authority);
    observe('backup-staged');

    const settled = exists(input.file)
      ? await settleCurrentDatabase(
          input.file,
          input.authority,
          input.busyTimeoutMs ?? 5_000,
          input.signal
        )
      : null;
    const otherSessions = settled?.writeLock ? 'refused-across-the-swap' : 'nothing-to-lock';
    observe('database-settled');

    const moved: string[] = [];
    let inPlace = false;
    try {
      // The database in place takes a second name before it loses its first, so no interruption
      // leaves the project directory without one. A log left beside the new main file would be
      // replayed into it, so the log and the shared-memory file move aside with the main file
      // they belong to before the new one arrives.
      if (settled) linkSync(input.file, replacedFile);
      observe('database-set-aside');
      for (const suffix of ['-wal', '-shm', '-journal'])
        if (exists(`${input.file}${suffix}`)) {
          renameSync(`${input.file}${suffix}`, `${replacedFile}${suffix}`);
          moved.push(suffix);
        }
      observe('log-set-aside');
      renameSync(incoming, input.file);
      inPlace = true;
      observe('backup-in-place');
    } catch (cause) {
      throw inPlace
        ? replacedAlready(cause, input.file, settled ? replacedFile : null)
        : movedBack(cause, input.file, replacedFile, moved);
    } finally {
      releaseWriteLock(settled);
    }
    try {
      syncPath(projectDirectory);
    } catch (cause) {
      throw replacedAlready(cause, input.file, settled ? replacedFile : null);
    }

    return {
      backup: {
        ...location,
        createdAt: manifest.created_at,
        schemaVersion: manifest.source.schema_version,
        counters: content.counters,
      },
      databasePath: input.file,
      replaced: settled
        ? {
            databaseFile: replacedFile,
            schemaVersion: settled.schemaVersion,
            counters: settled.counters,
          }
        : null,
      workWrittenAfterBackup: 'not-restored',
      otherSessions,
    };
  } catch (cause) {
    discardStagedCopy(incoming);
    throw cause;
  }
}

export async function restoreProjectDatabaseBackup(input: {
  authority: ProjectDatabaseAuthority;
  backup: string;
  busyTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<RestoreProjectDatabaseBackupResult> {
  const authority = Object.freeze({ ...input.authority });
  const file = await validateProjectDatabaseLocation(authority);
  return restoreDatabaseFileBackup({ ...input, authority, file });
}
