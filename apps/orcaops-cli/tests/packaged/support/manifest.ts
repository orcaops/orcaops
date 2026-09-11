import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export type FileEntry = { kind: 'file' | 'directory' | 'other'; sha256: string; size: number };
export type FileManifest = Record<string, FileEntry>;

/**
 * ORDERING INVARIANT: take a file manifest BEFORE opening any reader on the same
 * store. A readonly SQLite open on an existing WAL database is permitted to create
 * an empty WAL and to write SHM read marks (see passive-read-decision.md), so a
 * record manifest taken first would show up as a file change caused by the oracle
 * rather than by the scenario.
 */
export async function fileManifest(root: string): Promise<FileManifest> {
  const result: FileManifest = {};
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) {
      result[relative] = { kind: 'directory', sha256: '', size: 0 };
      continue;
    }
    if (!entry.isFile()) {
      result[relative] = { kind: 'other', sha256: '', size: 0 };
      continue;
    }
    const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    result[relative] = { kind: 'file', sha256: sha256(bytes), size: info.size };
  }
  return result;
}

export type ManifestDifference = {
  created: string[];
  removed: string[];
  changed: string[];
};

const empty = (): ManifestDifference => ({ created: [], removed: [], changed: [] });

export type ClassifiedDifference = {
  /** The authoritative main database files. */
  database: ManifestDifference;
  /** SQLite's write-ahead log — authoritative history bytes, compared separately. */
  wal: ManifestDifference;
  /** SQLite's shared-memory index — engine runtime state, never application state. */
  shm: ManifestDifference;
  /** Everything else under the root: markers, catalogs, caches, refs, temp files. */
  other: ManifestDifference;
};

function classify(name: string): keyof ClassifiedDifference {
  if (name.endsWith('-wal')) return 'wal';
  if (name.endsWith('-shm')) return 'shm';
  if (name.endsWith('.sqlite3')) return 'database';
  return 'other';
}

export function compareManifests(before: FileManifest, after: FileManifest): ClassifiedDifference {
  const difference: ClassifiedDifference = {
    database: empty(),
    wal: empty(),
    shm: empty(),
    other: empty(),
  };
  for (const name of Object.keys(after))
    if (!(name in before)) difference[classify(name)].created.push(name);
  for (const name of Object.keys(before)) {
    if (!(name in after)) {
      difference[classify(name)].removed.push(name);
      continue;
    }
    if (before[name]!.sha256 !== after[name]!.sha256 || before[name]!.size !== after[name]!.size)
      difference[classify(name)].changed.push(name);
  }
  for (const bucket of Object.values(difference))
    for (const list of Object.values(bucket)) list.sort();
  return difference;
}

/** True when nothing but SQLite's own runtime coordination moved. */
export function onlyRuntimeCoordination(difference: ClassifiedDifference): boolean {
  return (['database', 'other'] as const).every(
    (bucket) =>
      difference[bucket].created.length === 0 &&
      difference[bucket].removed.length === 0 &&
      difference[bucket].changed.length === 0
  );
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export type RecordManifest = {
  tables: Record<string, string[]>;
  integrityCheck: string;
  foreignKeyCheck: unknown[];
};

/**
 * Ordered authoritative rows read with the raw driver on a readonly connection —
 * deliberately not through the implementation's own export, so a scenario never
 * compares the code under test against itself. Values carry their SQLite storage
 * class so a text `1` never compares equal to an integer 1.
 */
export function recordManifest(databaseFile: string): RecordManifest {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const tableNames = database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map(({ name }) => name);
    const tables: Record<string, string[]> = {};
    for (const name of tableNames) {
      const columns = database
        .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(name)
        .map((column) => column.name);
      const projection = columns
        .map((column) => `typeof(${quote(column)}) || ':' || quote(${quote(column)})`)
        .join(" || '|' || ");
      tables[name] = database
        .prepare<[], { row: string }>(
          `SELECT ${projection || "''"} AS row FROM ${quote(name)} ORDER BY row`
        )
        .all()
        .map(({ row }) => row);
    }
    return {
      tables,
      integrityCheck: database
        .prepare<[], { integrity_check: string }>('PRAGMA integrity_check')
        .all()
        .map((row) => row.integrity_check)
        .join(','),
      foreignKeyCheck: database.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally {
    database.close();
  }
}

/** Row counts per table, for a compact positive/negative control assertion. */
export function rowCounts(manifest: RecordManifest): Record<string, number> {
  return Object.fromEntries(
    Object.entries(manifest.tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([name, rows]) => [name, rows.length])
  );
}

/**
 * Rows of `operations` whose OWN `operation_id` column is this id.
 *
 * The manifest serializes a row as its columns in cid order and `operation_id` is
 * the first column, so an anchored prefix match is the column. A substring match
 * over the whole row also counts rows that merely REFERENCE the id inside a
 * payload or expected-state JSON, which silently turns "committed exactly once"
 * into "mentioned exactly once".
 */
export function operationRows(rows: string[], operationId: string): string[] {
  return rows.filter((row) => row.startsWith(`text:'${operationId}'|`));
}
