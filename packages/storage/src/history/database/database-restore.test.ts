import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openProjectDatabase, type ProjectCounters, readProjectCounters } from './connection.js';
import {
  BACKUP_DATABASE_FILE,
  BACKUP_DIRECTORY,
  BACKUP_MANIFEST_FILE,
  listProjectDatabaseBackups,
  type ProjectDatabaseRestoreStage,
  restoreDatabaseFileBackup,
  restoreProjectDatabaseBackup,
} from './database-backup.js';
import { retainProjectDisplayName } from './project-name.js';
import {
  readSchemaObjects,
  RELEASED_SCHEMA_SQL_SHA256,
  RELEASED_SCHEMA_VERSION,
  schemaSqlDigest,
} from './released-schema.js';
import { previewDatabaseFileUpgrade, upgradeDatabaseFile } from './schema-upgrade.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { type FixtureSnapshot, snapshot } from '../../../tests/database-fixture.mjs';
import {
  type PlacedSchema29Database,
  placeSchema29Database,
  type Schema29Template,
  syntheticSchema29Template,
} from '../../../tests/schema-29-store.js';
import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';

type Manifest = {
  hash: string;
  created_at: string;
  store: { project_id: string };
  database: { sha256: string; content_sha256: string; tables: Record<string, TableDigestJson> };
};
type TableDigestJson = { rows: number; sha256: string };

const CANDIDATE = new URL('../../../../../', import.meta.url).pathname;
const RESTORE_MODULE = new URL('../../../dist/history/database/database-backup.js', import.meta.url)
  .href;
const DISPLAY_NAME = 'Named after the backup was taken';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/;

let template: Schema29Template;
const placements: PlacedSchema29Database[] = [];
const scratch: string[] = [];

beforeAll(async () => {
  template = await syntheticSchema29Template(CANDIDATE);
}, 120_000);

afterAll(() => template.discard());

afterEach(async () => {
  for (const placement of placements.splice(0)) placement.discard();
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

function reading<T>(file: string, read: (database: Database.Database) => T): T {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const digestOfFile = (file: string) =>
  existsSync(file) && statSync(file).size > 0 ? sha256(readFileSync(file)) : null;
// The main file and the write-ahead log together are the database; a refusal has to leave both
// exactly as they were. SQLite recreates an empty log beside a file it opens, so an empty log
// and no log are the same database.
const fingerprint = (file: string) => ({
  main: digestOfFile(file),
  log: digestOfFile(`${file}-wal`),
});
const counters = (file: string) => reading(file, readProjectCounters);
const definitionDigest = (file: string) =>
  reading(file, (database) => schemaSqlDigest(readSchemaObjects(database)));
// Everything this restore makes beside the database, with the run's own identifier folded away.
const besideDatabase = (store: PlacedSchema29Database) =>
  readdirSync(store.projectDirectory)
    .filter((name) => name.startsWith(`${path.basename(store.file)}.`))
    .map((name) => name.replace(UUID, '<id>'))
    .sort();
const holdsOperation = (rows: FixtureSnapshot['rows'], operationId: string) =>
  rows.operations!.some((row) => row.operation_id === operationId);

interface RestorableStore {
  readonly store: PlacedSchema29Database;
  readonly backup: string;
  readonly released: FixtureSnapshot;
  readonly releasedCounters: ProjectCounters;
  readonly newer: FixtureSnapshot;
  readonly newerCounters: ProjectCounters;
  // The one authored record written after the backup was taken: the work a restore must neither
  // bring back nor lose.
  readonly writtenAfterTheBackup: string;
}

async function upgradedWithNewerWork(): Promise<RestorableStore> {
  const store = await placeSchema29Database(template);
  placements.push(store);
  const released = snapshot(Database, store.file);
  const releasedCounters = counters(store.file);
  const result = await upgradeDatabaseFile({ file: store.file, authority: store.authority });
  if (result.outcome !== 'upgraded') throw new Error(`The upgrade reported ${result.outcome}`);

  const writtenAfterTheBackup = uuidv7();
  const handle = await openProjectDatabase({ authority: store.authority, mode: 'writer' });
  try {
    await retainProjectDisplayName(handle, {
      operationId: writtenAfterTheBackup,
      displayName: DISPLAY_NAME,
    });
  } finally {
    handle.close();
  }
  const newer = snapshot(Database, store.file);
  if (!holdsOperation(newer.rows, writtenAfterTheBackup))
    throw new Error('The newer work was not written into the upgraded database');
  return {
    store,
    backup: result.backup.name,
    released,
    releasedCounters,
    newer,
    newerCounters: counters(store.file),
    writtenAfterTheBackup,
  };
}

const backupDirectory = (store: PlacedSchema29Database, name: string) =>
  path.join(store.projectDirectory, BACKUP_DIRECTORY, name);
const manifestFile = (store: PlacedSchema29Database, name: string) =>
  path.join(backupDirectory(store, name), BACKUP_MANIFEST_FILE);
const readManifest = (store: PlacedSchema29Database, name: string) =>
  JSON.parse(readFileSync(manifestFile(store, name), 'utf8')) as Manifest;
const writeManifest = (store: PlacedSchema29Database, name: string, manifest: Manifest) =>
  writeFileSync(manifestFile(store, name), `${JSON.stringify(manifest, null, 2)}\n`);
// The manifest carries a hash over its own body, so a change a caller wants the rest of the
// verification to judge has to be signed the way the backup signed itself.
function resign(manifest: Manifest): Manifest {
  const { hash: _hash, ...body } = manifest;
  return { ...body, hash: sha256(canonicalJson(body)) } as Manifest;
}

it('puts the backup in place, keeps the newer work in the file it sets aside, and upgrades again', async () => {
  const prepared = await upgradedWithNewerWork();
  const { store, released, newer } = prepared;
  expect(newer.version).toBe(PROJECT_DATABASE_SCHEMA_VERSION);

  const result = await restoreProjectDatabaseBackup({
    authority: store.authority,
    backup: prepared.backup,
  });

  expect(result).toMatchObject({
    databasePath: store.file,
    workWrittenAfterBackup: 'not-restored',
    otherSessions: 'refused-across-the-swap',
    backup: {
      name: prepared.backup,
      schemaVersion: RELEASED_SCHEMA_VERSION,
      counters: prepared.releasedCounters,
    },
    replaced: {
      databaseFile: `${store.file}.replaced-${result.replaced!.databaseFile.split('.replaced-')[1]!}`,
      schemaVersion: PROJECT_DATABASE_SCHEMA_VERSION,
      counters: prepared.newerCounters,
    },
  });
  // The rows themselves, not the digests the restore compared: the database in place is the one
  // the backup holds, down to its released definition.
  expect(snapshot(Database, store.file)).toEqual(released);
  expect(definitionDigest(store.file)).toBe(RELEASED_SCHEMA_SQL_SHA256);
  expect(counters(store.file)).toEqual(prepared.releasedCounters);
  expect(holdsOperation(snapshot(Database, store.file).rows, prepared.writtenAfterTheBackup)).toBe(
    false
  );

  // What the backup does not hold was not lost with it: it is whole in the file set aside.
  expect(snapshot(Database, result.replaced!.databaseFile)).toEqual(newer);
  expect(
    holdsOperation(
      snapshot(Database, result.replaced!.databaseFile).rows,
      prepared.writtenAfterTheBackup
    )
  ).toBe(true);

  expect(
    previewDatabaseFileUpgrade({ file: store.file, authority: store.authority })
  ).toMatchObject({ state: 'upgrade-required', schemaVersion: RELEASED_SCHEMA_VERSION });
  const again = await upgradeDatabaseFile({ file: store.file, authority: store.authority });
  expect(again.outcome).toBe('upgraded');
  const reader = await openProjectDatabase({ authority: store.authority, mode: 'reader' });
  reader.close();
}, 120_000);

it('refuses a session that begins writing across the swap and keeps what it acknowledged before it', async () => {
  const prepared = await upgradedWithNewerWork();
  const { store } = prepared;
  const attempts: Array<{ stage: ProjectDatabaseRestoreStage; outcome: string }> = [];
  // Another session's smallest possible commit, attempted where the restore has not taken the
  // database yet and again where it has. The first has to be kept, the second refused: a commit
  // this one was told had succeeded and that then reached neither database would be work the
  // restore lost.
  const attempt = (stage: ProjectDatabaseRestoreStage) => {
    let other: Database.Database | undefined;
    try {
      other = new Database(store.file, { fileMustExist: true, timeout: 50 });
      other
        .prepare(
          'UPDATE project_counters SET write_sequence = write_sequence + 1 WHERE singleton = 1'
        )
        .run();
      attempts.push({ stage, outcome: 'acknowledged' });
    } catch (cause) {
      attempts.push({ stage, outcome: (cause as { code?: string }).code ?? 'refused' });
    } finally {
      other?.close();
    }
  };

  const result = await restoreDatabaseFileBackup(
    { file: store.file, authority: store.authority, backup: prepared.backup },
    (stage) => {
      if (stage === 'backup-staged' || stage === 'log-set-aside') attempt(stage);
    }
  );

  expect(attempts).toEqual([
    { stage: 'backup-staged', outcome: 'acknowledged' },
    { stage: 'log-set-aside', outcome: 'SQLITE_BUSY' },
  ]);
  expect(counters(result.replaced!.databaseFile).writeSequence).toBe(
    prepared.newerCounters.writeSequence + 1
  );
  expect(result.replaced!.counters!.writeSequence).toBe(prepared.newerCounters.writeSequence + 1);
  expect(snapshot(Database, store.file)).toEqual(prepared.released);
}, 120_000);

it('sets aside a database it cannot read exactly as it is, log and all', async () => {
  const prepared = await upgradedWithNewerWork();
  const { store } = prepared;
  const work = await temporaryDirectory('stranger-database-');
  const source = path.join(work, 'stranger.sqlite3');
  // A database in place that is sound SQLite but says nothing this store can read, with rows
  // that exist only in its log. Opening such a file for writing folds the log into the main file
  // and deletes it, which would set aside something other than what was there.
  const stranger = new Database(source);
  stranger.pragma('journal_mode = WAL');
  stranger.pragma('wal_autocheckpoint = 0');
  stranger.exec('CREATE TABLE records (value)');
  for (let value = 0; value < 200; value += 1)
    stranger.prepare('INSERT INTO records VALUES (?)').run(value);
  const main = readFileSync(source);
  const log = readFileSync(`${source}-wal`);
  stranger.close();
  expect(log.length).toBeGreaterThan(0);

  for (const suffix of ['-wal', '-shm']) await rm(`${store.file}${suffix}`, { force: true });
  writeFileSync(store.file, main);
  writeFileSync(`${store.file}-wal`, log);

  const result = await restoreProjectDatabaseBackup({
    authority: store.authority,
    backup: prepared.backup,
  });

  expect(result).toMatchObject({ otherSessions: 'nothing-to-lock' });
  expect(readFileSync(result.replaced!.databaseFile)).toEqual(main);
  expect(readFileSync(`${result.replaced!.databaseFile}-wal`)).toEqual(log);
  expect(
    reading(result.replaced!.databaseFile, (database) =>
      database.prepare('SELECT count(*) AS n FROM records').get()
    )
  ).toEqual({ n: 200 });
  expect(snapshot(Database, store.file)).toEqual(prepared.released);
}, 120_000);

it('sets aside bytes that are not a database at all and restores over them', async () => {
  const prepared = await upgradedWithNewerWork();
  const { store } = prepared;
  const garbage = Buffer.from('this is not a database, and a restore is exactly what it needs');
  for (const suffix of ['-wal', '-shm']) await rm(`${store.file}${suffix}`, { force: true });
  writeFileSync(store.file, garbage);

  const result = await restoreProjectDatabaseBackup({
    authority: store.authority,
    backup: prepared.backup,
  });

  expect(result).toMatchObject({
    otherSessions: 'nothing-to-lock',
    replaced: { schemaVersion: null, counters: null },
  });
  expect(readFileSync(result.replaced!.databaseFile)).toEqual(garbage);
  expect(snapshot(Database, store.file)).toEqual(prepared.released);
}, 120_000);

it('restores when there is no database file in place at all', async () => {
  const prepared = await upgradedWithNewerWork();
  const { store } = prepared;
  for (const suffix of ['', '-wal', '-shm']) await rm(`${store.file}${suffix}`, { force: true });

  const result = await restoreProjectDatabaseBackup({
    authority: store.authority,
    backup: prepared.backup,
  });

  expect(result).toMatchObject({ replaced: null, otherSessions: 'nothing-to-lock' });
  expect(snapshot(Database, store.file)).toEqual(prepared.released);
  expect(besideDatabase(store)).toEqual([]);
}, 120_000);

describe('a restore that is refused', () => {
  async function refuses(
    prepared: RestorableStore,
    backup: string,
    expected: { code: string; message: RegExp }
  ): Promise<void> {
    const before = fingerprint(prepared.store.file);

    await expect(
      restoreProjectDatabaseBackup({ authority: prepared.store.authority, backup })
    ).rejects.toMatchObject(expected);

    expect(fingerprint(prepared.store.file)).toEqual(before);
    expect(besideDatabase(prepared.store)).toEqual([]);
  }

  it('refuses a name that is not the published shape of a backup', async () => {
    const prepared = await upgradedWithNewerWork();
    for (const backup of [
      '..',
      `../${prepared.backup}`,
      `${prepared.backup}/../../${prepared.backup}`,
      'upgrade-backups',
      'schema-29-not-a-uuid',
      `${prepared.backup}x`,
      `/tmp/${prepared.backup}`,
    ])
      await refuses(prepared, backup, {
        code: 'INVALID_INPUT',
        message: /Name a backup of this project database/,
      });
  }, 120_000);

  it('refuses a backup that belongs to another store', async () => {
    const prepared = await upgradedWithNewerWork();
    const other = await upgradedWithNewerWork();

    // Another store's published backup, dropped in beside this one under its own published name.
    // Its manifest is untouched, so the rows of the copy are what refuse it.
    cpSync(
      backupDirectory(other.store, other.backup),
      backupDirectory(prepared.store, other.backup),
      { recursive: true }
    );
    await refuses(prepared, other.backup, {
      code: 'AUTHORITY_MISMATCH',
      message: /the database was not replaced/,
    });

    const manifest = readManifest(prepared.store, prepared.backup);
    writeManifest(
      prepared.store,
      prepared.backup,
      resign({ ...manifest, store: { ...manifest.store, project_id: uuidv7() } })
    );
    await refuses(prepared, prepared.backup, {
      code: 'AUTHORITY_MISMATCH',
      message: /The backup belongs to a different store; the database was not replaced/,
    });
  }, 180_000);

  // The last byte is a page a reader would stumble on; byte 99 is the last of the header's
  // record of the SQLite version that wrote the file, which a reader passes over. Neither is the
  // backup the manifest signed, and only the hash over the whole file can say so of the second.
  it.each([
    ['a page', (bytes: Buffer) => bytes.length - 1],
    ['the part of the header a reader ignores', () => 99],
  ])(
    'refuses a backup file with one byte of %s changed',
    async (_where, offset) => {
      const prepared = await upgradedWithNewerWork();
      const file = path.join(
        backupDirectory(prepared.store, prepared.backup),
        BACKUP_DATABASE_FILE
      );
      const bytes = readFileSync(file);
      const at = offset(bytes);
      bytes[at] = bytes[at]! ^ 0x01;
      writeFileSync(file, bytes);

      await refuses(prepared, prepared.backup, {
        code: 'HISTORY_BACKUP_UNVERIFIED',
        message: /The backup differs from its manifest; the database was not replaced/,
      });
    },
    120_000
  );

  it('refuses a manifest with one field changed', async () => {
    const prepared = await upgradedWithNewerWork();
    const manifest = readManifest(prepared.store, prepared.backup);
    writeManifest(prepared.store, prepared.backup, {
      ...manifest,
      created_at: new Date(Date.parse(manifest.created_at) + 1000).toISOString(),
    });

    await refuses(prepared, prepared.backup, {
      code: 'HISTORY_BACKUP_UNVERIFIED',
      message: /The backup manifest does not match its hash; the database was not replaced/,
    });
  }, 120_000);

  // Each forgery is signed again, so the manifest's own hash admits it and only the comparison
  // against the file the backup holds can turn it away. Leaving the digest over the table
  // digests alone keeps that digest agreeing with the file, so the table digests are the one
  // thing left to catch; recomputing it makes the two agree with each other instead.
  it.each([
    ['whose table digests are no longer the file’s', false],
    ['whose digest over its table digests follows them', true],
  ])(
    'refuses a resigned manifest %s',
    async (_forgery, recomputeDigestOfDigests) => {
      const prepared = await upgradedWithNewerWork();
      const manifest = readManifest(prepared.store, prepared.backup);
      const [table, digest] = Object.entries(manifest.database.tables).find(
        ([, entry]) => entry.rows > 0
      )!;
      const tables = { ...manifest.database.tables, [table]: { ...digest, rows: digest.rows + 1 } };
      const content_sha256 = recomputeDigestOfDigests
        ? sha256(
            Object.keys(tables)
              .sort()
              .map((name) => `${name} ${tables[name]!.rows} ${tables[name]!.sha256}`)
              .join('\n')
          )
        : manifest.database.content_sha256;

      writeManifest(
        prepared.store,
        prepared.backup,
        resign({ ...manifest, database: { ...manifest.database, tables, content_sha256 } })
      );

      await refuses(prepared, prepared.backup, {
        code: 'HISTORY_BACKUP_UNVERIFIED',
        message: /The backup differs from its manifest; the database was not replaced/,
      });
    },
    120_000
  );

  // An empty log makes a truncating checkpoint report an idle reader as idle, and a write lock
  // excludes writers only, so a database held for a restore has to be held against every session
  // that has it open at all.
  it('refuses while another session has the database open, in a transaction or not', async () => {
    const prepared = await upgradedWithNewerWork();
    const { store } = prepared;
    for (const begin of ['BEGIN IMMEDIATE', 'BEGIN', null]) {
      const before = fingerprint(store.file);
      const holder = new Database(store.file, { fileMustExist: true, timeout: 50 });
      try {
        if (begin) holder.exec(begin);
        holder.prepare('SELECT count(*) AS n FROM operations').get();

        await expect(
          restoreProjectDatabaseBackup({
            authority: store.authority,
            backup: prepared.backup,
            busyTimeoutMs: 50,
          })
        ).rejects.toMatchObject({
          code: 'TRANSACTION_RETRY_EXHAUSTED',
          message:
            /The database is in use; close other sessions and retry; the database was not replaced/,
        });
      } finally {
        if (begin) holder.exec('ROLLBACK');
        holder.close();
      }
      // Byte for byte, log included: a restore that refuses has read the database and nothing more.
      expect([begin, fingerprint(store.file)]).toEqual([begin, before]);
      expect([begin, besideDatabase(store)]).toEqual([begin, []]);
    }
  }, 120_000);

  it('refuses with a typed failure when the backup cannot be put beside the database', async () => {
    const prepared = await upgradedWithNewerWork();
    const { store } = prepared;
    const before = fingerprint(store.file);
    chmodSync(store.projectDirectory, 0o500);
    try {
      await expect(
        restoreProjectDatabaseBackup({ authority: store.authority, backup: prepared.backup })
      ).rejects.toMatchObject({
        code: 'HISTORY_UNWRITABLE',
        message: /The backup could not be put beside the database; the database was not replaced/,
      });
    } finally {
      chmodSync(store.projectDirectory, 0o700);
    }

    expect(fingerprint(store.file)).toEqual(before);
    expect(besideDatabase(store)).toEqual([]);
  }, 120_000);

  it('refuses with a typed failure when the database in place cannot be set aside', async () => {
    const prepared = await upgradedWithNewerWork();
    const { store } = prepared;
    const before = snapshot(Database, store.file);

    // The database takes a second name before it loses its first. A directory that will not give
    // it one stands in for a filesystem with no hard links, and must not leave a bare Node error.
    const refused = restoreDatabaseFileBackup(
      { file: store.file, authority: store.authority, backup: prepared.backup },
      (stage) => {
        if (stage === 'database-settled') chmodSync(store.projectDirectory, 0o500);
      }
    );
    try {
      await expect(refused).rejects.toMatchObject({
        code: 'HISTORY_UNWRITABLE',
        message:
          /The database in place could not be exchanged for the backup; the database was not replaced/,
      });
    } finally {
      chmodSync(store.projectDirectory, 0o700);
    }

    expect(snapshot(Database, store.file)).toEqual(before);
    expect(besideDatabase(store)).toEqual(['history.sqlite3.restoring-<id>']);
  }, 120_000);

  it('never reports a database it has already replaced as unchanged', async () => {
    const prepared = await upgradedWithNewerWork();
    const { store } = prepared;

    await expect(
      restoreDatabaseFileBackup(
        { file: store.file, authority: store.authority, backup: prepared.backup },
        (stage) => {
          if (stage === 'backup-in-place') throw new Error('interrupted after the last rename');
        }
      )
    ).rejects.toMatchObject({
      code: 'HISTORY_UNWRITABLE',
      message:
        /The restore failed after the database was replaced: the backup is now .*history\.sqlite3, and the database it replaced is kept at .*history\.sqlite3\.replaced-/,
    });

    expect(snapshot(Database, store.file)).toEqual(prepared.released);
    expect(besideDatabase(store).filter((name) => name.endsWith('.replaced-<id>'))).toEqual([
      'history.sqlite3.replaced-<id>',
    ]);
  }, 120_000);
});

it('leaves a database the project can still open when the restore is killed at any point', async () => {
  const directory = await temporaryDirectory('restore-crash-');
  const script = path.join(directory, 'restore-then-die.mjs');
  await writeFile(
    script,
    `const [module, file, authority, backup, stage] = process.argv.slice(2);
const { restoreDatabaseFileBackup } = await import(module);
await restoreDatabaseFileBackup({ file, authority: JSON.parse(authority), backup }, (reported) => {
  if (reported === stage) process.kill(process.pid, 'SIGKILL');
});
`
  );
  const killedAt = async (stage: ProjectDatabaseRestoreStage) => {
    const prepared = await upgradedWithNewerWork();
    const run = spawnSync(
      process.execPath,
      [
        script,
        RESTORE_MODULE,
        prepared.store.file,
        JSON.stringify(prepared.store.authority),
        prepared.backup,
        stage,
      ],
      { encoding: 'utf8' }
    );
    expect([stage, run.signal, run.stderr]).toEqual([stage, 'SIGKILL', '']);
    return prepared;
  };

  // Until the last rename the database in place is still the whole database, log and all.
  for (const stage of ['database-set-aside', 'log-set-aside'] as const) {
    const prepared = await killedAt(stage);
    expect([stage, snapshot(Database, prepared.store.file)]).toEqual([stage, prepared.newer]);
    const reader = await openProjectDatabase({
      authority: prepared.store.authority,
      mode: 'reader',
    });
    reader.close();
  }

  // After it, the backup is the database and the file set aside holds the newer work.
  const prepared = await killedAt('backup-in-place');
  expect(snapshot(Database, prepared.store.file)).toEqual(prepared.released);
  const setAside = besideDatabase(prepared.store).filter((name) => name.endsWith('.replaced-<id>'));
  expect(setAside).toEqual(['history.sqlite3.replaced-<id>']);
  const replaced = readdirSync(prepared.store.projectDirectory).find(
    (name) => name.includes('.replaced-') && !name.endsWith('-wal') && !name.endsWith('-shm')
  )!;
  expect(snapshot(Database, path.join(prepared.store.projectDirectory, replaced))).toEqual(
    prepared.newer
  );
}, 240_000);

describe('the list of backups', () => {
  it('names a backup a restore could use, and one whose manifest cannot be read', async () => {
    const prepared = await upgradedWithNewerWork();
    const { store } = prepared;

    expect(await listProjectDatabaseBackups({ authority: store.authority })).toEqual([
      {
        name: prepared.backup,
        directory: backupDirectory(store, prepared.backup),
        databaseFile: path.join(backupDirectory(store, prepared.backup), BACKUP_DATABASE_FILE),
        manifestFile: manifestFile(store, prepared.backup),
        createdAt: readManifest(store, prepared.backup).created_at,
        schemaVersion: RELEASED_SCHEMA_VERSION,
        counters: prepared.releasedCounters,
      },
    ]);

    writeFileSync(manifestFile(store, prepared.backup), 'not a manifest');
    const listed = await listProjectDatabaseBackups({ authority: store.authority });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: prepared.backup,
      directory: backupDirectory(store, prepared.backup),
      unreadable: 'The backup has no readable manifest; it cannot be restored from',
    });
  }, 120_000);
});
