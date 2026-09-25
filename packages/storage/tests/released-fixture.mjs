import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

import { restoreFixture } from './database-fixture.mjs';

export const RELEASED_FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../src/history/database/fixtures/released/', import.meta.url)
);
export const RELEASED_SCHEMA_FILE = path.join(RELEASED_FIXTURE_DIRECTORY, 'schema.json');
export const RETAINED_REFS_BUNDLE = 'retained-refs.bundle.base64';
export const ORIGINAL_FILE_SUFFIX = '.br.base64';

// `name` is a release version, or `<version>-converted-from-<legacy version>`.
export function releasedFixtureDirectory(name) {
  return path.join(RELEASED_FIXTURE_DIRECTORY, `cli-${name}`);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Hashes cover parsed values with sorted keys, never file bytes, so reformatting a fixture
// file leaves them unchanged while any edited value does not.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function tableDigest(rows) {
  return sha256(rows.map(canonical).join('\n'));
}

export function databaseDigest(rows) {
  return sha256(
    Object.keys(rows)
      .sort()
      .map((table) => `${table} ${rows[table].length} ${tableDigest(rows[table])}`)
      .join('\n')
  );
}

export function schemaDigests(definitions) {
  const objects = definitions
    .filter((object) => !object.name.startsWith('sqlite_'))
    .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql }))
    .sort((a, b) => (a.type === b.type ? compare(a.name, b.name) : compare(a.type, b.type)));
  const kinds = {};
  for (const { type } of objects) kinds[type] = (kinds[type] ?? 0) + 1;
  return {
    objects: objects.length,
    object_kinds: kinds,
    sql_sha256: sha256(JSON.stringify(objects)),
    // The same digest the generation procedure prints, so a manifest can be checked
    // against the summary of the run it was frozen from.
    whitespace_normalized_sql_sha256: sha256(
      JSON.stringify(
        objects.map((object) => ({ ...object, sql: object.sql.replace(/\s+/g, ' ').trim() }))
      )
    ),
  };
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function countBy(rows, column) {
  const counts = {};
  for (const row of rows) counts[row[column]] = (counts[row[column]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compare(a, b)));
}

export function blobBytes(value) {
  return Buffer.from(value.blobHex, 'hex');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readReleasedFixture(name) {
  const directory = releasedFixtureDirectory(name);
  const [manifest, database, schema, bundleText] = await Promise.all([
    readJson(path.join(directory, 'manifest.json')),
    readJson(path.join(directory, 'database.json')),
    readJson(RELEASED_SCHEMA_FILE),
    readFile(path.join(directory, RETAINED_REFS_BUNDLE), 'utf8'),
  ]);
  return { manifest, database, schema, bundle: Buffer.from(bundleText, 'base64') };
}

// The restored file has to hold the fixture's own definitions, object for object, under the
// fixture's own version. The schema this checkout expects plays no part, so a released
// fixture still restores after that schema has moved on.
export function validateOwnDefinitions(database, saved) {
  assert.equal(database.pragma('user_version', { simple: true }), saved.schemaVersion);
  assert.deepEqual(
    database
      .prepare(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name'
      )
      .all(),
    [...saved.definitions].sort((a, b) =>
      a.type === b.type ? compare(a.name, b.name) : compare(a.type, b.type)
    )
  );
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
}

// `restoreFixture` takes one file and falls back to this checkout's schema definitions when a
// fixture has none. A released fixture restores under the definitions its producer wrote,
// which are stored once for every release.
export async function restoreFixtureImage(candidate, image) {
  const directory = await mkdtemp(path.join(tmpdir(), 'released-fixture-'));
  try {
    const file = path.join(directory, 'image.json');
    await writeFile(file, JSON.stringify(image));
    const restored = await restoreFixture(candidate, file, image.schemaVersion, {
      validateSchema: validateOwnDefinitions,
    });
    return {
      ...restored,
      cleanup: () =>
        Promise.all([restored.cleanup(), rm(directory, { recursive: true, force: true })]),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

export async function restoreReleasedFixture(candidate, name) {
  const { database, schema } = await readReleasedFixture(name);
  return restoreFixtureImage(candidate, {
    schemaVersion: database.schemaVersion,
    definitions: schema.definitions,
    rows: database.rows,
    evidence: database.evidence,
  });
}

// The main file and write-ahead log exactly as the release left them, in a fresh directory.
// Opening them changes them, so every caller gets its own copy.
export async function materializeOriginalDatabase(name) {
  const { manifest } = await readReleasedFixture(name);
  const directory = await mkdtemp(path.join(tmpdir(), 'released-original-'));
  for (const file of manifest.original_database.files) {
    const stored = await readFile(
      path.join(releasedFixtureDirectory(name), file.stored_as),
      'utf8'
    );
    const bytes = brotliDecompressSync(Buffer.from(stored, 'base64'));
    assert.equal(sha256(bytes), file.sha256);
    assert.equal(bytes.length, file.bytes);
    await writeFile(path.join(directory, file.name), bytes);
  }
  return {
    directory,
    main: path.join(directory, manifest.original_database.files[0].name),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
