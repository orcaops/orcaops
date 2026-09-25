import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { readProjectCounters } from './connection.js';
import { digestOfDigests, digestTables } from './content-digest.js';
import {
  BACKUP_DATABASE_FILE,
  BACKUP_DIRECTORY,
  BACKUP_MANIFEST_FILE,
  discardPendingBackup,
  publishPendingBackup,
  writePendingBackup,
} from './database-backup.js';
import { RELEASED_SCHEMA_SQL_SHA256, RELEASED_SCHEMA_VERSION } from './released-schema.js';
import { snapshot } from '../../../tests/database-fixture.mjs';
import { readReleasedFixture, restoreFixtureImage } from '../../../tests/released-fixture.mjs';
import {
  type PlacedSchema29Database,
  placeSchema29Database,
  type Schema29Template,
  syntheticSchema29Template,
} from '../../../tests/schema-29-store.js';
import { canonicalJson } from '../../events/canonical-json.js';

type Manifest = Record<string, never> & {
  hash: string;
  created_at: string;
  database: { bytes: number; sha256: string; content_sha256: string; tables: unknown };
  retained_references: {
    git_references: Array<{ ref: string; named_by: string; presence: string }>;
  };
};

const CANDIDATE = new URL('../../../../../', import.meta.url).pathname;
const CONVERTED_FIXTURE = '0.2.1-converted-from-0.2.0-rc.2';
// The size the hash reads at a time; a database is always larger than one of them.
const HASH_CHUNK_BYTES = 1 << 20;

let template: Schema29Template;
const placements: PlacedSchema29Database[] = [];

beforeAll(async () => {
  template = await syntheticSchema29Template(CANDIDATE);
}, 120_000);

afterAll(() => template.discard());

afterEach(() => {
  for (const placement of placements.splice(0)) placement.discard();
});

async function place(): Promise<PlacedSchema29Database> {
  const placement = await placeSchema29Database(template);
  placements.push(placement);
  return placement;
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
const modeOf = (entry: string) => statSync(entry).mode & 0o777;
const manifestIn = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Manifest;

it('copies the database into one self-contained file only its owner can read', async () => {
  const store = await place();
  const before = snapshot(Database, store.file);

  const pending = await writePendingBackup({ file: store.file, authority: store.authority });
  const backup = publishPendingBackup(pending);

  expect(backup.name).toBe(pending.name);
  expect(modeOf(path.join(store.projectDirectory, BACKUP_DIRECTORY))).toBe(0o700);
  expect(modeOf(backup.directory)).toBe(0o700);
  expect(readdirSync(backup.directory).sort()).toEqual(
    [BACKUP_DATABASE_FILE, BACKUP_MANIFEST_FILE].sort()
  );
  expect([modeOf(backup.databaseFile), modeOf(backup.manifestFile)]).toEqual([0o600, 0o600]);
  // A copy that needed a log beside it would not be one file a restore could verify on its own.
  expect([
    existsSync(`${backup.databaseFile}-wal`),
    existsSync(`${backup.databaseFile}-shm`),
  ]).toEqual([false, false]);
  expect(snapshot(Database, backup.databaseFile)).toEqual(before);
}, 60_000);

it('records a manifest whose hash verifies and whose digests are the ones the source holds', async () => {
  const store = await place();
  const counters = reading(store.file, readProjectCounters);
  const tables = reading(store.file, digestTables);

  const backup = publishPendingBackup(
    await writePendingBackup({ file: store.file, authority: store.authority })
  );

  const manifest = manifestIn(backup.manifestFile);
  const { hash, ...body } = manifest;
  expect(hash).toBe(sha256(canonicalJson(body)));
  expect(Number.isFinite(Date.parse(manifest.created_at))).toBe(true);
  expect(manifest).toMatchObject({
    manifest_version: 1,
    name: backup.name,
    reason: 'schema_upgrade',
    store: {
      resolved_root: store.authority.resolvedRoot,
      root_key: store.authority.rootKey,
      project_id: store.authority.projectId,
      store_instance_id: store.authority.storeInstanceId,
      repository_instance_id: store.authority.repositoryInstanceId,
    },
    source: {
      schema_version: RELEASED_SCHEMA_VERSION,
      schema_sql_sha256: RELEASED_SCHEMA_SQL_SHA256,
      write_sequence: counters.writeSequence,
      intent_change_counter: counters.intentChangeCounter,
    },
    database: { file: BACKUP_DATABASE_FILE },
  });
  expect(manifest.database.tables).toEqual(tables);
  expect(manifest.database.content_sha256).toBe(digestOfDigests(tables));
}, 60_000);

it('hashes the whole backup file, not the first read of it', async () => {
  const store = await place();

  const backup = publishPendingBackup(
    await writePendingBackup({ file: store.file, authority: store.authority })
  );

  const bytes = readFileSync(backup.databaseFile);
  const manifest = manifestIn(backup.manifestFile);
  expect(bytes.length).toBeGreaterThan(HASH_CHUNK_BYTES);
  expect(manifest.database.bytes).toBe(bytes.length);
  expect(manifest.database.sha256).toBe(sha256(bytes));
  expect(manifest.database.sha256).not.toBe(sha256(bytes.subarray(0, HASH_CHUNK_BYTES)));
}, 60_000);

it('refuses with a typed failure when the backup cannot be finished beside the database', async () => {
  const store = await place();
  const parent = path.join(store.projectDirectory, BACKUP_DIRECTORY);
  const before = snapshot(Database, store.file);

  // The pending directory exists before the copy begins, so a file where the manifest belongs
  // fails the write that finishes the backup rather than the one that starts it.
  const pending = writePendingBackup({ file: store.file, authority: store.authority });
  const [created] = readdirSync(parent);
  writeFileSync(path.join(parent, created!, BACKUP_MANIFEST_FILE), '');

  await expect(pending).rejects.toMatchObject({
    code: 'HISTORY_UNWRITABLE',
    message: /nothing was changed/,
  });
  expect(readdirSync(parent)).toEqual([]);
  expect(snapshot(Database, store.file)).toEqual(before);
}, 60_000);

it('names every retained resource a legacy import holds, and nothing at all for a value that is not a list of them', async () => {
  const { database, schema } = await readReleasedFixture(CONVERTED_FIXTURE);
  const retained = async (value: string) => {
    const fixture = await restoreFixtureImage(CANDIDATE, {
      schemaVersion: database.schemaVersion,
      definitions: schema.definitions,
      rows: {
        ...database.rows,
        legacy_import: database.rows.legacy_import!.map((row) => ({
          ...row,
          git_resources_json: value,
        })),
      },
    });
    try {
      const pending = await writePendingBackup({
        file: fixture.file,
        authority: fixture.authority,
      });
      const manifest = manifestIn(path.join(pending.pendingDirectory, BACKUP_MANIFEST_FILE));
      discardPendingBackup(pending.pendingDirectory);
      return manifest.retained_references.git_references
        .filter((entry) => entry.named_by === 'legacy_import.git_resources_json')
        .map((entry) => entry.ref);
    } finally {
      await fixture.cleanup();
    }
  };
  const written = database.rows.legacy_import![0]!.git_resources_json as string;
  const refs = (JSON.parse(written) as Array<{ ref: string }>).map((entry) => entry.ref).sort();

  expect(refs.length).toBeGreaterThan(0);
  expect(await retained(written)).toEqual(refs);
  // The column is held to valid JSON and nothing more, so the manifest reports what it can read
  // of any shape the release would have stored there.
  expect(await retained('{"ref":"refs/heads/main","oid":"9e1f"}')).toEqual([]);
  expect(await retained('5')).toEqual([]);
  expect(await retained('[1,null,"x",{"ref":"refs/heads/kept","oid":"9e1f"}]')).toEqual([
    'refs/heads/kept',
  ]);
}, 120_000);
