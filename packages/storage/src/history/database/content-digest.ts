import type Database from 'better-sqlite3';
import { createHash, type Hash } from 'node:crypto';

export interface TableDigest {
  readonly rows: number;
  readonly sha256: string;
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Each value is hashed with its storage class and its length, so a text 1 never equals an
// integer 1 and no two rows can run together into the same bytes.
function hashValue(hash: Hash, value: unknown): void {
  if (value === null) {
    hash.update('n;');
  } else if (typeof value === 'bigint') {
    hash.update(`i${value};`);
  } else if (typeof value === 'number') {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    hash.update('r').update(bytes);
  } else if (typeof value === 'string') {
    hash
      .update(`t${Buffer.byteLength(value)}:`)
      .update(value)
      .update(';');
  } else {
    const bytes = value as Buffer;
    hash.update(`b${bytes.length}:`).update(bytes).update(';');
  }
}

function storageOrder(database: Database.Database, table: string): string {
  const withoutRowid = database
    .prepare('SELECT wr FROM pragma_table_list WHERE schema = ? AND name = ?')
    .get('main', table) as { wr: number } | undefined;
  if (!withoutRowid?.wr) return 'rowid';
  return (
    database.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as {
      name: string;
      pk: number;
    }[]
  )
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => quoted(column.name))
    .join(', ');
}

// Rows are hashed in storage order, so two tables agree only when they hold the same rows in
// the same order. Naming columns compares a rebuilt table with its predecessor over the
// columns both have.
export function digestTable(
  database: Database.Database,
  table: string,
  columns?: readonly string[]
): TableDigest {
  const statement = database
    .prepare(
      `SELECT ${columns ? columns.map(quoted).join(', ') : '*'} FROM ${quoted(table)} ORDER BY ${storageOrder(database, table)}`
    )
    .raw(true)
    .safeIntegers(true);
  const hash = createHash('sha256');
  hash.update(
    `${statement
      .columns()
      .map((column) => column.name)
      .join('\u0000')}\n`
  );
  let rows = 0;
  for (const row of statement.iterate() as IterableIterator<unknown[]>) {
    for (const value of row) hashValue(hash, value);
    hash.update('\n');
    rows += 1;
  }
  return { rows, sha256: hash.digest('hex') };
}

export function listTables(database: Database.Database): string[] {
  return (
    database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith('sqlite_'));
}

export function digestTables(database: Database.Database): Record<string, TableDigest> {
  return Object.fromEntries(
    listTables(database).map((table) => [table, digestTable(database, table)])
  );
}

export function digestOfDigests(tables: Readonly<Record<string, TableDigest>>): string {
  return createHash('sha256')
    .update(
      Object.keys(tables)
        .sort()
        .map((table) => `${table} ${tables[table]!.rows} ${tables[table]!.sha256}`)
        .join('\n')
    )
    .digest('hex');
}
