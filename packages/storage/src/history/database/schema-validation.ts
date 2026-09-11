import type Database from 'better-sqlite3';

import { loadDatabase } from './driver.js';
import { ProjectDatabaseError } from './errors.js';
import { PROJECT_DATABASE_SCHEMA, PROJECT_DATABASE_SCHEMA_VERSION } from './schema.js';

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}
const schemaQueries = `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name`;
let schemaShape: SchemaObject[] | undefined;
function expectedSchema(): SchemaObject[] {
  if (schemaShape) return schemaShape;
  const DatabaseConstructor = loadDatabase();
  const reference = new DatabaseConstructor(':memory:');
  try {
    reference.exec(PROJECT_DATABASE_SCHEMA);
    const objects = reference.prepare(schemaQueries).all() as SchemaObject[];
    schemaShape = objects;
    return objects;
  } finally {
    reference.close();
  }
}
export function validateProjectSchemaDefinition(
  database: Database.Database,
  version: number
): void {
  if (version !== PROJECT_DATABASE_SCHEMA_VERSION)
    throw new ProjectDatabaseError(
      'HISTORY_FORMAT_UNSUPPORTED',
      'This build cannot open this database format; preserve it and use a build that supports its original format'
    );
  const observed = new Map(
    (database.prepare(schemaQueries).all() as SchemaObject[]).map((entry) => [entry.name, entry])
  );
  for (const required of expectedSchema()) {
    const actual = observed.get(required.name);
    if (
      !actual ||
      actual.type !== required.type ||
      actual.tbl_name !== required.tbl_name ||
      actual.sql.replace(/\s+/g, ' ').trim() !== required.sql.replace(/\s+/g, ' ').trim()
    ) {
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The declared schema does not match the supported retained store; preserve history for explicit repair'
      );
    }
  }
}

export function validateProjectSchema(database: Database.Database, version: number): void {
  validateProjectSchemaDefinition(database, version);
  if ((database.pragma('foreign_key_check') as unknown[]).length) {
    throw new ProjectDatabaseError(
      'HISTORY_INTEGRITY_REQUIRED',
      'The retained store contains invalid references; preserve history for explicit repair'
    );
  }
}
