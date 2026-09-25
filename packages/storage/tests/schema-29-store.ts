// Puts a frozen schema-29 database where this checkout can address it as a store.
//
// A fixture's bytes name the root its producer wrote them under, and that root is gone, so the
// one cell that says where the store lives is rewritten. Everything else is carried across as
// it was: the copy is taken while the connection that rewrote it is still open, because closing
// the last connection folds the write-ahead log into the main file, and a database placed from
// a released fixture has to keep holding the rows that exist only in its log.
import Database from 'better-sqlite3';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { materializeOriginalDatabase } from './released-fixture.mjs';
import { restoreSyntheticFixture } from './synthetic-fixture.mjs';
import type { ProjectDatabaseAuthority } from '../src/history/database/connection.js';
import { normalizeHistoryRoot } from '../src/history/paths.js';

const DATABASE_FILE = 'history.sqlite3';
const EVIDENCE_DIRECTORY = 'evidence';
const IDENTITY_GUARD = 'store_identity_no_update';

export interface Schema29Template {
  readonly name: string;
  readonly directory: string;
  readonly projectId: string;
  readonly storeInstanceId: string;
  readonly repositoryInstanceId: string;
  // The write-ahead log exactly as the fixture left it, before anything here opened the file.
  readonly logBytes: number;
  discard(): void;
}

export interface PlacedSchema29Database {
  readonly file: string;
  readonly projectDirectory: string;
  readonly authority: ProjectDatabaseAuthority;
  discard(): void;
}

const byteSize = (file: string) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;

function storeIdentity(file: string) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database.prepare('SELECT * FROM store_identity WHERE singleton = 1').get() as {
      project_id: string;
      store_instance_id: string;
      repository_instance_id: string;
    };
  } finally {
    database.close();
  }
}

function describeTemplate(name: string, directory: string, discard: () => void): Schema29Template {
  const file = path.join(directory, DATABASE_FILE);
  const logBytes = byteSize(`${file}-wal`);
  const identity = storeIdentity(file);
  return {
    name,
    directory,
    projectId: identity.project_id,
    storeInstanceId: identity.store_instance_id,
    repositoryInstanceId: identity.repository_instance_id,
    logBytes,
    discard,
  };
}

// The main file and write-ahead log of a released build, decompressed once for the whole file.
export async function releasedSchema29Template(name: string): Promise<Schema29Template> {
  const original = await materializeOriginalDatabase(name);
  try {
    return describeTemplate(name, original.directory, () => {
      rmSync(original.directory, { recursive: true, force: true });
    });
  } catch (cause) {
    await original.cleanup();
    throw cause;
  }
}

export async function syntheticSchema29Template(candidate: string): Promise<Schema29Template> {
  const restored = await restoreSyntheticFixture(candidate);
  const directory = await mkdtemp(path.join(tmpdir(), 'schema-29-synthetic-'));
  try {
    copyBeside(path.dirname(restored.file), directory);
    return describeTemplate('synthetic schema 29', directory, () => {
      rmSync(directory, { recursive: true, force: true });
    });
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true });
    throw cause;
  } finally {
    await restored.cleanup();
  }
}

function copyBeside(from: string, to: string): void {
  copyFileSync(path.join(from, DATABASE_FILE), path.join(to, DATABASE_FILE));
  const log = path.join(from, `${DATABASE_FILE}-wal`);
  if (existsSync(log)) copyFileSync(log, path.join(to, `${DATABASE_FILE}-wal`));
  const evidence = path.join(from, EVIDENCE_DIRECTORY);
  if (existsSync(evidence))
    cpSync(evidence, path.join(to, EVIDENCE_DIRECTORY), { recursive: true });
}

export async function placeSchema29Database(
  template: Schema29Template
): Promise<PlacedSchema29Database> {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'schema-29-store-')),
  });
  const discard = () => rmSync(root.resolvedRoot, { recursive: true, force: true });
  const work = await mkdtemp(path.join(tmpdir(), 'schema-29-rewrite-'));
  try {
    const projectDirectory = path.join(root.resolvedRoot, 'projects', template.projectId);
    mkdirSync(projectDirectory, { recursive: true });
    copyBeside(template.directory, work);

    const database = new Database(path.join(work, DATABASE_FILE), { fileMustExist: true });
    try {
      database.pragma('wal_autocheckpoint = 0');
      const guard = (
        database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(IDENTITY_GUARD) as
          | { sql: string }
          | undefined
      )?.sql;
      if (guard) database.exec(`DROP TRIGGER ${IDENTITY_GUARD}`);
      database
        .prepare('UPDATE store_identity SET resolved_root = ?, root_key = ? WHERE singleton = 1')
        .run(root.resolvedRoot, root.rootKey);
      if (guard) database.exec(guard);
      copyBeside(work, projectDirectory);
    } finally {
      database.close();
    }
    return {
      file: path.join(projectDirectory, DATABASE_FILE),
      projectDirectory,
      authority: {
        ...root,
        projectId: template.projectId,
        storeInstanceId: template.storeInstanceId,
        repositoryInstanceId: template.repositoryInstanceId,
      },
      discard,
    };
  } catch (cause) {
    discard();
    throw cause;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
