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
    expect(PROJECT_DATABASE_SCHEMA_VERSION).toBe(29);
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

it.each([...Array.from({ length: 28 }, (_, i) => i + 1), 0, 99])(
  'refuses unsupported schema %s for reads, writes, discovery and initialization without replacing history',
  async (version) => {
    const fixture = await populated();
    const raw = new Database(fixture.file);
    raw.pragma(`user_version = ${version}`);
    raw.close();
    const before = snapshot(Database, fixture.file);
    const bytes = await readFile(fixture.file);
    for (const mode of ['reader', 'writer'] as const) {
      await expect(
        openProjectDatabase({ authority: fixture.authority, mode })
      ).rejects.toMatchObject({
        code: 'HISTORY_FORMAT_UNSUPPORTED',
      });
    }
    await expect(
      readProjectInitializationCandidate({
        root: fixture.authority.resolvedRoot,
        projectId: fixture.authority.projectId,
      })
    ).rejects.toMatchObject({ code: 'HISTORY_FORMAT_UNSUPPORTED' });
    const identity = before.rows.store_identity[0];
    await expect(
      initializeProjectDatabase({
        authority: fixture.authority,
        initializationOperationId: identity.initialization_operation_id as string,
        initializedAt: before.rows.activation[0].initialized_at as string,
        authorize() {},
      })
    ).rejects.toMatchObject({ code: 'HISTORY_FORMAT_UNSUPPORTED' });
    expect(snapshot(Database, fixture.file)).toEqual(before);
    expect(await readFile(fixture.file)).toEqual(bytes);
  },
  15_000
);
