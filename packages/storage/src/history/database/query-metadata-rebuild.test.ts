import Database from 'better-sqlite3';
import { access, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

import {
  queryFixture,
  queryFixtureRoots,
  querySnapshot,
} from '../../../tests/query-metadata-fixture.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import * as provenance from '../metadata-provenance.js';
import { readProjectArtifact } from './artifacts.js';
import { openProjectDatabase } from './connection.js';
import { rebuildProjectQueryMetadata } from './query-metadata-rebuild.js';
import { assertQueryMetadataComplete } from './query-metadata-records.js';
import { queryProjectSearch } from './search.js';
import { runProjectOperation } from './transactions.js';

const derived = new Set([
  'rationale_events',
  'rationale_accounts',
  'rationale_terms',
  'rationale_pending_artifacts',
  'rationale_index_state',
  'artifact_metadata',
  'artifact_branches',
  'artifact_search_sources',
  'artifact_search_state',
  'artifact_touched_files',
  'artifact_query_metadata',
  'execution_query_metadata',
  'execution_query_branches',
]);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    queryFixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const value = await queryFixture();
  await rebuildProjectQueryMetadata({ authority: value.authority, authorize() {} });
  return value;
}
const authorityRows = (rows: ReturnType<typeof querySnapshot>['rows']) =>
  Object.fromEntries(Object.entries(rows).filter(([name]) => !derived.has(name)));
const derivedRows = (rows: ReturnType<typeof querySnapshot>['rows']) =>
  Object.fromEntries(
    Object.entries(rows)
      .filter(([name]) => derived.has(name))
      .map(([name, values]) => [name, values.map((value) => JSON.stringify(value)).sort()])
  );
it('rebuilds damaged query indexes while retaining every authoritative row and original search order', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  const originalSearch = queryProjectSearch(reader, { query: ['original'], limit: 100 });
  const damaged = new Database(file);
  try {
    for (const table of derived) damaged.exec(`DELETE FROM ${table}`);
  } finally {
    damaged.close();
  }
  const incomplete = querySnapshot(file);
  try {
    expect(() =>
      reader.read((view) => {
        assertQueryMetadataComplete(view);
        return null;
      })
    ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(() => queryProjectSearch(reader, { query: ['original'], limit: 100 })).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(
      readProjectArtifact(reader, before.rows.artifacts[0].artifact_id as string)
    ).not.toBeNull();
    expect(querySnapshot(file)).toEqual(incomplete);
    const result = await rebuildProjectQueryMetadata({ authority, authorize() {} });
    expect(result).toMatchObject({
      artifactCount: 3,
      executionCount: 1,
      counters: originalSearch.counters,
    });
    const after = querySnapshot(file);
    expect(authorityRows(after.rows)).toEqual(authorityRows(before.rows));
    expect(derivedRows(after.rows)).toEqual(derivedRows(before.rows));
    expect(queryProjectSearch(reader, { query: ['original'], limit: 100 }).rows).toEqual(
      originalSearch.rows
    );
    expect(after.foreignKeys).toEqual([]);
    await rebuildProjectQueryMetadata({ authority, authorize() {} });
    expect(querySnapshot(file)).toEqual(after);
  } finally {
    reader.close();
  }
});
it.each(['fault', 'cancel'] as const)(
  'rolls back every derived replacement on late %s',
  async (failure) => {
    const { authority, file } = await fixture();
    const before = querySnapshot(file);
    const controller = new AbortController();
    const original = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      if (sql.startsWith('INSERT INTO execution_query_metadata')) {
        if (failure === 'fault') throw new Database.SqliteError('fixture full', 'SQLITE_FULL');
        controller.abort();
      }
      return original.call(this, sql);
    });
    await expect(
      rebuildProjectQueryMetadata({ authority, authorize() {} }, { signal: controller.signal })
    ).rejects.toMatchObject({ code: failure === 'fault' ? 'TRANSACTION_FAILED' : 'CANCELLED' });
    spy.mockRestore();
    expect(querySnapshot(file)).toEqual(before);
  }
);
it('allows a writer during preparation and refuses the resulting stale snapshot', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const original = provenance.historyProvenanceMetadata;
  vi.spyOn(provenance, 'historyProvenanceMetadata').mockImplementationOnce(async (thread) => {
    const other = await openProjectDatabase({ authority, mode: 'writer' });
    try {
      await runProjectOperation(
        other,
        {
          operationId: uuidv7(),
          kind: 'fixture.observation',
          target: null,
          payload: null,
          expectedState: null,
          intentChange: false,
        },
        () => ({ recorded: true })
      );
    } finally {
      other.close();
    }
    return original(thread);
  });
  await expect(rebuildProjectQueryMetadata({ authority, authorize() {} })).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  const after = querySnapshot(file);
  expect(derivedRows(after.rows)).toEqual(derivedRows(before.rows));
  expect(after.rows.operations).toHaveLength(before.rows.operations.length + 1);
});
it('honors named admission cancellation and preserves the original signal despite options mutation', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const blocker = new Database(file);
  blocker.exec('BEGIN IMMEDIATE');
  const controller = new AbortController();
  const waits: string[] = [];
  const options = {
    signal: controller.signal,
    onWait: (wait: { operation: string }) => {
      waits.push(wait.operation);
      options.signal = new AbortController().signal;
      controller.abort();
    },
  };
  try {
    await expect(
      rebuildProjectQueryMetadata({ authority, authorize() {} }, options)
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(waits).toEqual(['query.rebuild']);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  expect(querySnapshot(file)).toEqual(before);
});
it('rolls back busy COMMIT before retry without recording an authoritative operation', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const original = Database.prototype.exec;
  let publishing = false;
  let commits = 0;
  const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql === 'DELETE FROM artifact_query_metadata') publishing = true;
    if (publishing && sql === 'COMMIT') {
      commits++;
      if (commits === 1) {
        expect(this.inTransaction).toBe(true);
        throw new Database.SqliteError('fixture busy', 'SQLITE_BUSY');
      }
    }
    return original.call(this, sql);
  });
  const waits: string[] = [];
  await rebuildProjectQueryMetadata(
    { authority, authorize() {} },
    { onWait: (wait) => waits.push(wait.reason) }
  );
  spy.mockRestore();
  expect(commits).toBe(2);
  expect(waits).toEqual(['transaction-retry']);
  expect(authorityRows(querySnapshot(file).rows)).toEqual(authorityRows(before.rows));
});
it('refuses missing selected chronology instead of reconstructing invented source authority', async () => {
  const { authority, file } = await fixture();
  const corrupt = new Database(file);
  const triggers = corrupt
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'")
    .all() as { name: string; sql: string }[];
  try {
    for (const trigger of triggers) corrupt.exec(`DROP TRIGGER ${trigger.name}`);
    corrupt.exec('DELETE FROM source_time_current');
    for (const trigger of triggers) corrupt.exec(trigger.sql);
  } finally {
    corrupt.close();
  }
  const before = querySnapshot(file);
  await expect(rebuildProjectQueryMetadata({ authority, authorize() {} })).rejects.toMatchObject({
    code: 'HISTORY_INTEGRITY_REQUIRED',
  });
  expect(querySnapshot(file)).toEqual(before);
});
it('refuses authorization before opening storage and does not initialize missing expected history', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const message = new Error('authored refusal');
  await expect(
    rebuildProjectQueryMetadata({
      authority,
      authorize() {
        throw message;
      },
    })
  ).rejects.toBe(message);
  expect(querySnapshot(file)).toEqual(before);
  await rm(file);
  await expect(rebuildProjectQueryMetadata({ authority, authorize() {} })).rejects.toMatchObject({
    code: 'HISTORY_MISSING',
  });
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves a typed preparation failure and its finite reason through competing close failure', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const prepare = Database.prototype.prepare;
  const close = Database.prototype.close;
  let failed = false;
  const retained = new Set<Database.Database>();
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql === 'SELECT artifact_id AS id FROM artifacts ORDER BY artifact_id') {
      failed = true;
      throw new Database.SqliteError('fixture io', 'SQLITE_IOERR');
    }
    return prepare.call(this, sql);
  });
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    if (failed && !this.readonly && this.name === file) {
      retained.add(this);
      throw new Error('fixture close failure');
    }
    return close.call(this);
  });
  try {
    await expect(rebuildProjectQueryMetadata({ authority, authorize() {} })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      reason: 'io',
    });
  } finally {
    vi.restoreAllMocks();
    for (const database of retained) if (database.open) close.call(database);
  }
  expect(querySnapshot(file)).toEqual(before);
});
it('retains cancellation classification for an aborted preparation exception', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const controller = new AbortController();
  vi.spyOn(provenance, 'historyProvenanceMetadata').mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('fixture interrupted preparation');
  });
  await expect(
    rebuildProjectQueryMetadata({ authority, authorize() {} }, { signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(querySnapshot(file)).toEqual(before);
});
it('rejects a changed write sequence at admission after preparation finishes', async () => {
  const { authority, file } = await fixture();
  const before = querySnapshot(file);
  const exec = Database.prototype.exec;
  let changed = false;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      changed = true;
      const other = new Database(file);
      try {
        exec.call(other, 'UPDATE project_counters SET write_sequence=write_sequence+1');
      } finally {
        other.close();
      }
    }
    return exec.call(this, sql);
  });
  await expect(rebuildProjectQueryMetadata({ authority, authorize() {} })).rejects.toMatchObject({
    code: 'STALE_CONTEXT',
  });
  vi.restoreAllMocks();
  const after = querySnapshot(file);
  expect(derivedRows(after.rows)).toEqual(derivedRows(before.rows));
  expect(after.rows.operations).toEqual(before.rows.operations);
});
