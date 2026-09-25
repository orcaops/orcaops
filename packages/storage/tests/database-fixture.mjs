import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

export const decode = (value) =>
  Array.isArray(value)
    ? value.map(decode)
    : value && typeof value === 'object'
      ? Object.keys(value).length === 1 && typeof value.blobHex === 'string'
        ? Buffer.from(value.blobHex, 'hex')
        : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]))
      : value;
export const encode = (value) =>
  Buffer.isBuffer(value)
    ? { blobHex: value.toString('hex') }
    : Array.isArray(value)
      ? value.map(encode)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
        : value;
export function snapshot(Database, file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const definitions = db
      .prepare(
        'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name'
      )
      .all();
    // A WITHOUT ROWID table has no rowid to order by; its primary key is its storage order.
    const withoutRowid = new Set(
      db
        .prepare('SELECT name FROM pragma_table_list WHERE wr = 1')
        .all()
        .map((table) => table.name)
    );
    const storageOrder = (name) =>
      withoutRowid.has(name)
        ? db
            .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
            .all()
            .filter((column) => column.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((column) => JSON.stringify(column.name))
            .join(',')
        : 'rowid';
    return {
      version: db.pragma('user_version', { simple: true }),
      definitions,
      foreignKeys: db.pragma('foreign_key_check'),
      rows: Object.fromEntries(
        definitions
          .filter((x) => x.type === 'table')
          .map(({ name }) => [
            name,
            db
              .prepare(`SELECT * FROM ${JSON.stringify(name)} ORDER BY ${storageOrder(name)}`)
              .all()
              .map(encode),
          ])
      ),
    };
  } finally {
    db.close();
  }
}
// `validateSchema` replaces the default check against the schema this checkout expects. A
// fixture of a released schema passes its own, so it still restores after the checkout's
// schema version has moved on.
export async function restoreFixture(candidate, fixture, expectedVersion, options = {}) {
  const saved = JSON.parse(await readFile(fixture, 'utf8'));
  const current = JSON.parse(
    await readFile(
      new URL('../src/history/database/fixtures/current.json', import.meta.url),
      'utf8'
    )
  );
  expectedVersion ??= current.schemaVersion;
  assert.equal(saved.schemaVersion, expectedVersion);
  saved.definitions ??= current.definitions;
  saved.rows = {
    ...Object.fromEntries(
      saved.definitions.filter((x) => x.type === 'table').map((x) => [x.name, []])
    ),
    ...saved.rows,
  };
  const Database = createRequire(path.join(candidate, 'packages/storage/package.json'))(
    'better-sqlite3'
  );
  const { normalizeHistoryRoot } = await import(
    path.join(candidate, 'packages/storage/dist/history/paths.js')
  );
  const { projectDatabasePath } = await import(
    path.join(candidate, 'packages/storage/dist/history/database/connection.js')
  );
  const { validateProjectSchema } = await import(
    path.join(candidate, 'packages/storage/dist/history/database/schema-validation.js')
  );
  const temporary = await mkdtemp(path.join(tmpdir(), 'push-original-'));
  try {
    const root = await normalizeHistoryRoot({ root: temporary });
    const identity = saved.rows.store_identity[0];
    identity.resolved_root = root.resolvedRoot;
    identity.root_key = root.rootKey;
    const authority = {
      ...root,
      projectId: identity.project_id,
      storeInstanceId: identity.store_instance_id,
      repositoryInstanceId: identity.repository_instance_id,
    };
    const file = projectDatabasePath(authority);
    await mkdir(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
      db.pragma('journal_mode=WAL');
      db.pragma('foreign_keys=OFF');
      db.exec('BEGIN IMMEDIATE');
      for (const type of ['table', 'index', 'view'])
        for (const object of saved.definitions) if (object.type === type) db.exec(object.sql);
      for (const [table, rows] of Object.entries(saved.rows)) {
        const columns = new Set(
          db
            .prepare(`PRAGMA table_xinfo(${JSON.stringify(table)})`)
            .all()
            .filter((x) => x.hidden === 0)
            .map((x) => x.name)
        );
        for (const row of rows) {
          const keys = Object.keys(row).filter((k) => columns.has(k));
          db.prepare(
            `INSERT INTO ${JSON.stringify(table)} (${keys.map((k) => JSON.stringify(k)).join(',')}) VALUES (${keys.map(() => '?').join(',')})`
          ).run(...keys.map((k) => decode(row[k])));
        }
      }
      for (const object of saved.definitions) if (object.type === 'trigger') db.exec(object.sql);
      db.pragma(`user_version=${expectedVersion}`);
      db.exec('COMMIT');
      db.pragma('foreign_keys=ON');
      if (options.validateSchema) options.validateSchema(db, saved);
      else validateProjectSchema(db, expectedVersion);
    } finally {
      db.close();
    }
    for (const member of saved.evidence ?? []) {
      const data = Buffer.from(member.bytes.blobHex, 'hex');
      assert.equal(createHash('sha256').update(data).digest('hex'), member.sha256);
      const dest = path.join(path.dirname(file), 'evidence', member.relativePath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
    assert.deepEqual(snapshot(Database, file).rows, saved.rows);
    return {
      Database,
      saved,
      authority,
      file,
      temporary,
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    throw cause;
  }
}
