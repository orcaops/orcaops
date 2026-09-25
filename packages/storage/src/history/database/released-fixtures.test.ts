import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { openProjectDatabase, readProjectInitializationCandidate } from './connection.js';
import { PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { snapshot } from '../../../tests/database-fixture.mjs';
import { exactRevisionTables } from '../../../tests/push-upgrade-fixture.js';
import {
  blobBytes,
  countBy,
  databaseDigest,
  materializeOriginalDatabase,
  readReleasedFixture,
  restoreFixtureImage,
  restoreReleasedFixture,
  schemaDigests,
  tableDigest,
  validateOwnDefinitions,
} from '../../../tests/released-fixture.mjs';

const RELEASES = ['0.2.0', '0.2.1'];
const CONVERTED = '0.2.1-converted-from-0.2.0-rc.2';
const FIXTURES = [...RELEASES, CONVERTED];
const candidate = new URL('../../../../../', import.meta.url).pathname;

// Pinned here as well as in each manifest: regenerating a fixture together with its manifest
// would otherwise pass every comparison below. The integrity strings are the registry's own.
const FROZEN: Record<string, { content: string; rows: [alone: number, total: number] }> = {
  '0.2.0': {
    content: 'f51aad108d80f152967642b2b1e253683bcbd7c2afebd5ff0f61ef7186a959e2',
    rows: [879, 901],
  },
  '0.2.1': {
    content: '3172a771f835aee77c3eaa4a61b2362c2d3d9f7000b080309b77dbc917a0b00f',
    rows: [879, 901],
  },
  [CONVERTED]: {
    content: '0b41e988babc49ae7081f4eac01f4ad9c2ecea164ef99aa1769aa572c20ca231',
    rows: [76, 76],
  },
};
const REGISTRY_INTEGRITY: Record<string, string> = {
  '0.2.0-rc.2':
    'sha512-+4K56jtgJWrnQ5/n8yXHprroFGktUALqh77qgyUTBoNFVcvt+D6K6BOADNzNqUS6Fs5t2ci0tIgqpeHt3I3mGQ==',
  '0.2.0':
    'sha512-DFg3kVgrk50FeToQ+ex4A1AkDvwRZd2FPOEwLpxDoghUQawQvchInY7NRs8+RfdGzjWMWJ5qGnTUQW4jsL2hBw==',
  '0.2.1':
    'sha512-bHA4s5Dc4x9gYLGlQfzErdXD5QdIB2VC2TXtvpTRxXNsm08yql9Nqcrmp0WVprY0ZR89Q2t4laC4utznclNuCQ==',
};
const FROZEN_SCHEMA_SQL_SHA256 = '6ddee53aff2eae90328c12fb91d84b8214b8e9ee3fcac61f2b4b91c54d1f1c77';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const totalRows = (rows: Record<string, unknown[]>) =>
  Object.values(rows).reduce((sum, records) => sum + records.length, 0);

function eventPayloads(rows: Record<string, Array<Record<string, unknown>>>, type: string) {
  return rows
    .artifact_events!.filter((row) => row.event_type === type)
    .map((row) => JSON.parse(blobBytes(row.record_bytes).toString('utf8')).payload);
}

describe.each(FIXTURES)('the project database frozen as cli-%s', (name) => {
  it('matches every content hash its manifest records', async () => {
    const { manifest, database, schema, bundle } = await readReleasedFixture(name);
    const { content } = manifest;

    expect([manifest.schema.user_version, database.schemaVersion, schema.schemaVersion]).toEqual([
      29, 29, 29,
    ]);
    const { file, user_version, shared_definition, ...recordedSchema } = manifest.schema;
    expect([file, user_version, typeof shared_definition]).toEqual([
      '../schema.json',
      29,
      'string',
    ]);
    expect(schemaDigests(schema.definitions)).toEqual(recordedSchema);
    expect(recordedSchema.sql_sha256).toBe(FROZEN_SCHEMA_SQL_SHA256);

    const definedTables = schema.definitions
      .filter((object) => object.type === 'table')
      .map((object) => object.name)
      .sort();
    expect(Object.keys(database.rows).sort()).toEqual(definedTables);
    expect([...Object.keys(content.tables), ...Object.keys(content.empty_tables)].sort()).toEqual(
      definedTables
    );
    for (const [table, recorded] of Object.entries(content.tables)) {
      expect({
        table,
        rows: database.rows[table]!.length,
        sha256: tableDigest(database.rows[table]!),
      }).toEqual({ table, ...recorded });
    }
    expect(databaseDigest(database.rows)).toBe(content.sha256);
    expect(content.sha256).toBe(FROZEN[name]!.content);
    expect(totalRows(database.rows)).toBe(manifest.original_database.total_rows);

    expect(countBy(database.rows.operations!, 'operation_kind')).toEqual(
      content.operations_by_kind
    );
    expect(countBy(database.rows.artifact_events!, 'event_type')).toEqual(content.events_by_type);
    expect({ bytes: bundle.length, sha256: sha256(bundle) }).toEqual({
      bytes: manifest.retained_git_evidence.bundle.bytes,
      sha256: manifest.retained_git_evidence.bundle.sha256,
    });
    expect(content.review_evidence).toEqual({
      files: database.evidence.length,
      bytes: database.evidence.reduce((sum, file) => sum + blobBytes(file.bytes).length, 0),
      sha256: sha256(
        database.evidence.map((file) => `${file.relativePath} ${file.sha256}`).join('\n')
      ),
    });
  });

  it('names published packages as its producers, never a workspace build', async () => {
    const { manifest, database } = await readReleasedFixture(name);
    const producers = [manifest.producer, manifest.legacy_producer].filter(
      (producer) => producer !== undefined
    );

    expect(producers.map((producer) => producer.version).join('-converted-from-')).toBe(name);
    for (const producer of producers) {
      const tarball = `https://registry.npmjs.org/@orcaops/cli/-/cli-${producer.version}.tgz`;
      expect(producer.package).toBe('@orcaops/cli');
      expect([producer.installed.version, producer.installed.reported_version]).toEqual([
        producer.version,
        producer.version,
      ]);
      expect([producer.registry.tarball, producer.installed.resolved]).toEqual([tarball, tarball]);
      expect([
        producer.registry.integrity,
        producer.tarball.integrity,
        producer.installed.integrity,
      ]).toEqual(Array(3).fill(REGISTRY_INTEGRITY[producer.version]));
      expect(producer.tarball.shasum).toBe(producer.registry.shasum);
    }
    expect(manifest.generation.command).toMatch(
      /^node packages\/storage\/tests\/released-(producer-database|legacy-conversion)\.generate\.mjs /
    );
    expect(
      manifest.generation.isolation.user_directories.flatMap((entry) => entry.changed)
    ).toEqual([]);

    const stamps = eventPayloads(database.rows, 'plan_captured')
      .filter((payload) => payload.origin?.kind === 'git-import')
      .map((payload) => payload.origin.tool_version);
    expect([...new Set(stamps)]).toEqual(manifest.content.import_origin_tool_versions);
    if (stamps.length > 0) expect([...new Set(stamps)]).toEqual([manifest.producer.version]);
  });

  it('gives every empty table a reason, and keeps the exact-revision and source-plan tables empty', async () => {
    const { manifest, database } = await readReleasedFixture(name);
    const empty = Object.keys(database.rows).filter((table) => database.rows[table]!.length === 0);
    const sourcePlanTables = Object.keys(database.rows).filter((table) =>
      table.startsWith('source_plan_')
    );

    expect(Object.keys(manifest.content.empty_tables).sort()).toEqual(empty.sort());
    for (const [table, explained] of Object.entries(manifest.content.empty_tables)) {
      expect(manifest.content.empty_table_reasons[explained.reason], table).toMatch(/\w/);
    }
    expect(sourcePlanTables.length).toBeGreaterThan(0);
    for (const table of exactRevisionTables) {
      expect(manifest.content.empty_tables[table], table).toMatchObject({
        reason: 'no_writer_in_the_release',
        insert_statements_in_the_bundle: 0,
      });
    }
    for (const table of sourcePlanTables) {
      expect([table, manifest.content.empty_tables[table]?.reason]).toEqual([
        table,
        'needs_the_cloud_service',
      ]);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/need model calls/);
  });

  it('holds its temporary producer location only where its manifest says, and no home directory', async () => {
    const { manifest, database } = await readReleasedFixture(name);
    const homeRoots = [['', 'Users', ''].join('/'), ['', 'home', ''].join('/')];
    const temporaryRoot = database.rows.store_identity![0]!.resolved_root as string;
    const runDirectory = path.dirname(temporaryRoot);
    const cellsNamingTheRun = new Set<string>();
    const scan = (where: string, text: string) => {
      for (const root of homeRoots) expect(text.includes(root), where).toBe(false);
      return text.includes(runDirectory);
    };

    for (const [table, rows] of Object.entries(database.rows)) {
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          const text =
            typeof value === 'string'
              ? value
              : value && typeof value === 'object'
                ? blobBytes(value).toString('latin1')
                : '';
          if (scan(`${table}.${column}`, text)) cellsNamingTheRun.add(`${table}.${column}`);
        }
      }
    }
    for (const file of database.evidence) {
      expect(scan(file.relativePath, blobBytes(file.bytes).toString('latin1'))).toBe(false);
    }
    const cells = manifest.content.machine_specific_cells;
    expect([...cellsNamingTheRun].sort()).toEqual(cells.naming_the_run_directory);
    expect(cells.naming_the_run_directory).toEqual(
      expect.arrayContaining([
        'repository_creation.common_directory',
        'store_identity.resolved_root',
      ])
    );
    expect(cells.identifying_the_repository).toEqual([
      'repository_creation.device',
      'repository_creation.inode',
      'repository_creation.birthtime_ns',
    ]);
    expect(cells.note).toMatch(/repository identity cannot match after a restore/);
  });

  it('restores under its own schema definition, and this checkout refuses to open it and leaves it unchanged', async () => {
    const { database, schema } = await readReleasedFixture(name);
    const fixture = await restoreReleasedFixture(candidate, name);
    cleanups.push(fixture.cleanup);
    const before = snapshot(Database, fixture.file);
    expect(before.version).toBe(29);
    expect(before.definitions).toEqual(schema.definitions);
    expect(before.foreignKeys).toEqual([]);
    for (const member of database.evidence) {
      const restored = await readFile(
        path.join(path.dirname(fixture.file), 'evidence', member.relativePath)
      );
      expect([member.relativePath, sha256(restored)]).toEqual([member.relativePath, member.sha256]);
    }
    expect(databaseDigest(before.rows)).not.toBe(FROZEN[name]!.content);
    expect(databaseDigest({ ...before.rows, store_identity: database.rows.store_identity! })).toBe(
      FROZEN[name]!.content
    );

    // A passive open never upgrades. It names the released predecessor as one an explicit
    // upgrade carries across, and says which command performs it.
    expect(PROJECT_DATABASE_SCHEMA_VERSION).toBeGreaterThan(29);
    const bytes = await readFile(fixture.file);
    for (const mode of ['reader', 'writer'] as const) {
      await expect(
        openProjectDatabase({ authority: fixture.authority, mode })
      ).rejects.toMatchObject({
        code: 'HISTORY_UPGRADE_REQUIRED',
        message: expect.stringContaining('orcaops history upgrade'),
      });
    }
    await expect(
      readProjectInitializationCandidate({
        root: fixture.authority.resolvedRoot,
        projectId: fixture.authority.projectId,
      })
    ).rejects.toMatchObject({ code: 'HISTORY_UPGRADE_REQUIRED' });
    expect(snapshot(Database, fixture.file)).toEqual(before);
    expect(await readFile(fixture.file)).toEqual(bytes);
  }, 30_000);

  it('restores under the version it was written with, whatever version this checkout expects', async () => {
    const { database, schema } = await readReleasedFixture(name);
    const newerVersion = PROJECT_DATABASE_SCHEMA_VERSION + 70;
    const fixture = await restoreFixtureImage(candidate, {
      schemaVersion: newerVersion,
      definitions: schema.definitions,
      rows: database.rows,
    });
    cleanups.push(fixture.cleanup);

    expect(snapshot(Database, fixture.file).version).toBe(newerVersion);
    await expect(
      openProjectDatabase({ authority: fixture.authority, mode: 'reader' })
    ).rejects.toMatchObject({ code: 'HISTORY_FORMAT_NEWER' });

    const restored = new Database(fixture.file, { readonly: true });
    try {
      const own = { schemaVersion: newerVersion, definitions: schema.definitions };
      expect(() => validateOwnDefinitions(restored, own)).not.toThrow();
      expect(() =>
        validateOwnDefinitions(restored, { ...own, schemaVersion: newerVersion - 1 })
      ).toThrow();
      expect(() =>
        validateOwnDefinitions(restored, { ...own, definitions: schema.definitions.slice(1) })
      ).toThrow();
    } finally {
      restored.close();
    }
  });

  it('carries a bundle that materializes every retained ref its rows name', async () => {
    const { manifest, database, bundle } = await readReleasedFixture(name);
    const directory = await mkdtemp(path.join(tmpdir(), 'released-refs-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const bundleFile = path.join(directory, 'retained-refs.bundle');
    const repository = path.join(directory, 'repository.git');
    await writeFile(bundleFile, bundle);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1' },
      }).trim();
    git('init', '--quiet', '--bare', repository);
    git('-C', repository, 'fetch', '--quiet', bundleFile, 'refs/*:refs/*');

    const named = [
      ...database.rows.git_retention_publications!.map((row) => [row.full_ref, row.object_oid]),
      ...database.rows.legacy_import!.flatMap((row) =>
        (JSON.parse(row.git_resources_json as string) as Array<{ ref: string; oid: string }>).map(
          (resource) => [resource.ref, resource.oid]
        )
      ),
    ].sort();
    const materialized = git('-C', repository, 'for-each-ref', '--format=%(refname) %(objectname)')
      .split('\n')
      .map((line) => line.split(' '))
      .sort();

    expect(named.length).toBeGreaterThan(0);
    expect(materialized).toEqual(named);
    expect(manifest.retained_git_evidence.refs.map(({ ref, object }) => [ref, object])).toEqual(
      named
    );
    for (const { ref, tree } of manifest.retained_git_evidence.refs) {
      expect([ref, git('-C', repository, 'rev-parse', `${ref}^{tree}`)]).toEqual([ref, tree]);
    }
  });

  it('keeps the original database files, whose rows are the frozen rows and partly exist only in the log', async () => {
    const { manifest, database } = await readReleasedFixture(name);
    const original = await materializeOriginalDatabase(name);
    cleanups.push(original.cleanup);
    const recorded = manifest.original_database;

    const alone = await mkdtemp(path.join(tmpdir(), 'released-main-alone-'));
    cleanups.push(() => rm(alone, { recursive: true, force: true }));
    await copyFile(original.main, path.join(alone, 'history.sqlite3'));
    const mainAlone = snapshot(Database, path.join(alone, 'history.sqlite3'));

    const withLog = new Database(original.main, { readonly: true, fileMustExist: true });
    try {
      const pragma = (key: string) => withLog.pragma(key, { simple: true });
      expect(
        Object.fromEntries(Object.keys(recorded.pragmas).map((key) => [key, pragma(key)]))
      ).toEqual(recorded.pragmas);
      expect(recorded.pragmas).toMatchObject({
        application_id: 0,
        user_version: 29,
        journal_mode: 'wal',
        page_size: 4096,
        auto_vacuum: 0,
        encoding: 'UTF-8',
      });
      expect(pragma('integrity_check')).toBe('ok');
    } finally {
      withLog.close();
    }
    expect(snapshot(Database, original.main).rows).toEqual(database.rows);

    const [rowsAlone, rowsTotal] = FROZEN[name]!.rows;
    expect([totalRows(mainAlone.rows), totalRows(database.rows)]).toEqual([rowsAlone, rowsTotal]);
    expect(recorded.write_ahead_log).toMatchObject({
      rows_in_main_file_alone: rowsAlone,
      rows_only_in_the_log: rowsTotal - rowsAlone,
      main_file_alone_integrity_check: 'ok',
    });
    expect(recorded.total_rows).toBe(rowsTotal);
  });
});

it('shares one schema definition between 0.2.0 and 0.2.1 while their rows and workflows still differ', async () => {
  const [older, newer] = await Promise.all(RELEASES.map((name) => readReleasedFixture(name)));
  const digests = ({ manifest }: NonNullable<typeof older>) => ({
    objects: manifest.schema.objects,
    object_kinds: manifest.schema.object_kinds,
    sql_sha256: manifest.schema.sql_sha256,
    whitespace_normalized_sql_sha256: manifest.schema.whitespace_normalized_sql_sha256,
  });
  expect(digests(older!)).toEqual(digests(newer!));
  expect(digests(newer!)).toEqual(schemaDigests(newer!.schema.definitions));
  for (const { manifest } of [older!, newer!]) {
    expect(manifest.schema.shared_definition).toMatch(/can still write different rows/);
  }

  expect(older!.manifest.content.sha256).not.toBe(newer!.manifest.content.sha256);
  expect(older!.manifest.content.import_origin_tool_versions).toEqual(['0.2.0']);
  expect(newer!.manifest.content.import_origin_tool_versions).toEqual(['0.2.1']);
  const refusals = ({ manifest }: NonNullable<typeof older>) =>
    manifest.generation.workflow.filter((step) => !step.ok).map((step) => step.error);
  const shared = [
    'INVALID_INPUT',
    'Floor references a checkpoint not closed in its exact member revision',
  ];
  const blocked = ['BLOCKED', 'BLOCK_NOT_ACKNOWLEDGEABLE'];
  expect(refusals(older!)).toEqual([...shared, 'IDENTITY_RECOVERY_REQUIRED', ...blocked]);
  expect(refusals(newer!)).toEqual([...shared, ...blocked]);
});

it('covers, between the released fixtures, every table a released build can write without the cloud service or a racing writer', async () => {
  const [release, converted] = await Promise.all([
    readReleasedFixture('0.2.1'),
    readReleasedFixture(CONVERTED),
  ]);
  const populated = (fixture: typeof release) =>
    new Set(Object.keys(fixture.manifest.content.tables));
  const uncovered = Object.entries(release.manifest.content.empty_tables).filter(
    ([table]) => !populated(converted).has(table)
  );

  expect([...new Set(uncovered.map(([, explained]) => explained.reason))].sort()).toEqual([
    'needs_racing_writers',
    'needs_the_cloud_service',
    'no_writer_in_the_release',
    'writer_never_reached_in_the_release',
    'written_only_by_legacy_conversion',
  ]);
  expect(
    uncovered
      .filter(([, explained]) => explained.reason === 'written_only_by_legacy_conversion')
      .map(([table]) => table)
      .sort()
  ).toEqual(
    Object.entries(converted.manifest.content.empty_tables)
      .filter(([, explained]) => explained.reason === 'needs_cloud_state_in_the_legacy_history')
      .map(([table]) => table)
      .sort()
  );
  for (const [table, explained] of Object.entries(converted.manifest.content.empty_tables)) {
    if (explained.reason === 'outside_this_conversion') {
      expect(populated(release).has(table), table).toBe(true);
    }
  }
  expect(Object.keys(converted.manifest.content.tables)).toEqual(
    expect.arrayContaining(['legacy_import', 'legacy_sqlite_images', 'plan_idempotency_records'])
  );
  expect(converted.manifest.conversion).toMatchObject({ source_profile: 'orcaops-0.2.0-rc.2' });
});

it('refuses to freeze over a release that is already frozen, and takes no flag that would', async () => {
  const script = fileURLToPath(
    new URL('../../../tests/released-producer-fixture.freeze.mjs', import.meta.url)
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'released-refreeze-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const summary = path.join(directory, 'summary.json');
  await writeFile(
    summary,
    JSON.stringify({
      producer: { package: '@orcaops/cli', version: '0.2.1' },
      isolation: { user_directories: [] },
      database: { path: path.join(directory, 'history.sqlite3') },
    })
  );
  const frozen = (await readReleasedFixture('0.2.1')).manifest.content.sha256;
  const freeze = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  const refused = freeze(summary, directory);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toMatch(/cli-0\.2\.1 exists; a frozen release is never regenerated/);
  const flagged = freeze('--replace-frozen-release', summary, directory);
  expect(flagged.status).not.toBe(0);
  expect(flagged.stderr).toMatch(/usage: released-producer-fixture\.freeze\.mjs <summary\.json>/);
  expect((await readReleasedFixture('0.2.1')).manifest.content.sha256).toBe(frozen);
});
