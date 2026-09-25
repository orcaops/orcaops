import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from '../../events/canonical-json.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
  readProjectCounters,
} from './connection.js';
import { digestOfDigests, digestTable, digestTables } from './content-digest.js';
import { BACKUP_DATABASE_FILE, BACKUP_DIRECTORY, BACKUP_MANIFEST_FILE } from './database-backup.js';
import {
  readSchemaObjects,
  RELEASED_SCHEMA_SQL_SHA256,
  RELEASED_SCHEMA_VERSION,
  schemaSqlDigest,
} from './released-schema.js';
import {
  previewDatabaseFileUpgrade,
  previewProjectDatabaseUpgrade,
  PROJECT_DATABASE_UPGRADE_STEPS,
  type ProjectDatabaseUpgradeResult,
  type ProjectDatabaseUpgradeStage,
  type ProjectDatabaseUpgradeState,
  type ProjectDatabaseUpgradeStep,
  rowIdentities,
  tablesWhoseRowIdsMoved,
  upgradeDatabaseFile,
  upgradeProjectDatabase,
} from './schema-upgrade.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { type FixtureSnapshot, snapshot } from '../../../tests/database-fixture.mjs';
import {
  type PlacedSchema29Database,
  placeSchema29Database,
  releasedSchema29Template,
  type Schema29Template,
  syntheticSchema29Template,
} from '../../../tests/schema-29-store.js';

type Row = Record<string, unknown>;

const CANDIDATE = new URL('../../../../../', import.meta.url).pathname;
const UPGRADE_MODULE = new URL('../../../dist/history/database/schema-upgrade.js', import.meta.url)
  .href;
const RELEASED_FIXTURES = ['0.2.0', '0.2.1', '0.2.1-converted-from-0.2.0-rc.2'];
const SYNTHETIC = 'synthetic-schema-29';
const FIXTURES = [...RELEASED_FIXTURES, SYNTHETIC];

// In the order the upgrade copies rows back: a revision before the relationships that require
// it, and both before the adoptions that require either. The other retained requests depend on
// none of them.
const REBUILT_TABLES = [
  'claim_revisions',
  'decision_revisions',
  'record_relationships',
  'adoptions',
  'pending_capture_requests',
  'remote_requests',
];
const SIBLING_TRIGGERS = ['claim_revision_continues', 'decision_revision_continues'];

// What a released row takes in the new columns, written out as the design note's table fixes it
// under "What a released row takes in the new columns", never as the expression the upgrade runs.
const CARRIED_VALUES: Record<string, Row> = {
  claim_revisions: {
    attributed_kind: 'actor',
    attributed_basis: 'unknown',
    source_standing: null,
    subject_id: null,
    subject_revision_id: null,
  },
  decision_revisions: {
    attributed_kind: 'actor',
    attributed_basis: 'unknown',
    source_standing: null,
    subject_id: null,
    subject_revision_id: null,
    derived_from_kind: null,
    derived_from_id: null,
    derived_from_revision_id: null,
  },
  adoptions: {
    approver_basis: 'unknown',
    designation: 'adopted',
    authorization_json: null,
    authorization_id: null,
  },
  pending_capture_requests: { without_model: 1 },
  remote_requests: {},
};

// A relationship is the one rebuilt table whose new values depend on what the released row says:
// the table holds a detector to a name without a basis and an author to a basis, and a released
// row records neither, so an author's basis is unknown. Both stand as established.
const CARRIED_RELATIONSHIP_VALUES: Record<string, Row> = {
  author: {
    attributed_basis: 'unknown',
    standing: 'established',
    explanation: null,
    authorization_json: null,
    authorization_id: null,
  },
  detector: {
    attributed_basis: null,
    standing: 'established',
    explanation: null,
    authorization_json: null,
    authorization_id: null,
  },
};

const carried = (table: string, row: Row): Row =>
  table === 'record_relationships'
    ? CARRIED_RELATIONSHIP_VALUES[row.attributed_kind as string]!
    : CARRIED_VALUES[table]!;

function retainRemoteGraphs(database: Database.Database): void {
  const operations = database
    .prepare('SELECT operation_id FROM operations ORDER BY rowid LIMIT 9')
    .all()
    .map((row) => (row as { operation_id: string }).operation_id);
  expect(operations).toHaveLength(9);
  const payload = Buffer.from('{}');
  const digest = createHash('sha256').update(payload).digest('hex');
  const requests = ['prepared', 'unknown', 'completed'].map((state, index) => ({
    state,
    requestId: uuidv7(),
    attemptId: uuidv7(),
    outcomeId: uuidv7(),
    operationId: operations[index * 3]!,
    attemptOperationId: operations[index * 3 + 1]!,
    outcomeOperationId: operations[index * 3 + 2]!,
    key: `operation:${String(index + 1).repeat(64)}`,
  }));
  const insertRequest = database.prepare(
    `INSERT INTO remote_requests (request_id, operation_id, server_url, org_id, account_id, artifact_id,
      artifact_scope, method, target_external_id, idempotency_key, payload_bytes, payload_sha256,
      request_key, prepared_at) VALUES (?, ?, 'https://cloud.example', 'org', 'account', NULL, '',
      'sourcePlan.reviewPush', ?, ?, ?, ?, ?, '2026-09-22T00:00:00.000Z')`
  );
  const insertCurrent = database.prepare(
    `INSERT INTO remote_current (server_url, org_id, account_id, artifact_scope, method,
      target_external_id, idempotency_key, request_id, attempt_id, outcome_id, version)
      VALUES ('https://cloud.example', 'org', 'account', '', 'sourcePlan.reviewPush', ?, ?, ?, NULL, NULL, 1)`
  );
  for (const request of requests) {
    insertRequest.run(
      request.requestId,
      request.operationId,
      request.state,
      request.state,
      payload,
      digest,
      request.key
    );
    insertCurrent.run(request.state, request.state, request.requestId);
    if (request.state === 'prepared') continue;
    database
      .prepare(
        `INSERT INTO remote_attempts (attempt_id, request_id, operation_id, attempted_at)
         VALUES (?, ?, ?, '2026-09-22T00:01:00.000Z')`
      )
      .run(request.attemptId, request.requestId, request.attemptOperationId);
    database
      .prepare(
        `INSERT INTO remote_outcomes (outcome_id, request_id, attempt_id, operation_id, outcome_n,
          kind, observed_at, response_bytes, response_sha256, failure_kind, failure_message)
         VALUES (?, ?, ?, ?, 1, ?, '2026-09-22T00:02:00.000Z', ?, ?, ?, ?)`
      )
      .run(
        request.outcomeId,
        request.requestId,
        request.attemptId,
        request.outcomeOperationId,
        request.state === 'completed' ? 'acknowledged' : 'ack_unknown',
        request.state === 'completed' ? payload : null,
        request.state === 'completed' ? digest : null,
        request.state === 'unknown' ? 'unknown' : null,
        request.state === 'unknown' ? 'connection closed' : null
      );
    database
      .prepare(
        `UPDATE remote_current SET attempt_id = ?, outcome_id = ?, version = 2
         WHERE target_external_id = ?`
      )
      .run(request.attemptId, request.outcomeId, request.state);
  }
}

const retainedRemoteGraphs = (file: string) =>
  reading(file, (database) =>
    Object.fromEntries(
      ['remote_requests', 'remote_attempts', 'remote_outcomes', 'remote_current'].map((table) => [
        table,
        database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all(),
      ])
    )
  );

const STAGES: ProjectDatabaseUpgradeStage[] = [
  'backup-verified',
  'backup-published',
  'table-dropped:remote_requests',
  'table-dropped:pending_capture_requests',
  'table-dropped:adoptions',
  'table-dropped:record_relationships',
  'table-dropped:decision_revisions',
  'table-dropped:claim_revisions',
  'objects-created',
  'rows-restored',
  'before-verification',
  'before-commit',
  'committed',
];

const templates = new Map<string, Schema29Template>();
const placements: PlacedSchema29Database[] = [];
const scratch: string[] = [];
let freshDefinitions: FixtureSnapshot['definitions'];

beforeAll(async () => {
  for (const name of RELEASED_FIXTURES) templates.set(name, await releasedSchema29Template(name));
  templates.set(SYNTHETIC, await syntheticSchema29Template(CANDIDATE));
  freshDefinitions = await definitionsOfAFreshDatabase();
}, 180_000);

afterAll(() => {
  for (const template of templates.values()) template.discard();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const placement of placements.splice(0)) placement.discard();
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

async function definitionsOfAFreshDatabase(): Promise<FixtureSnapshot['definitions']> {
  const root = await normalizeHistoryRoot({ root: await temporaryDirectory('fresh-store-') });
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handle.close();
  return snapshot(Database, file).definitions;
}

async function place(name: string): Promise<PlacedSchema29Database> {
  const placement = await placeSchema29Database(templates.get(name)!);
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

function changing(file: string, change: (database: Database.Database) => void): void {
  const database = new Database(file, { fileMustExist: true });
  try {
    change(database);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

const digestOfFile = (file: string) =>
  existsSync(file) && statSync(file).size > 0
    ? createHash('sha256').update(readFileSync(file)).digest('hex')
    : null;
// The main file and the write-ahead log together are the database; a preview or a refusal has to
// leave both exactly as they were. SQLite recreates an empty log beside a file it opens, so an
// empty log and no log are the same database.
const fingerprint = (file: string) => ({
  main: digestOfFile(file),
  log: digestOfFile(`${file}-wal`),
});

const counters = (file: string) => reading(file, readProjectCounters);
const columnsOf = (file: string, table: string) =>
  reading(
    file,
    (database) =>
      (
        database.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(table) as Row[]
      ).map((column) => column.name) as string[]
  );
const rowIdsOf = (file: string, table: string) =>
  reading(file, (database) =>
    (database.prepare(`SELECT rowid AS id FROM "${table}" ORDER BY rowid`).all() as Row[]).map(
      (row) => row.id
    )
  );
const modeOf = (entry: string) => statSync(entry).mode & 0o777;
const backupsIn = (projectDirectory: string) => {
  const parent = path.join(projectDirectory, BACKUP_DIRECTORY);
  return existsSync(parent) ? readdirSync(parent).sort() : null;
};

function asUpgraded(result: ProjectDatabaseUpgradeResult) {
  if (result.outcome !== 'upgraded') throw new Error(`The upgrade reported ${result.outcome}`);
  return result;
}

function refusalOf(run: () => unknown): { code?: string; message: string } {
  try {
    run();
  } catch (cause) {
    return cause as { code?: string; message: string };
  }
  throw new Error('Nothing was refused');
}

const project = (row: Row, columns: readonly string[]) =>
  Object.fromEntries(columns.map((column) => [column, row[column]]));
const except = (row: Row, columns: readonly string[]) =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));

function expectedPlan(file: string) {
  return reading(file, (database) => {
    const present = readSchemaObjects(database);
    const names = new Set(present.map((object) => object.name));
    const fresh = new Set(freshDefinitions.map((object) => object.name));
    return {
      rebuiltTables: REBUILT_TABLES.map((table) => [
        table,
        (database.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n,
      ]),
      dropped: present
        .filter((object) => !fresh.has(object.name))
        .map((object) => object.name)
        .sort(),
      created: freshDefinitions
        .filter((object) => !names.has(object.name))
        .map((object) => object.name)
        .sort(),
    };
  });
}

describe.each(FIXTURES)('the frozen schema-29 database %s', (name) => {
  it('previews the upgrade and leaves the database and its log as they were', async () => {
    const store = await place(name);
    const before = fingerprint(store.file);
    const expected = expectedPlan(store.file);
    const gained = Object.fromEntries(
      REBUILT_TABLES.map((table) => [
        table,
        Object.keys(carried(table, { attributed_kind: 'author' })).sort(),
      ])
    );

    const preview = await previewProjectDatabaseUpgrade({ authority: store.authority });

    expect(preview.state).toBe('upgrade-required');
    expect([preview.schemaVersion, preview.currentSchemaVersion]).toEqual([
      RELEASED_SCHEMA_VERSION,
      PROJECT_DATABASE_SCHEMA_VERSION,
    ]);
    expect(preview.counters).toEqual(counters(store.file));
    expect(preview.plan).toMatchObject({
      fromVersion: RELEASED_SCHEMA_VERSION,
      toVersion: PROJECT_DATABASE_SCHEMA_VERSION,
    });
    expect(preview.plan!.rebuiltTables.map((entry) => [entry.table, entry.rows])).toEqual(
      expected.rebuiltTables
    );
    expect(
      Object.fromEntries(
        preview.plan!.rebuiltTables.map((entry) => [
          entry.table,
          Object.keys(entry.addedColumns).sort(),
        ])
      )
    ).toEqual(gained);
    expect(
      preview
        .plan!.droppedObjects.filter((object) => object.type === 'trigger')
        .map((object) => object.name)
        .sort()
    ).toEqual(SIBLING_TRIGGERS);
    expect(preview.plan!.droppedObjects.map((object) => object.name).sort()).toEqual(
      expected.dropped
    );
    expect(preview.plan!.createdObjects.map((object) => object.name).sort()).toEqual(
      expected.created
    );
    expect(preview.backup).toEqual({
      directory: path.join(store.projectDirectory, BACKUP_DIRECTORY),
      databaseFileName: BACKUP_DATABASE_FILE,
      manifestFileName: BACKUP_MANIFEST_FILE,
    });

    expect(fingerprint(store.file)).toEqual(before);
    expect(backupsIn(store.projectDirectory)).toBeNull();
  }, 60_000);

  it('carries every row and row id into the current schema without moving a counter', async () => {
    const store = await place(name);
    const before = snapshot(Database, store.file);
    const released = Object.fromEntries(
      REBUILT_TABLES.map((table) => [table, columnsOf(store.file, table)])
    );
    const rowIds = Object.fromEntries(
      REBUILT_TABLES.map((table) => [table, rowIdsOf(store.file, table)])
    );
    const before29 = counters(store.file);
    expect(before.version).toBe(RELEASED_SCHEMA_VERSION);

    const result = await upgradeProjectDatabase({ authority: store.authority });

    expect(result.outcome).toBe('upgraded');
    expect(result).toMatchObject({ counters: before29 });
    const reader = await openProjectDatabase({ authority: store.authority, mode: 'reader' });
    reader.close();

    const after = snapshot(Database, store.file);
    expect(after.version).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    expect(after.foreignKeys).toEqual([]);
    expect(after.definitions).toEqual(freshDefinitions);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (REBUILT_TABLES.includes(table)) continue;
      expect([table, after.rows[table]]).toEqual([table, rows]);
    }
    for (const table of REBUILT_TABLES) {
      const columns = released[table]!;
      expect([table, after.rows[table]!.map((row) => project(row, columns))]).toEqual([
        table,
        before.rows[table],
      ]);
      expect([table, after.rows[table]!.map((row) => except(row, columns))]).toEqual([
        table,
        before.rows[table]!.map((row) => carried(table, row)),
      ]);
      expect([table, rowIdsOf(store.file, table)]).toEqual([table, rowIds[table]]);
    }
    expect(counters(store.file)).toEqual(before29);
    expect(after.rows.operations!.length).toBe(before.rows.operations!.length);

    const published = backupsIn(store.projectDirectory);
    expect(published).toHaveLength(1);
    expect(await upgradeProjectDatabase({ authority: store.authority })).toEqual({
      outcome: 'already-current',
      schemaVersion: PROJECT_DATABASE_SCHEMA_VERSION,
    });
    expect(backupsIn(store.projectDirectory)).toEqual(published);
  }, 60_000);

  it('publishes one self-contained backup holding the database as it was', async () => {
    const store = await place(name);
    const before = snapshot(Database, store.file);
    const before29 = counters(store.file);

    const { backup } = asUpgraded(
      await upgradeDatabaseFile({ file: store.file, authority: store.authority })
    );

    expect(backup.name).toMatch(
      /^schema-29-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(modeOf(path.join(store.projectDirectory, BACKUP_DIRECTORY))).toBe(0o700);
    expect(modeOf(backup.directory)).toBe(0o700);
    expect(readdirSync(backup.directory).sort()).toEqual(
      [BACKUP_DATABASE_FILE, BACKUP_MANIFEST_FILE].sort()
    );
    expect([modeOf(backup.databaseFile), modeOf(backup.manifestFile)]).toEqual([0o600, 0o600]);

    const manifest = JSON.parse(readFileSync(backup.manifestFile, 'utf8')) as Record<
      string,
      unknown
    > & { hash: string };
    const { hash, ...body } = manifest;
    expect(hash).toBe(createHash('sha256').update(canonicalJson(body)).digest('hex'));
    expect(manifest.source).toEqual({
      schema_version: RELEASED_SCHEMA_VERSION,
      schema_sql_sha256: RELEASED_SCHEMA_SQL_SHA256,
      write_sequence: before29.writeSequence,
      intent_change_counter: before29.intentChangeCounter,
    });
    expect(snapshot(Database, backup.databaseFile)).toEqual(before);
  }, 60_000);
});

it('reads a released relationship attributed to a detector as established with no basis', async () => {
  const store = await place(SYNTHETIC);
  const before = reading(store.file, (database) =>
    database
      .prepare(
        'SELECT attributed_kind, count(*) AS n FROM record_relationships GROUP BY 1 ORDER BY 1'
      )
      .all()
  ) as Row[];
  // Both released attributions are in this fixture, so the upgrade is judged on each of them.
  expect(before.map((row) => row.attributed_kind)).toEqual(['author', 'detector']);

  asUpgraded(await upgradeDatabaseFile({ file: store.file, authority: store.authority }));

  expect(
    reading(store.file, (database) =>
      database
        .prepare(
          'SELECT attributed_kind, attributed_basis, standing, count(*) AS n FROM record_relationships GROUP BY 1, 2, 3 ORDER BY 1'
        )
        .all()
    )
  ).toEqual([
    {
      attributed_kind: 'author',
      attributed_basis: 'unknown',
      standing: 'established',
      n: before[0]!.n,
    },
    {
      attributed_kind: 'detector',
      attributed_basis: null,
      standing: 'established',
      n: before[1]!.n,
    },
  ]);
}, 60_000);

describe('what a preview leaves beside the database', () => {
  // The log folded in and both sidecars taken away: whatever is there afterwards is the
  // preview's own doing.
  async function settled(): Promise<PlacedSchema29Database> {
    const store = await place(SYNTHETIC);
    changing(store.file, () => {});
    for (const suffix of ['-wal', '-shm']) rmSync(`${store.file}${suffix}`, { force: true });
    return store;
  }

  it('may leave a shared-memory file and an empty log, and no byte of the database', async () => {
    const store = await settled();
    const before = digestOfFile(store.file);
    const name = path.basename(store.file);

    expect(previewDatabaseFileUpgrade({ file: store.file, authority: store.authority }).state).toBe(
      'upgrade-required'
    );

    expect(digestOfFile(store.file)).toBe(before);
    expect(existsSync(`${store.file}-shm`)).toBe(true);
    // An empty log and no log are the same database, and nothing else may appear beside it.
    expect(digestOfFile(`${store.file}-wal`)).toBeNull();
    expect(
      readdirSync(store.projectDirectory)
        .filter((entry) => entry.startsWith(`${name}-`))
        .sort()
    ).toEqual([`${name}-shm`, `${name}-wal`]);
  }, 60_000);

  it('refuses a project directory it cannot write in', async () => {
    const store = await settled();
    const before = fingerprint(store.file);
    chmodSync(store.projectDirectory, 0o500);
    try {
      expect(
        refusalOf(() =>
          previewDatabaseFileUpgrade({ file: store.file, authority: store.authority })
        )
      ).toMatchObject({ code: 'HISTORY_INACCESSIBLE' });
    } finally {
      chmodSync(store.projectDirectory, 0o700);
    }

    expect(fingerprint(store.file)).toEqual(before);
    expect(existsSync(`${store.file}-shm`)).toBe(false);
  }, 60_000);
});

it('upgrades a database that has been analysed, dropping the statistics of the rebuilt tables alone', async () => {
  const store = await place(SYNTHETIC);
  changing(store.file, (database) => database.exec('ANALYZE'));
  const analysed = (file: string) =>
    reading(file, (database) =>
      (database.prepare('SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl').all() as Row[]).map(
        (row) => row.tbl as string
      )
    );
  const before = analysed(store.file);
  expect(before.filter((table) => REBUILT_TABLES.includes(table))).toEqual(
    [...REBUILT_TABLES].sort()
  );

  expect(previewDatabaseFileUpgrade({ file: store.file, authority: store.authority }).state).toBe(
    'upgrade-required'
  );
  asUpgraded(await upgradeDatabaseFile({ file: store.file, authority: store.authority }));
  const reader = await openProjectDatabase({ authority: store.authority, mode: 'reader' });
  reader.close();

  // SQLite's own tables are outside both digests and ride through untouched; what a rebuilt
  // table's statistics described is gone with the table, and a later ANALYZE is their price.
  expect(analysed(store.file)).toEqual(before.filter((table) => !REBUILT_TABLES.includes(table)));
}, 60_000);

it('keeps the rows that exist only in a released write-ahead log', async () => {
  const withLog = RELEASED_FIXTURES.map((name) => [name, templates.get(name)!.logBytes > 0]);

  expect(withLog).toEqual([
    ['0.2.0', true],
    ['0.2.1', true],
    ['0.2.1-converted-from-0.2.0-rc.2', false],
  ]);
  for (const name of ['0.2.0', '0.2.1']) {
    const store = await place(name);
    const whole = snapshot(Database, store.file);
    const mainAlone = await temporaryDirectory('main-file-alone-');
    const copy = path.join(mainAlone, 'history.sqlite3');
    await writeFile(copy, readFileSync(store.file));
    const rowsIn = (rows: FixtureSnapshot['rows']) =>
      Object.values(rows).reduce((total, table) => total + table.length, 0);

    expect(rowsIn(snapshot(Database, copy).rows)).toBeLessThan(rowsIn(whole.rows));
    expect((await upgradeProjectDatabase({ authority: store.authority })).outcome).toBe('upgraded');
    const after = snapshot(Database, store.file);
    for (const [table, rows] of Object.entries(whole.rows)) {
      if (REBUILT_TABLES.includes(table)) continue;
      expect([table, after.rows[table]]).toEqual([table, rows]);
    }
  }
}, 120_000);

it('writes each row back under its own row id', async () => {
  const store = await place(SYNTHETIC);
  // Row ids a fresh sequence would not reproduce: without them written back explicitly the
  // rebuilt tables would be renumbered from one.
  changing(store.file, (database) => {
    database.pragma('foreign_keys = OFF');
    retainRemoteGraphs(database);
    for (const table of REBUILT_TABLES) {
      const guard = `${table}_no_update`;
      const sql = (
        database.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(guard) as {
          sql: string;
        }
      ).sql;
      database.exec(`DROP TRIGGER ${guard}`);
      database.exec(`UPDATE "${table}" SET rowid = rowid * 10 + 1000000`);
      database.exec(sql);
    }
  });
  const before = Object.fromEntries(
    REBUILT_TABLES.map((table) => [table, rowIdsOf(store.file, table)])
  );
  const remoteBefore = retainedRemoteGraphs(store.file);
  for (const table of REBUILT_TABLES) {
    expect(before[table]!.length).toBeGreaterThan(0);
    expect(before[table]).not.toEqual(before[table]!.map((_, index) => index + 1));
  }

  asUpgraded(await upgradeDatabaseFile({ file: store.file, authority: store.authority }));

  for (const table of REBUILT_TABLES) {
    expect([table, rowIdsOf(store.file, table)]).toEqual([table, before[table]]);
  }
  expect(retainedRemoteGraphs(store.file)).toEqual(remoteBefore);
}, 60_000);

it('sees a row that came back under another row id, where the rows alone read as they did', async () => {
  const store = await place(SYNTHETIC);
  const released = new Map(REBUILT_TABLES.map((table) => [table, columnsOf(store.file, table)]));
  const moved = 'adoptions';
  const rowsOfMoved = () =>
    reading(store.file, (database) => digestTable(database, moved, released.get(moved)));
  const before = reading(store.file, (database) => rowIdentities(database, released));
  const rows = rowsOfMoved();

  changing(store.file, (database) => {
    const sql = (
      database
        .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
        .get(`${moved}_no_update`) as {
        sql: string;
      }
    ).sql;
    database.exec(`DROP TRIGGER ${moved}_no_update`);
    database.exec(`UPDATE "${moved}" SET rowid = rowid + 1000000`);
    database.exec(sql);
  });

  const after = reading(store.file, (database) => rowIdentities(database, released));
  expect(tablesWhoseRowIdsMoved(before, before)).toEqual([]);
  expect(tablesWhoseRowIdsMoved(before, after)).toEqual([moved]);
  // The table still holds the rows it held, in the order it held them, which is why the
  // comparison against the backup cannot notice this and the row identities have to.
  expect(rowsOfMoved()).toEqual(rows);
}, 60_000);

describe('a database the upgrade refuses', () => {
  // A preview never refuses a database it can read: it names the outcome and offers no plan.
  // The refusal belongs to the apply, which is the only caller that would change anything.
  async function refuses(expected: {
    previews: ProjectDatabaseUpgradeState | { code: string };
    code: string;
    message?: RegExp;
    prepare?: (store: PlacedSchema29Database) => void;
    authorityOf?: (store: PlacedSchema29Database) => ProjectDatabaseAuthority;
  }): Promise<void> {
    const store = await place(SYNTHETIC);
    expected.prepare?.(store);
    const authority = expected.authorityOf?.(store) ?? store.authority;
    const before = fingerprint(store.file);
    const preview = () => previewDatabaseFileUpgrade({ file: store.file, authority });

    if (typeof expected.previews === 'string')
      expect(preview()).toMatchObject({ state: expected.previews, plan: null, backup: null });
    else expect(refusalOf(preview)).toMatchObject(expected.previews);
    await expect(upgradeDatabaseFile({ file: store.file, authority })).rejects.toMatchObject(
      expected.message
        ? { code: expected.code, message: expected.message }
        : { code: expected.code }
    );

    expect(fingerprint(store.file)).toEqual(before);
    expect(backupsIn(store.projectDirectory)).toBeNull();
  }

  it('refuses a database a newer build wrote', async () => {
    await refuses({
      prepare: (store) =>
        changing(store.file, (database) =>
          database.pragma(`user_version = ${PROJECT_DATABASE_SCHEMA_VERSION + 1}`)
        ),
      previews: 'newer-version',
      code: 'HISTORY_FORMAT_NEWER',
      message: /newer build/,
    });
  }, 60_000);

  it('refuses every development version that was never released', async () => {
    const store = await place(SYNTHETIC);
    for (const version of Array.from(
      { length: PROJECT_DATABASE_SCHEMA_VERSION },
      (_, index) => index
    ).filter((version) => version !== RELEASED_SCHEMA_VERSION)) {
      changing(store.file, (database) => database.pragma(`user_version = ${version}`));
      const before = fingerprint(store.file);

      expect([
        version,
        previewDatabaseFileUpgrade({ file: store.file, authority: store.authority }).state,
      ]).toEqual([version, 'development-version']);
      await expect(
        upgradeDatabaseFile({ file: store.file, authority: store.authority })
      ).rejects.toMatchObject({
        code: 'HISTORY_FORMAT_UNSUPPORTED',
        message: new RegExp(`Schema ${version} was never released`),
      });

      expect([version, fingerprint(store.file)]).toEqual([version, before]);
      expect(backupsIn(store.projectDirectory)).toBeNull();
    }
  }, 120_000);

  it('refuses a schema-29 database carrying one index the release never wrote', async () => {
    await refuses({
      prepare: (store) =>
        changing(store.file, (database) =>
          database.exec('CREATE INDEX added_lookup ON operations(operation_kind)')
        ),
      previews: 'definition-differs',
      code: 'HISTORY_INTEGRITY_REQUIRED',
      message: /does not hold the released definition/,
    });
  }, 60_000);

  it('refuses a schema-29 database whose trigger text differs from the release', async () => {
    await refuses({
      prepare: (store) =>
        changing(store.file, (database) => {
          const sql = (
            database
              .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
              .get('store_identity_no_update') as { sql: string }
          ).sql;
          database.exec('DROP TRIGGER store_identity_no_update');
          database.exec(sql.replace('BEGIN', 'BEGIN '));
        }),
      previews: 'definition-differs',
      code: 'HISTORY_INTEGRITY_REQUIRED',
      message: /does not hold the released definition/,
    });
  }, 60_000);

  it('refuses another store as the caller of this one', async () => {
    await refuses({
      authorityOf: (store) => ({ ...store.authority, projectId: uuidv7() }),
      previews: { code: 'AUTHORITY_MISMATCH' },
      code: 'AUTHORITY_MISMATCH',
    });
    await refuses({
      authorityOf: (store) => ({ ...store.authority, storeInstanceId: uuidv7() }),
      previews: { code: 'HISTORY_MISSING' },
      code: 'HISTORY_MISSING',
    });
  }, 60_000);

  it('refuses a store whose activation row is not there to read', async () => {
    await refuses({
      prepare: (store) =>
        changing(store.file, (database) => {
          const sql = (
            database
              .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
              .get('activation_no_delete') as { sql: string }
          ).sql;
          database.exec('DROP TRIGGER activation_no_delete');
          database.exec('DELETE FROM activation WHERE singleton = 1');
          database.exec(sql);
        }),
      previews: { code: 'ACTIVATION_PENDING' },
      code: 'ACTIVATION_PENDING',
      message: /initialization is incomplete/,
    });
  }, 60_000);

  it('refuses a database that is not write-ahead-log storage', async () => {
    await refuses({
      prepare: (store) =>
        changing(store.file, (database) => database.pragma('journal_mode = DELETE')),
      previews: { code: 'HISTORY_FORMAT_UNSUPPORTED' },
      code: 'HISTORY_FORMAT_UNSUPPORTED',
      message: /not WAL storage/,
    });
  }, 60_000);

  it('refuses a database that holds a broken reference', async () => {
    const store = await place(SYNTHETIC);
    changing(store.file, (database) => {
      database.pragma('foreign_keys = OFF');
      const sql = (
        database
          .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
          .get('claim_revisions_no_delete') as { sql: string }
      ).sql;
      database.exec('DROP TRIGGER claim_revisions_no_delete');
      database
        .prepare(
          'DELETE FROM claim_revisions WHERE revision_id = (SELECT claim_revision_id FROM assessments LIMIT 1)'
        )
        .run();
      database.exec(sql);
    });
    const before = fingerprint(store.file);
    expect(reading(store.file, (database) => database.pragma('foreign_key_check'))).not.toEqual([]);
    // The definition is still the released one, so the preview reports what the version says and
    // the apply is where the database's own references are judged.
    expect(previewDatabaseFileUpgrade({ file: store.file, authority: store.authority }).state).toBe(
      'upgrade-required'
    );

    await expect(
      upgradeDatabaseFile({ file: store.file, authority: store.authority })
    ).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
      message: /holds broken references/,
    });

    expect(fingerprint(store.file)).toEqual(before);
    expect(backupsIn(store.projectDirectory)).toBeNull();
  }, 60_000);

  it('refuses a database one of whose pages was written over', async () => {
    const store = await place(SYNTHETIC);
    // With the log folded in, the file on disk is the whole database. Overwriting the cell
    // content at the end of a page leaves the schema, the store identity and every reference
    // where they were, so the integrity check is the only thing that can refuse it.
    changing(store.file, () => {});
    const pageSize = reading(store.file, (database) =>
      database.pragma('page_size', { simple: true })
    ) as number;
    const bytes = readFileSync(store.file);
    for (let index = 5 * pageSize - 48; index < 5 * pageSize - 32; index++) bytes[index]! ^= 0xff;
    writeFileSync(store.file, bytes);
    const before = fingerprint(store.file);
    expect(
      reading(store.file, (database) => database.pragma('integrity_check', { simple: true }))
    ).not.toBe('ok');
    expect(reading(store.file, (database) => database.pragma('foreign_key_check'))).toEqual([]);

    await expect(
      upgradeDatabaseFile({ file: store.file, authority: store.authority })
    ).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
      message: /failed its integrity check/,
    });

    expect(fingerprint(store.file)).toEqual(before);
    expect(backupsIn(store.projectDirectory)).toBeNull();
  }, 60_000);
});

// Each of these leaves before the database is touched at all: the copy is what failed.
describe('a backup the upgrade cannot verify', () => {
  const backupPragma = (source: string, replacement: unknown) => {
    const original = Database.prototype.pragma;
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      pragma: string,
      options?: Database.PragmaOptions
    ) {
      return pragma === source && this.name.endsWith(BACKUP_DATABASE_FILE)
        ? replacement
        : original.call(this, pragma, options);
    });
  };

  async function refusesTheBackup(
    store: PlacedSchema29Database,
    expected: { message: RegExp },
    interfere?: (pendingDirectory: string) => void
  ): Promise<void> {
    const parent = path.join(store.projectDirectory, BACKUP_DIRECTORY);
    const before = fingerprint(store.file);
    // The pending directory is made before the copy into it begins, so a test can act on it
    // between the two.
    const upgrading = upgradeDatabaseFile({ file: store.file, authority: store.authority });
    interfere?.(path.join(parent, readdirSync(parent)[0]!));

    await expect(upgrading).rejects.toMatchObject({
      code: 'HISTORY_BACKUP_UNVERIFIED',
      message: expected.message,
    });

    expect(readdirSync(parent)).toEqual([]);
    expect(fingerprint(store.file)).toEqual(before);
  }

  it('refuses when the copy cannot be written', async () => {
    const store = await place(SYNTHETIC);
    await refusesTheBackup(store, { message: /could not be written/ }, (pending) =>
      mkdirSync(path.join(pending, BACKUP_DATABASE_FILE))
    );
  }, 60_000);

  it('refuses when the copy cannot be made self-contained', async () => {
    const store = await place(SYNTHETIC);
    backupPragma('journal_mode = DELETE', 'wal');
    await refusesTheBackup(store, { message: /could not be made self-contained/ });
  }, 60_000);

  it('refuses when the copy cannot be read back', async () => {
    const store = await place(SYNTHETIC);
    const original = Database.prototype.exec;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (sql === 'BEGIN' && this.name.endsWith(BACKUP_DATABASE_FILE))
        throw new Error('the copy cannot be read');
      return original.call(this, sql);
    });
    await refusesTheBackup(store, { message: /cannot be read back/ });
  }, 60_000);

  it('refuses when the copy does not pass its own integrity check', async () => {
    const store = await place(SYNTHETIC);
    backupPragma('integrity_check', 'malformed');
    await refusesTheBackup(store, { message: /failed its integrity check/ });
  }, 60_000);

  it('refuses when the copy holds a broken reference', async () => {
    const store = await place(SYNTHETIC);
    backupPragma('foreign_key_check', [{ table: 'adoptions', rowid: 1, parent: 'operations' }]);
    await refusesTheBackup(store, { message: /holds broken references/ });
  }, 60_000);
});

describe('an interrupted upgrade', () => {
  it('reports each stage of the transition once, in the order it makes them', async () => {
    const store = await place(SYNTHETIC);
    const reported: ProjectDatabaseUpgradeStage[] = [];

    await upgradeDatabaseFile({ file: store.file, authority: store.authority }, (stage) =>
      reported.push(stage)
    );

    expect(reported).toEqual(STAGES);
  }, 60_000);

  it('leaves the released database whole when a stage observer throws, and upgrades on the next run', async () => {
    for (const stage of STAGES.filter((reported) => reported !== 'committed')) {
      const store = await place(SYNTHETIC);
      changing(store.file, retainRemoteGraphs);
      const before = snapshot(Database, store.file);

      await expect(
        upgradeDatabaseFile({ file: store.file, authority: store.authority }, (reported) => {
          if (reported === stage) throw new Error(`interrupted at ${reported}`);
        })
      ).rejects.toThrow();

      expect([stage, snapshot(Database, store.file)]).toEqual([stage, before]);
      expect([
        stage,
        reading(store.file, (database) => schemaSqlDigest(readSchemaObjects(database))),
      ]).toEqual([stage, RELEASED_SCHEMA_SQL_SHA256]);
      asUpgraded(await upgradeDatabaseFile({ file: store.file, authority: store.authority }));
    }
  }, 180_000);

  it('never says the database is unchanged when an observer throws after the commit', async () => {
    const store = await place(SYNTHETIC);

    await expect(
      upgradeDatabaseFile({ file: store.file, authority: store.authority }, (reported) => {
        if (reported === 'committed') throw new Error('interrupted after the commit');
      })
    ).rejects.toMatchObject({ message: 'interrupted after the commit' });

    expect(snapshot(Database, store.file).version).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    const reader = await openProjectDatabase({ authority: store.authority, mode: 'reader' });
    reader.close();
  }, 60_000);

  it('leaves a whole database behind when the process is killed at any point', async () => {
    const directory = await temporaryDirectory('upgrade-crash-');
    const script = path.join(directory, 'upgrade-then-die.mjs');
    await writeFile(
      script,
      `const [module, file, authority, stage] = process.argv.slice(2);
const { upgradeDatabaseFile } = await import(module);
await upgradeDatabaseFile({ file, authority: JSON.parse(authority) }, (reported) => {
  if (reported === stage) process.kill(process.pid, 'SIGKILL');
});
`
    );
    const killedAt = async (stage: ProjectDatabaseUpgradeStage) => {
      const store = await place(SYNTHETIC);
      const run = spawnSync(
        process.execPath,
        [script, UPGRADE_MODULE, store.file, JSON.stringify(store.authority), stage],
        { encoding: 'utf8' }
      );
      expect([stage, run.signal, run.stderr]).toEqual([stage, 'SIGKILL', '']);
      return store;
    };

    for (const stage of ['table-dropped:record_relationships', 'before-commit'] as const) {
      const store = await killedAt(stage);
      expect([
        stage,
        reading(store.file, (database) => database.pragma('user_version', { simple: true })),
      ]).toEqual([stage, RELEASED_SCHEMA_VERSION]);
      expect([
        stage,
        reading(store.file, (database) => schemaSqlDigest(readSchemaObjects(database))),
      ]).toEqual([stage, RELEASED_SCHEMA_SQL_SHA256]);
      asUpgraded(await upgradeDatabaseFile({ file: store.file, authority: store.authority }));
    }

    const committed = await killedAt('committed');
    expect(snapshot(Database, committed.file).version).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    const reader = await openProjectDatabase({ authority: committed.authority, mode: 'reader' });
    reader.close();
  }, 180_000);
});

describe('the backup an apply that refused left behind', () => {
  const interrupted = (store: PlacedSchema29Database) =>
    expect(
      upgradeDatabaseFile({ file: store.file, authority: store.authority }, (stage) => {
        if (stage === 'rows-restored')
          throw new Error('interrupted after the backup was published');
      })
    ).rejects.toThrow();

  // A row the current schema's endpoint trigger refuses on the way back in. The database is
  // still admitted, its references and its integrity are whole, and every apply fails the same
  // way, which is what makes an unverified backup pile up one copy per attempt.
  function relationshipWithoutItsEndpointRevision(file: string): void {
    changing(file, (database) => {
      const guard = (
        database
          .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
          .get('record_relationship_to_endpoint') as { sql: string }
      ).sql;
      database.exec('DROP TRIGGER record_relationship_to_endpoint');
      database
        .prepare(
          `INSERT INTO record_relationships (relationship_id, relation, from_entity_kind, from_entity_id, from_revision_id, to_entity_kind, to_entity_id, to_revision_id, scope_kind, scope_value, attributed_kind, attributed_to, source_refs_json, operation_id)
           SELECT ?, relation, from_entity_kind, from_entity_id, from_revision_id, to_entity_kind, to_entity_id, ?, scope_kind, scope_value, attributed_kind, attributed_to, source_refs_json, operation_id
           FROM record_relationships ORDER BY rowid LIMIT 1`
        )
        .run(uuidv7(), uuidv7());
      database.exec(guard);
    });
  }

  it('verifies that backup and reuses it rather than copying the database again', async () => {
    const store = await place(SYNTHETIC);
    const before = snapshot(Database, store.file);
    await interrupted(store);
    const published = backupsIn(store.projectDirectory);
    expect(published).toHaveLength(1);

    const result = asUpgraded(
      await upgradeDatabaseFile({ file: store.file, authority: store.authority })
    );

    expect([result.backupReused, result.backup.name]).toEqual([true, published![0]]);
    expect(backupsIn(store.projectDirectory)).toEqual(published);
    expect(snapshot(Database, result.backup.databaseFile)).toEqual(before);
  }, 60_000);

  it('publishes no second copy when the transition refuses the same database every time', async () => {
    const store = await place(SYNTHETIC);
    relationshipWithoutItsEndpointRevision(store.file);
    const before = snapshot(Database, store.file);
    const refused: string[] = [];

    for (let attempt = 0; attempt < 3; attempt++)
      refused.push(
        await upgradeDatabaseFile({ file: store.file, authority: store.authority }).then(
          (result) => result.outcome,
          (cause: { code: string }) => cause.code
        )
      );

    expect(refused).toEqual(['TRANSACTION_FAILED', 'TRANSACTION_FAILED', 'TRANSACTION_FAILED']);
    expect(backupsIn(store.projectDirectory)).toHaveLength(1);
    expect(snapshot(Database, store.file)).toEqual(before);
  }, 120_000);

  it('copies the database again when one byte of a published backup was written over', async () => {
    const store = await place(SYNTHETIC);
    await interrupted(store);
    const [name] = backupsIn(store.projectDirectory)!;
    const directory = path.join(store.projectDirectory, BACKUP_DIRECTORY, name!);
    const file = path.join(directory, BACKUP_DATABASE_FILE);
    const manifest = JSON.parse(
      readFileSync(path.join(directory, BACKUP_MANIFEST_FILE), 'utf8')
    ) as { database: { sha256: string; content_sha256: string } };
    const pageSize = reading(file, (database) =>
      database.pragma('page_size', { simple: true })
    ) as number;
    const tampered = readFileSync(file);
    // Unallocated space inside a page: every row the copy holds reads back as it did, so the
    // hash of the file itself is the only thing that can tell it was written over.
    tampered[2 * pageSize + Math.floor(pageSize / 2)]! ^= 0xff;
    writeFileSync(file, tampered);
    expect(reading(file, (database) => digestOfDigests(digestTables(database)))).toBe(
      manifest.database.content_sha256
    );
    expect(createHash('sha256').update(tampered).digest('hex')).not.toBe(manifest.database.sha256);

    const result = asUpgraded(
      await upgradeDatabaseFile({ file: store.file, authority: store.authority })
    );

    expect(result.backupReused).toBe(false);
    expect(backupsIn(store.projectDirectory)).toHaveLength(2);
    expect(result.backup.name).not.toBe(name);
    // Nothing here removes or repairs a published backup, whatever it turns out to hold.
    expect(readFileSync(file)).toEqual(tampered);
  }, 60_000);
});

describe('an upgrade beside other work', () => {
  it('starts preparation over when a writer commits while the backup is taken', async () => {
    const store = await place(SYNTHETIC);
    const reported: ProjectDatabaseUpgradeStage[] = [];
    let raced: FixtureSnapshot | undefined;
    const writer = new Database(store.file, { fileMustExist: true });
    try {
      const result = await upgradeDatabaseFile(
        { file: store.file, authority: store.authority },
        (stage) => {
          reported.push(stage);
          if (stage !== 'backup-verified' || raced) return;
          writer
            .prepare(
              'UPDATE project_counters SET write_sequence = write_sequence + 1 WHERE singleton = 1'
            )
            .run();
          raced = snapshot(Database, store.file);
        }
      );

      expect(reported.filter((stage) => stage === 'backup-verified')).toHaveLength(2);
      expect(snapshot(Database, asUpgraded(result).backup.databaseFile)).toEqual(raced);
    } finally {
      writer.close();
    }
  }, 60_000);

  // A row of maintenance that moves neither counter, so the counter comparison cannot be what
  // notices it: only the table digests can.
  const raceWithoutACounter = (writer: Database.Database, mark: string) =>
    writer
      .prepare(
        `INSERT INTO artifact_touched_files (artifact_id, file_path)
         SELECT artifact_id, ? FROM artifacts ORDER BY artifact_id LIMIT 1`
      )
      .run(`raced/${mark}`);

  it('starts preparation over when a writer commits without moving a counter', async () => {
    const store = await place(SYNTHETIC);
    const before = counters(store.file);
    const reported: ProjectDatabaseUpgradeStage[] = [];
    let raced: FixtureSnapshot | undefined;
    const writer = new Database(store.file, { fileMustExist: true });
    try {
      const result = await upgradeDatabaseFile(
        { file: store.file, authority: store.authority },
        (stage) => {
          reported.push(stage);
          if (stage !== 'backup-verified' || raced) return;
          raceWithoutACounter(writer, 'once');
          raced = snapshot(Database, store.file);
        }
      );

      expect(reported.filter((stage) => stage === 'backup-verified')).toHaveLength(2);
      expect(counters(store.file)).toEqual(before);
      expect(snapshot(Database, asUpgraded(result).backup.databaseFile)).toEqual(raced);
    } finally {
      writer.close();
    }
  }, 60_000);

  it('refuses a database a writer changes on every attempt, having published no backup', async () => {
    const store = await place(SYNTHETIC);
    const before = snapshot(Database, store.file);
    const reported: ProjectDatabaseUpgradeStage[] = [];
    const writer = new Database(store.file, { fileMustExist: true });
    let races = 0;
    try {
      await expect(
        upgradeDatabaseFile({ file: store.file, authority: store.authority }, (stage) => {
          reported.push(stage);
          if (stage !== 'backup-verified') return;
          races += 1;
          raceWithoutACounter(writer, String(races));
        })
      ).rejects.toMatchObject({
        code: 'STALE_CONTEXT',
        message: /kept changing while it was being backed up/,
      });
    } finally {
      writer.close();
    }

    expect(reported).toEqual(['backup-verified', 'backup-verified', 'backup-verified']);
    expect(backupsIn(store.projectDirectory)).toEqual([]);
    const after = snapshot(Database, store.file);
    expect(after.version).toBe(RELEASED_SCHEMA_VERSION);
    expect(reading(store.file, (database) => schemaSqlDigest(readSchemaObjects(database)))).toBe(
      RELEASED_SCHEMA_SQL_SHA256
    );
    expect(after.rows.artifact_touched_files).toHaveLength(
      before.rows.artifact_touched_files!.length + races
    );
  }, 60_000);

  it('changes nothing while another writer holds the lock', async () => {
    const store = await place(SYNTHETIC);
    const before = fingerprint(store.file);
    const holder = new Database(store.file, { fileMustExist: true });
    try {
      holder.exec('BEGIN IMMEDIATE');

      await expect(
        upgradeDatabaseFile({
          file: store.file,
          authority: store.authority,
          busyTimeoutMs: 50,
        })
      ).rejects.toMatchObject({
        code: 'TRANSACTION_RETRY_EXHAUSTED',
        message: /Another writer holds the database/,
      });

      expect(fingerprint(store.file)).toEqual(before);
      expect(backupsIn(store.projectDirectory)).toEqual([]);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 60_000);

  it('stops before it takes a backup when the caller has already cancelled', async () => {
    const store = await place(SYNTHETIC);
    const before = fingerprint(store.file);

    await expect(
      upgradeDatabaseFile({
        file: store.file,
        authority: store.authority,
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(fingerprint(store.file)).toEqual(before);
    expect(backupsIn(store.projectDirectory)).toBeNull();
  }, 60_000);
});

// A database released several versions ago is carried through every step in one transaction, and
// the chain has one real link today. The second step here is the test's own and names no schema
// version this build writes: it only has to be a step, so that the walk is exercised rather than
// asserted about.
describe('a chain of more than one step', () => {
  const EXTRA_TABLE = `CREATE TABLE later_schema_probe (
  probe_id TEXT PRIMARY KEY CHECK (length(probe_id)>0)
) STRICT;`;
  const steps: ProjectDatabaseUpgradeStep[] = [
    ...PROJECT_DATABASE_UPGRADE_STEPS,
    {
      from: PROJECT_DATABASE_SCHEMA_VERSION,
      to: PROJECT_DATABASE_SCHEMA_VERSION + 1,
      schema: `${PROJECT_DATABASE_SCHEMA}${EXTRA_TABLE}`,
      rebuiltTables: [],
    },
  ];

  it('carries a released database through every step in one transaction', async () => {
    const store = await place(SYNTHETIC);
    const before = snapshot(Database, store.file);

    const preview = previewDatabaseFileUpgrade(
      { file: store.file, authority: store.authority },
      steps
    );
    expect(preview.plan!.steps.map((step) => [step.fromVersion, step.toVersion])).toEqual([
      [RELEASED_SCHEMA_VERSION, PROJECT_DATABASE_SCHEMA_VERSION],
      [PROJECT_DATABASE_SCHEMA_VERSION, PROJECT_DATABASE_SCHEMA_VERSION + 1],
    ]);
    expect(preview.plan!.createdObjects.map((object) => object.name)).toContain(
      'later_schema_probe'
    );

    const observed: ProjectDatabaseUpgradeStage[] = [];
    const result = asUpgraded(
      await upgradeDatabaseFile(
        { file: store.file, authority: store.authority },
        (stage) => observed.push(stage),
        steps
      )
    );

    expect(result.plan.toVersion).toBe(PROJECT_DATABASE_SCHEMA_VERSION + 1);
    // One transition per step, inside the one backup and the one commit.
    expect(observed.filter((stage) => stage === 'rows-restored')).toHaveLength(2);
    expect(observed.filter((stage) => stage === 'committed')).toHaveLength(1);

    const after = snapshot(Database, store.file);
    expect(after.version).toBe(PROJECT_DATABASE_SCHEMA_VERSION + 1);
    expect(after.foreignKeys).toEqual([]);
    expect(after.rows.later_schema_probe).toEqual([]);
    expect(after.rows.evaluator_findings).toEqual([]);
    for (const [table, rows] of Object.entries(before.rows))
      expect(
        after.rows[table]!.map((row) =>
          Object.fromEntries(Object.keys(rows[0] ?? {}).map((column) => [column, row[column]]))
        ),
        table
      ).toEqual(rows);
  }, 120_000);

  it('leaves the released database when a later step fails, verified from the backup', async () => {
    const store = await place(SYNTHETIC);
    const before = snapshot(Database, store.file);
    const branches = before.rows.artifact_branches!.length;
    expect(branches, 'the copy-back has to have a row to fail on').toBeGreaterThan(0);

    // A second step that rebuilds a released table and cannot fill the column it adds: the
    // copy-back runs after the first step has already dropped, created and restored its own.
    const failing: ProjectDatabaseUpgradeStep = {
      from: PROJECT_DATABASE_SCHEMA_VERSION,
      to: PROJECT_DATABASE_SCHEMA_VERSION + 1,
      schema: PROJECT_DATABASE_SCHEMA.replace(
        '  PRIMARY KEY (artifact_id, branch)\n) STRICT;',
        '  later_probe TEXT,\n  PRIMARY KEY (artifact_id, branch)\n) STRICT;'
      ),
      rebuiltTables: [['artifact_branches', { later_probe: 'no_such_function()' }]],
    };
    expect(failing.schema).not.toBe(PROJECT_DATABASE_SCHEMA);

    const observed: ProjectDatabaseUpgradeStage[] = [];
    await expect(
      upgradeDatabaseFile(
        { file: store.file, authority: store.authority },
        (stage) => observed.push(stage),
        [...PROJECT_DATABASE_UPGRADE_STEPS, failing]
      )
    ).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });

    // The first step had restored its rows and the second had dropped its own table when it
    // failed, so the transaction it all sits in is what put the database back.
    expect(observed).toContain('rows-restored');
    expect(observed).toContain('table-dropped:artifact_branches');
    expect(observed).not.toContain('committed');

    const after = snapshot(Database, store.file);
    expect(after.version).toBe(RELEASED_SCHEMA_VERSION);
    expect(after).toEqual(before);

    const published = backupsIn(store.projectDirectory)!;
    expect(published).toHaveLength(1);
    const copy = path.join(
      store.projectDirectory,
      BACKUP_DIRECTORY,
      published[0]!,
      BACKUP_DATABASE_FILE
    );
    expect(snapshot(Database, copy)).toEqual(before);
  }, 120_000);

  it('refuses a chain that cannot reach the schema this build writes', async () => {
    const store = await place(SYNTHETIC);
    const before = fingerprint(store.file);

    await expect(
      upgradeDatabaseFile({ file: store.file, authority: store.authority }, () => {}, [
        {
          from: PROJECT_DATABASE_SCHEMA_VERSION,
          to: PROJECT_DATABASE_SCHEMA_VERSION + 1,
          schema: `${PROJECT_DATABASE_SCHEMA}${EXTRA_TABLE}`,
          rebuiltTables: [],
        },
      ])
    ).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      message: /no chain of upgrade steps carries schema 29/,
    });

    expect(fingerprint(store.file)).toEqual(before);
    expect(backupsIn(store.projectDirectory)).toBeNull();
  }, 60_000);
});
