import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

// The only format a published package wrote before the current one, and so the only one the
// explicit upgrade starts from.
export const RELEASED_SCHEMA_VERSION = 29;

// Every object the published 0.2.0 and 0.2.1 packages created, as schemaSqlDigest sees them. The
// definition is too large to carry and a version number alone says nothing about a file's
// tables, so the upgrade admits a schema-29 file only when its objects hash to this.
export const RELEASED_SCHEMA_SQL_SHA256 =
  '6ddee53aff2eae90328c12fb91d84b8214b8e9ee3fcac61f2b4b91c54d1f1c77';

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// SQLite's own bookkeeping tables, such as the statistics ANALYZE leaves, are no part of a
// store's definition.
export function readSchemaObjects(database: Database.Database): SchemaObject[] {
  return (
    database
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL')
      .all() as SchemaObject[]
  )
    .filter((object) => !object.name.startsWith('sqlite_'))
    .sort((a, b) => compare(a.type, b.type) || compare(a.name, b.name));
}

// Exact about the object set and about every byte of SQL: nothing is normalized, because a
// released store holds the text the released build executed.
export function schemaSqlDigest(objects: readonly SchemaObject[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        objects.map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql }))
      )
    )
    .digest('hex');
}
