import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { PROJECT_DATABASE_SCHEMA } from './schema.js';

type Cell = string | number | null | { blobHex: string };
async function fixture() {
  const saved = JSON.parse(
    await readFile(new URL('./fixtures/retention-inputs.json', import.meta.url), 'utf8')
  ) as {
    schemaVersion: number;
    rows: Record<string, Record<string, Cell>[]>;
  };
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(PROJECT_DATABASE_SCHEMA);
  database.exec('BEGIN IMMEDIATE');
  database.pragma('defer_foreign_keys = ON');
  for (const [table, rows] of Object.entries(saved.rows))
    for (const row of rows) {
      const keys = Object.keys(row);
      database
        .prepare(
          `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
        .run(
          ...Object.values(row).map((value) =>
            value && typeof value === 'object' ? Buffer.from(value.blobHex, 'hex') : value
          )
        );
    }
  database.exec('COMMIT');
  expect(database.pragma('foreign_key_check')).toEqual([]);
  return database;
}
function snapshot(database: Database.Database) {
  const tables = database
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])
  );
}
interface RunRevision {
  run_id: string;
  review_id: string;
  revision_id: string;
  operation_id: string;
}
function insert(database: Database.Database, run: RunRevision, bytes: Buffer) {
  database
    .prepare('INSERT INTO review_run_finalizations VALUES(?,?,?,?,?,?)')
    .run(run.run_id, run.review_id, run.revision_id, run.operation_id, bytes, 'verification-hash');
}
it('retains exact terminal bytes without changing any existing run selection or record', async () => {
  const database = await fixture();
  try {
    const before = snapshot(database);
    expect(snapshot(database)).toEqual({ ...before, review_run_finalizations: [] });
    const runs = database
      .prepare('SELECT * FROM review_run_revisions ORDER BY run_id')
      .all() as RunRevision[];
    expect(runs).toHaveLength(2);
    const bytes = Buffer.from('{"status":"FAILED","generation":null}\n');
    insert(database, runs[0], bytes);
    expect(database.prepare('SELECT record_bytes FROM review_run_finalizations').get()).toEqual({
      record_bytes: bytes,
    });
    expect(() => insert(database, runs[0], bytes)).toThrow(/immutable/);
    expect(() =>
      database
        .prepare('INSERT OR REPLACE INTO review_run_finalizations VALUES(?,?,?,?,?,?)')
        .run(
          runs[0].run_id,
          runs[0].review_id,
          runs[0].revision_id,
          runs[0].operation_id,
          Buffer.from('replacement'),
          'replacement'
        )
    ).toThrow(/immutable/);
    expect(database.prepare('SELECT record_bytes FROM review_run_finalizations').get()).toEqual({
      record_bytes: bytes,
    });

    expect(() =>
      database.prepare('UPDATE review_run_finalizations SET record_hash=?').run('replacement')
    ).toThrow(/immutable/);
    expect(() => database.prepare('DELETE FROM review_run_finalizations').run()).toThrow(
      /retained/
    );
    insert(database, runs[1], Buffer.from('other exact terminal bytes'));
    const after = snapshot(database);
    after.review_run_finalizations = [];
    expect(after).toEqual(before);
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database.close();
  }
});
it('refuses another run revision, another review and an uncommitted operation reference', async () => {
  const database = await fixture();
  try {
    const runs = database
      .prepare('SELECT * FROM review_run_revisions ORDER BY run_id')
      .all() as RunRevision[];
    expect(() =>
      insert(database, { ...runs[0], revision_id: runs[1].revision_id }, Buffer.from('record'))
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert(database, { ...runs[0], review_id: 'unrelated-review' }, Buffer.from('record'))
    ).toThrow(/FOREIGN KEY/);
    const before = snapshot(database);
    database.exec('BEGIN IMMEDIATE');
    insert(database, { ...runs[0], operation_id: 'uncommitted-operation' }, Buffer.from('record'));
    expect(() => database.exec('COMMIT')).toThrow(/FOREIGN KEY/);
    database.exec('ROLLBACK');
    expect(snapshot(database)).toEqual(before);
  } finally {
    database.close();
  }
});
