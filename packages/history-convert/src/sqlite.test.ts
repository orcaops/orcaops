import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BASELINE_SCHEMA } from './legacy-operations/storage/store/migrations/025-baseline.js';
import { assertDecodedLegacySqlite, decodeLegacySqlite } from './sqlite.js';

const opened: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function memory() {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(BASELINE_SCHEMA);
  return db;
}
function baseline(version: 23 | 24 | 25) {
  let schema = BASELINE_SCHEMA.replace(
    "VALUES ('version', '25')",
    `VALUES ('version', '${version}')`
  );
  if (version < 25)
    schema = schema.replace(
      "  origin_kind   TEXT CHECK (origin_kind IS NULL OR origin_kind = 'git-import'),\n",
      ''
    );
  if (version < 24)
    schema = schema.replace(
      "  provider            TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),\n",
      ''
    );
  return schema;
}
function walFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'history-convert-sqlite-'));
  roots.push(root);
  const file = path.join(root, 'history.sqlite');
  const db = new Database(file);
  opened.push(db);
  db.pragma('journal_mode=WAL');
  db.pragma('wal_autocheckpoint=0');
  db.exec(BASELINE_SCHEMA);
  db.prepare(
    'INSERT INTO artifacts(id,branch,task,agent,base_sha,started_at,status) VALUES(?,?,?,?,?,?,?)'
  ).run(
    'artifact-1',
    'feature',
    'Retained task',
    'codex',
    'head',
    '2026-07-23T10:00:00.000Z',
    'active'
  );
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare(
    'UPDATE artifacts SET cloud_external_id=?,cloud_org_id=?,cloud_last_push_error_kind=?,cloud_consecutive_failures=? WHERE id=?'
  ).run('original-remote', 'original-org', 'NETWORK_ERROR', 3, 'artifact-1');
  db.prepare('INSERT INTO idempotency_blocks VALUES(?,?,?,?,?,?,?,?)').run(
    'artifact-1',
    'original-key',
    'checkpoint_opened',
    'soft_blocked',
    'original-payload-hash',
    'original-evaluator',
    '{"ok":false}',
    '2026-07-23T10:01:00.000Z'
  );
  return {
    root,
    file,
    db,
    snapshot: () => ({
      main: readFileSync(file),
      wal: readFileSync(file + '-wal'),
      shm: readFileSync(file + '-shm'),
    }),
  };
}
const sourceError = expect.objectContaining({ code: 'SOURCE_INTEGRITY' });

describe('frozen SQLite source verification', () => {
  it('checks the complete schema independently of the claimed baseline version', () => {
    const db = memory();
    const value = decodeLegacySqlite({ main: db.serialize() });
    expect(value.baselineVersion).toBe(25);
    expect(value.tableCounts).toHaveProperty('idempotency_blocks', 0);
    db.exec('CREATE TABLE unknown_history (precious TEXT)');
    expect(() => decodeLegacySqlite({ main: db.serialize() })).toThrow(sourceError);
  });

  it.each([23, 24, 25] as const)('accepts the complete frozen version %s schema', (version) => {
    const db = new Database(':memory:');
    opened.push(db);
    db.exec(baseline(version));
    expect(decodeLegacySqlite({ main: db.serialize() }).baselineVersion).toBe(version);
  });

  it.each([20, 22] as const)('refuses an unrecognized version %s schema shape', (version) => {
    const db = memory();
    db.prepare('UPDATE schema_meta SET value=? WHERE key=?').run(String(version), 'version');
    expect(() => decodeLegacySqlite({ main: db.serialize() })).toThrow(sourceError);
  });

  it('refuses unknown versions and changed baseline constraints', () => {
    const db = memory();
    db.prepare("UPDATE schema_meta SET value='22' WHERE key='version'").run();
    expect(() => decodeLegacySqlite({ main: db.serialize() })).toThrow(sourceError);
    db.prepare("UPDATE schema_meta SET value='25' WHERE key='version'").run();
    db.exec('ALTER TABLE artifacts ADD COLUMN future_ack TEXT');
    expect(() => decodeLegacySqlite({ main: db.serialize() })).toThrow(sourceError);
  });

  it('retains unique retry, acknowledgment and idempotency bytes committed only in the WAL', () => {
    const f = walFixture();
    const source = f.snapshot();
    expect(
      decodeLegacySqlite({ main: source.main }).rows.artifacts[0]!.cloud_external_id
    ).toBeNull();
    const before = readdirSync(f.root)
      .sort()
      .map((name) => ({
        name,
        bytes: readFileSync(path.join(f.root, name)),
        mtime: statSync(path.join(f.root, name), { bigint: true }).mtimeNs,
      }));
    const value = decodeLegacySqlite(source);
    expect(value.rows.artifacts[0]).toMatchObject({
      cloud_external_id: 'original-remote',
      cloud_org_id: 'original-org',
      cloud_last_push_error_kind: 'NETWORK_ERROR',
      cloud_consecutive_failures: 3,
    });
    expect(value.rows.idempotency_blocks).toEqual([
      {
        artifact_id: 'artifact-1',
        idempotency_key: 'original-key',
        event_type: 'checkpoint_opened',
        outcome: 'soft_blocked',
        payload_hash: 'original-payload-hash',
        evaluator_fingerprint: 'original-evaluator',
        envelope: '{"ok":false}',
        recorded_at: '2026-07-23T10:01:00.000Z',
      },
    ]);
    expect(value.wal.committedFrames).toBeGreaterThan(0);
    for (const retained of value.sources)
      expect(Buffer.from(retained.bytesBase64, 'base64')).toEqual(source[retained.kind]);
    expect(
      readdirSync(f.root)
        .sort()
        .map((name) => ({
          name,
          bytes: readFileSync(path.join(f.root, name)),
          mtime: statSync(path.join(f.root, name), { bigint: true }).mtimeNs,
        }))
    ).toEqual(before);
    expect(() => assertDecodedLegacySqlite(value)).not.toThrow();
    expect(() => assertDecodedLegacySqlite({ ...value })).toThrow(sourceError);
  });

  it('resolves native SQLite WAL reuse without applying stale frames from the prior salt', () => {
    const f = walFixture();
    f.db
      .prepare('UPDATE artifacts SET task=? WHERE id=?')
      .run('retained prose '.repeat(2_000), 'artifact-1');
    f.db.pragma('wal_checkpoint(RESTART)');
    f.db.prepare("UPDATE idempotency_blocks SET recorded_at='2026-07-23T10:02:00.000Z'").run();
    const value = decodeLegacySqlite(f.snapshot());
    expect(value.wal.staleSuffixBytes).toBeGreaterThan(0);
    expect(value.rows.artifacts[0]!.task).toBe(
      f.db.prepare('SELECT task FROM artifacts').pluck().get()
    );
    expect(value.rows.idempotency_blocks[0]!.recorded_at).toBe('2026-07-23T10:02:00.000Z');
    const { main, wal } = f.snapshot();
    expect(() => decodeLegacySqlite({ main, wal })).toThrow(sourceError);
  });

  it('never hides an acknowledged current frame as stale allocation or a missing WAL', () => {
    const f = walFixture();
    const source = f.snapshot();
    const wal = Buffer.from(source.wal);
    const frameSize = 24 + wal.readUInt32BE(8);
    const lastSalt = wal.length - frameSize + 8;
    wal[lastSalt] = wal[lastSalt]! ^ 1;
    expect(() => decodeLegacySqlite({ ...source, wal })).toThrow(sourceError);
    expect(() => decodeLegacySqlite({ main: source.main, shm: source.shm })).toThrow(sourceError);
    const shm = Buffer.from(source.shm);
    shm[48] = shm[48]! ^ 1;
    expect(() => decodeLegacySqlite({ ...source, shm })).toThrow(sourceError);
  });

  it('refuses torn current frames, header/frame corruption and rollback recovery evidence', () => {
    const f = walFixture();
    const source = f.snapshot();
    for (const offset of [24, 32 + 24]) {
      const wal = Buffer.from(source.wal);
      wal[offset] = wal[offset]! ^ 1;
      expect(() => decodeLegacySqlite({ ...source, wal })).toThrow(sourceError);
    }
    expect(() => decodeLegacySqlite({ ...source, wal: source.wal.subarray(0, -1) })).toThrow(
      sourceError
    );
    expect(() =>
      decodeLegacySqlite({ ...source, rollbackJournal: Buffer.from('pending') })
    ).toThrow(sourceError);
  });

  it('refuses unsafe counters and broken artifact ownership while preserving the source', () => {
    const f = walFixture();
    f.db.exec('UPDATE artifacts SET cloud_consecutive_failures=9007199254740993');
    expect(() => decodeLegacySqlite(f.snapshot())).toThrow(sourceError);
    f.db.exec('UPDATE artifacts SET cloud_consecutive_failures=3');
    f.db.pragma('foreign_keys=OFF');
    f.db.exec("UPDATE idempotency_blocks SET artifact_id='missing-artifact'");
    expect(() => decodeLegacySqlite(f.snapshot())).toThrow(sourceError);
  });
});
