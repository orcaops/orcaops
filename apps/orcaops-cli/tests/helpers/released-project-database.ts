// Puts a real released schema-29 database under a registered project.
//
// The released bytes name their producer's store, so the one row that says which store this is
// gets this project's identity and nothing else changes. The copy is taken while the connection
// that rewrote it is still open and automatic checkpointing is off, because closing the last
// connection folds the write-ahead log into the main file, and a released database has rows that
// exist only in its log.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ProjectDatabase } from '@orcaops/storage/history/database';

import { materializeOriginalDatabase } from '../../../../packages/storage/tests/released-fixture.mjs';

const RELEASE = '0.2.1';
const IMMUTABLE_ROW_GUARDS = ['store_identity_no_update', 'activation_no_update'];

interface StoreIdentityRow {
  resolved_root: string;
  root_key: string;
  project_id: string;
  store_instance_id: string;
  repository_instance_id: string;
  initialization_operation_id: string;
}

function guardDefinitions(database: Database.Database) {
  return IMMUTABLE_ROW_GUARDS.flatMap((name) => {
    const row = database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(name) as
      | { sql: string }
      | undefined;
    return row ? [{ name, sql: row.sql }] : [];
  });
}

/**
 * Replaces a fixture project's database with the one a released package wrote, carrying this
 * project's identity across so every registration, catalog and authority comparison still holds.
 * The writer the fixture holds is closed first; the file it pointed at is gone afterwards.
 */
export async function placeReleasedProjectDatabase(writer: ProjectDatabase): Promise<void> {
  const file = writer.databasePath;
  const identity = writer.read((view) => ({
    store: view.get<StoreIdentityRow>('SELECT * FROM store_identity WHERE singleton = 1')!,
    initializedAt: view.get<{ initialized_at: string }>(
      'SELECT initialized_at FROM activation WHERE singleton = 1'
    )!.initialized_at,
  })).value;
  writer.close();

  const original = await materializeOriginalDatabase(RELEASE);
  const work = await mkdtemp(path.join(tmpdir(), 'released-project-database-'));
  try {
    const working = path.join(work, 'history.sqlite3');
    await copyFile(original.main, working);
    if (existsSync(`${original.main}-wal`))
      await copyFile(`${original.main}-wal`, `${working}-wal`);

    const database = new Database(working, { fileMustExist: true });
    try {
      database.pragma('wal_autocheckpoint = 0');
      const guards = guardDefinitions(database);
      for (const guard of guards) database.exec(`DROP TRIGGER ${guard.name}`);
      database
        .prepare(
          `UPDATE store_identity SET resolved_root = ?, root_key = ?, project_id = ?,
             store_instance_id = ?, repository_instance_id = ?, initialization_operation_id = ?
           WHERE singleton = 1`
        )
        .run(
          identity.store.resolved_root,
          identity.store.root_key,
          identity.store.project_id,
          identity.store.store_instance_id,
          identity.store.repository_instance_id,
          identity.store.initialization_operation_id
        );
      database
        .prepare('UPDATE activation SET initialized_at = ? WHERE singleton = 1')
        .run(identity.initializedAt);
      for (const guard of guards) database.exec(guard.sql);

      for (const suffix of ['', '-wal', '-shm']) await rm(`${file}${suffix}`, { force: true });
      await copyFile(working, file);
      if (existsSync(`${working}-wal`)) await copyFile(`${working}-wal`, `${file}-wal`);
    } finally {
      database.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
    await original.cleanup();
  }
}
