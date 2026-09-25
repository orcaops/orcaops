import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { readReleasedFixture, restoreFixtureImage } from './released-fixture.mjs';

export const SYNTHETIC_FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../src/history/database/fixtures/synthetic-schema-29/', import.meta.url)
);
export const SYNTHETIC_BASE_RELEASE = '0.2.1';

// The synthetic file holds, in full, only the tables its writers changed. Every other table
// comes from the released fixture underneath, so those rows cannot drift from what the
// release wrote.
export async function readSyntheticFixture() {
  const [manifest, database, base] = await Promise.all([
    readFile(path.join(SYNTHETIC_FIXTURE_DIRECTORY, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(SYNTHETIC_FIXTURE_DIRECTORY, 'database.json'), 'utf8').then(JSON.parse),
    readReleasedFixture(SYNTHETIC_BASE_RELEASE),
  ]);
  return {
    manifest,
    database,
    base,
    schema: base.schema,
    rows: { ...base.database.rows, ...database.rows },
  };
}

export async function restoreSyntheticFixture(candidate) {
  const { database, rows, schema, base } = await readSyntheticFixture();
  return restoreFixtureImage(candidate, {
    schemaVersion: database.schemaVersion,
    definitions: schema.definitions,
    rows,
    evidence: base.database.evidence,
  });
}
