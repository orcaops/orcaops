import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

import {
  queryFixture,
  queryFixtureRoots,
  querySnapshot,
} from '../../../tests/query-metadata-fixture.js';
import * as provenance from '../metadata-provenance.js';
import { openProjectDatabase } from './connection.js';
import { prepareProjectQueryMetadata } from './query-metadata-snapshot.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    queryFixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
it('prepares original chronology and separate execution branches without changing retained rows', async () => {
  const { authority, file } = await queryFixture();
  const handle = await openProjectDatabase({ authority: authority, mode: 'reader' });
  try {
    const before = querySnapshot(file);
    const prepared = await prepareProjectQueryMetadata(handle);
    expect(prepared.artifacts).toHaveLength(3);
    expect(prepared.executions).toHaveLength(1);
    expect(prepared.executions[0]).toMatchObject({
      bindingBranch: 'retained-secondary',
      bindingUpdatedAt: '2026-06-02T00:04:00.000Z',
    });
    expect(prepared.executions[0].branches).toHaveLength(2);
    expect(
      prepared.artifacts.some((artifact) => JSON.stringify(artifact.search).includes('2009-02-13'))
    ).toBe(true);
    expect(querySnapshot(file)).toEqual(before);
  } finally {
    handle.close();
  }
});
it('rejects a changed write sequence after asynchronous preparation without publishing', async () => {
  const { authority, file } = await queryFixture();
  const handle = await openProjectDatabase({ authority: authority, mode: 'reader' });
  const original = provenance.historyProvenanceMetadata;
  const other = new Database(file);
  vi.spyOn(provenance, 'historyProvenanceMetadata').mockImplementationOnce(async (thread) => {
    other.exec('UPDATE project_counters SET write_sequence=write_sequence+1');
    return original(thread);
  });
  try {
    await expect(prepareProjectQueryMetadata(handle)).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
    });
    expect(querySnapshot(file).rows.artifacts).toHaveLength(3);
  } finally {
    other.close();
    handle.close();
  }
});
it('honors cancellation while provenance is pending without retaining a read transaction', async () => {
  const { authority, file } = await queryFixture();
  const handle = await openProjectDatabase({ authority: authority, mode: 'reader' });
  const signal = new AbortController();
  const original = provenance.historyProvenanceMetadata;
  vi.spyOn(provenance, 'historyProvenanceMetadata').mockImplementationOnce(async (thread) => {
    const other = new Database(file);
    try {
      other.exec('BEGIN IMMEDIATE');
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
    signal.abort();
    return original(thread);
  });
  try {
    const before = querySnapshot(file);
    await expect(prepareProjectQueryMetadata(handle, signal.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(querySnapshot(file)).toEqual(before);
  } finally {
    handle.close();
  }
});
it('refuses missing initialization even when only association history remains', async () => {
  const { authority, file } = await queryFixture();
  const handle = await openProjectDatabase({ authority: authority, mode: 'reader' });
  const other = new Database(file);
  const triggers = other
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'")
    .all() as { name: string; sql: string }[];
  try {
    other.pragma('foreign_keys=OFF');
    for (const trigger of triggers) other.exec(`DROP TRIGGER ${trigger.name}`);
    other.exec(
      'DELETE FROM execution_initializations; DELETE FROM execution_current; DELETE FROM execution_transitions'
    );
    for (const trigger of triggers) other.exec(trigger.sql);
  } finally {
    other.close();
  }
  try {
    const before = querySnapshot(file);
    await expect(prepareProjectQueryMetadata(handle)).rejects.toMatchObject({
      code: 'HISTORY_INTEGRITY_REQUIRED',
    });
    expect(querySnapshot(file)).toEqual(before);
  } finally {
    handle.close();
  }
});
it.each(['artifact_events', 'artifact_revisions'] as const)(
  'refuses a missing artifact header when only %s remain',
  async (retainedTable) => {
    const { authority, file } = await queryFixture();
    const handle = await openProjectDatabase({ authority: authority, mode: 'reader' });
    const other = new Database(file);
    const row = other
      .prepare(
        `SELECT artifact_id FROM artifacts a WHERE NOT EXISTS
      (SELECT 1 FROM execution_initializations i WHERE i.artifact_id=a.artifact_id) LIMIT 1`
      )
      .get() as { artifact_id: string };
    const triggers = other
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'")
      .all() as { name: string; sql: string }[];
    try {
      other.pragma('foreign_keys=OFF');
      for (const trigger of triggers) other.exec(`DROP TRIGGER ${trigger.name}`);
      const removed =
        retainedTable === 'artifact_events' ? 'artifact_revisions' : 'artifact_events';
      other.prepare(`DELETE FROM ${removed} WHERE artifact_id=?`).run(row.artifact_id);
      other.prepare('DELETE FROM artifacts WHERE artifact_id=?').run(row.artifact_id);
      for (const trigger of triggers) other.exec(trigger.sql);
      const retained = other
        .prepare(`SELECT count(*) AS n FROM ${retainedTable} WHERE artifact_id=?`)
        .get(row.artifact_id) as { n: number };
      expect(retained.n).toBeGreaterThan(0);
    } finally {
      other.close();
    }
    const prepare = vi.spyOn(provenance, 'historyProvenanceMetadata');
    try {
      const before = querySnapshot(file);
      await expect(prepareProjectQueryMetadata(handle)).rejects.toMatchObject({
        code: 'HISTORY_INTEGRITY_REQUIRED',
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(querySnapshot(file)).toEqual(before);
    } finally {
      handle.close();
    }
  }
);
