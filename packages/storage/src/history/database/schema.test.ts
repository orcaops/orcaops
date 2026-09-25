import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';

import {
  initializeProjectDatabase,
  openProjectDatabase,
  readProjectInitializationCandidate,
} from './connection.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';
import { runProjectOperation } from './transactions.js';
import {
  type RestoredFixture,
  restoreFixture,
  snapshot,
} from '../../../tests/database-fixture.mjs';

const fixtures: RestoredFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
async function populated() {
  const fixture = await restoreFixture(
    new URL('../../../../../', import.meta.url).pathname,
    new URL('./fixtures/current.json', import.meta.url).pathname
  );
  fixtures.push(fixture);
  return fixture;
}

it('initializes the complete supported schema with the retained table, index and trigger definitions', async () => {
  const fixture = await populated();
  const expected = snapshot(Database, fixture.file).definitions;
  const database = new Database(':memory:');
  try {
    database.exec(PROJECT_DATABASE_SCHEMA);
    const actual = database
      .prepare(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name'
      )
      .all();
    const normalized = (values: unknown) =>
      JSON.parse(
        JSON.stringify(values, (key, value) =>
          key === 'sql' ? value.replace(/\s+/g, ' ').trim() : value
        )
      );
    expect(normalized(actual)).toEqual(normalized(expected));
    expect(database.pragma('user_version', { simple: true })).toBe(PROJECT_DATABASE_SCHEMA_VERSION);
    expect(PROJECT_DATABASE_SCHEMA_VERSION).toBe(33);
    expect(PROJECT_DATABASE_SCHEMA.match(/PRAGMA user_version/g)).toHaveLength(1);
    expect(PROJECT_DATABASE_SCHEMA).not.toMatch(/ALTER TABLE/);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('table_info(reviews)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'branch', notnull: 0 })])
    );
  } finally {
    database.close();
  }
});

it('gives every schema object a name no other object shares', () => {
  // SQLite lets a trigger and an index share a name, and the open path keys observed objects by
  // name, so with a shared name one of the two never matches and every open is refused.
  const database = new Database(':memory:');
  try {
    database.exec(PROJECT_DATABASE_SCHEMA);
    const names = (
      database.prepare('SELECT name FROM sqlite_schema').all() as { name: string }[]
    ).map((object) => object.name);
    const shared = names.filter((name, index) => names.indexOf(name) !== index);
    expect(shared).toEqual([]);
  } finally {
    database.close();
  }
});

it('reopens populated current history and replays original receipts without changing any row', async () => {
  const fixture = await populated();
  const before = snapshot(Database, fixture.file);
  for (const table of [
    'artifact_events',
    'artifact_revisions',
    'operations',
    'review_comments',
    'review_comment_revisions',
    'review_workflow_transitions',
    'review_evidence_members',
    'decisions',
    'decision_revisions',
    'claims',
    'claim_revisions',
    'record_relationships',
    'adoptions',
    'assessments',
    'criterion_lineage',
  ])
    expect(before.rows[table].length, table).toBeGreaterThan(0);
  for (const mode of ['reader', 'writer'] as const) {
    const handle = await openProjectDatabase({ authority: fixture.authority, mode });
    try {
      expect(
        handle.read((view) => view.all('SELECT * FROM artifact_revisions')).value.length
      ).toBeGreaterThan(0);
      if (mode === 'writer') {
        for (const row of before.rows.operations) {
          const replay = await runProjectOperation(
            handle,
            {
              operationId: row.operation_id as string,
              kind: row.operation_kind as string,
              target: JSON.parse(row.target_json as string),
              payload: JSON.parse(row.payload_json as string),
              expectedState: JSON.parse(row.expected_state_json as string),
              intentChange: row.intent_change === 1,
            },
            () => {
              throw new Error('A retained receipt must not execute settlement again');
            }
          );
          expect(replay.replayed).toBe(true);
          expect(replay.value).toEqual(JSON.parse(row.result_json as string));
        }
      }
    } finally {
      handle.close();
    }
  }
  expect(snapshot(Database, fixture.file)).toEqual(before);
});

// A passive open never migrates. It tells the released predecessor, which has an explicit
// upgrade, apart from a development version that never shipped and from a format a newer build
// wrote, and it says so without reading anything else from the file.
const READ_OUTCOMES = [
  ...Array.from(
    { length: 29 },
    (_, version) => [version, 'HISTORY_FORMAT_UNSUPPORTED'] as [number, string]
  ),
  [29, 'HISTORY_UPGRADE_REQUIRED'] as [number, string],
  [30, 'HISTORY_FORMAT_UNSUPPORTED'] as [number, string],
  [31, 'HISTORY_FORMAT_UNSUPPORTED'] as [number, string],
  [32, 'HISTORY_FORMAT_UNSUPPORTED'] as [number, string],
  [99, 'HISTORY_FORMAT_NEWER'] as [number, string],
];

it.each(READ_OUTCOMES)(
  'answers schema %s with %s for reads, writes, discovery and initialization without replacing history',
  async (version, code) => {
    const fixture = await populated();
    const raw = new Database(fixture.file);
    raw.pragma(`user_version = ${version}`);
    raw.close();
    const before = snapshot(Database, fixture.file);
    const bytes = await readFile(fixture.file);
    const identity = before.rows.store_identity[0];
    const refused: unknown[] = [];
    for (const mode of ['reader', 'writer'] as const) {
      refused.push(
        await openProjectDatabase({ authority: fixture.authority, mode }).catch((cause) => cause)
      );
    }
    refused.push(
      await readProjectInitializationCandidate({
        root: fixture.authority.resolvedRoot,
        projectId: fixture.authority.projectId,
      }).catch((cause) => cause)
    );
    refused.push(
      await initializeProjectDatabase({
        authority: fixture.authority,
        initializationOperationId: identity.initialization_operation_id as string,
        initializedAt: before.rows.activation[0].initialized_at as string,
        authorize() {},
      }).catch((cause) => cause)
    );
    for (const outcome of refused) {
      expect(outcome).toMatchObject({ code });
      const message = (outcome as Error).message;
      expect(message).toMatch(new RegExp(`\\b${version}\\b`));
      expect(message).not.toMatch(/rebuild|reinitializ|re-initializ|delete/i);
      if (code === 'HISTORY_UPGRADE_REQUIRED') expect(message).toContain('orcaops history upgrade');
    }
    expect(snapshot(Database, fixture.file)).toEqual(before);
    expect(await readFile(fixture.file)).toEqual(bytes);
  },
  15_000
);
