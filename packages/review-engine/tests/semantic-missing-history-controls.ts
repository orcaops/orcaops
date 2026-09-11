import { createRequire } from 'node:module';
import { expect } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import {
  readDatabaseSemanticGeneration,
  type ReadDatabaseSemanticGeneration,
} from '../src/database/semantic-read.js';

export async function exerciseMissingSemanticHistory(input: ReadDatabaseSemanticGeneration) {
  expect(
    (await readDatabaseSemanticGeneration({ ...input, generationId: uuidv7() })).value
  ).toBeNull();
  const Driver = createRequire(new URL('../../storage/package.json', import.meta.url))(
    'better-sqlite3'
  );
  const database = new Driver(projectDatabasePath(input.authority));
  const names = [
    'review_semantic_generations',
    'review_semantic_attempts',
    'review_semantic_terminals',
    'review_semantic_current',
  ];
  const tables = names.map((name) => {
    const columns = (
      database.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
    ).map((row) => row.name);
    return {
      name,
      columns,
      sql: database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name)
        .sql as string,
      rows: database.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all() as Record<
        string,
        unknown
      >[],
    };
  });
  const triggers = database
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN (SELECT value FROM json_each(?))"
    )
    .all(JSON.stringify(names)) as { name: string; sql: string }[];
  const indexes = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL AND tbl_name IN (SELECT value FROM json_each(?))"
    )
    .all(JSON.stringify(names)) as { sql: string }[];
  const schema = () =>
    database
      .prepare(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name'
      )
      .all();
  const originalSchema = schema();
  const receipts = database
    .prepare(
      "SELECT count(*) AS count FROM operations WHERE operation_kind='review.semantic.submit'"
    )
    .get().count;
  expect(receipts).toBeGreaterThan(0);
  database.pragma('foreign_keys=OFF');
  const dropTriggers = () => {
    for (const trigger of triggers) database.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  };
  const restoreTriggers = () => {
    for (const trigger of triggers) database.exec(trigger.sql);
  };
  try {
    for (const damage of ['rows', 'tables'] as const) {
      dropTriggers();
      for (const table of [...tables].reverse())
        database.exec(damage === 'rows' ? `DELETE FROM ${table.name}` : `DROP TABLE ${table.name}`);
      if (damage === 'rows') restoreTriggers();
      try {
        await expect(readDatabaseSemanticGeneration(input)).rejects.toMatchObject({
          code: 'HISTORY_INTEGRITY_REQUIRED',
        });
        expect(
          database
            .prepare(
              "SELECT count(*) AS count FROM operations WHERE operation_kind='review.semantic.submit'"
            )
            .get().count
        ).toBe(receipts);
      } finally {
        dropTriggers();
        if (damage === 'tables') for (const table of tables) database.exec(table.sql);
        for (const table of tables) {
          const insert = database.prepare(
            `INSERT INTO ${table.name} (${table.columns.join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`
          );
          for (const row of table.rows) insert.run(...table.columns.map((column) => row[column]));
        }
        if (damage === 'tables') for (const index of indexes) database.exec(index.sql);
        restoreTriggers();
        expect(schema()).toEqual(originalSchema);
      }
    }
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database.close();
  }
}
