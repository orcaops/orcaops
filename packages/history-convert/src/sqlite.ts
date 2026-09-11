import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { HistoryConversionError } from './errors.js';
import {
  BASELINE_SCHEMA,
  BASELINE_VERSION,
} from './legacy-operations/storage/store/migrations/025-baseline.js';

function invalid(message: string): never {
  throw new HistoryConversionError('SOURCE_INTEGRITY', message, 'sqlite');
}
function checksum(
  bytes: Buffer,
  bigEndian: boolean,
  prior: readonly number[] = [0, 0]
): [number, number] {
  let first = prior[0]!;
  let second = prior[1]!;
  for (let offset = 0; offset < bytes.length; offset += 8) {
    first =
      (first + (bigEndian ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset)) + second) >>>
      0;
    second =
      (second +
        (bigEndian ? bytes.readUInt32BE(offset + 4) : bytes.readUInt32LE(offset + 4)) +
        first) >>>
      0;
  }
  return [first, second];
}
function matchesChecksum(bytes: Buffer, offset: number, value: readonly number[]): boolean {
  return bytes.readUInt32BE(offset) === value[0] && bytes.readUInt32BE(offset + 4) === value[1];
}
function pageSize(bytes: Buffer): number {
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0')
    invalid('Retained SQLite main file has an invalid header');
  const stored = bytes.readUInt16BE(16);
  const size = stored === 1 ? 65_536 : stored;
  if (size < 512 || size > 65_536 || (size & (size - 1)) !== 0 || bytes.length % size !== 0)
    invalid('Retained SQLite main file has an invalid page layout');
  return size;
}

interface WalImage {
  bytes: Buffer;
  frames: number;
  committedFrames: number;
  staleSuffixBytes: number;
}
function reconstruct(main: Buffer, wal: Buffer): WalImage {
  const size = pageSize(main);
  if (!wal.length)
    return { bytes: Buffer.from(main), frames: 0, committedFrames: 0, staleSuffixBytes: 0 };
  if (wal.length < 32) invalid('Retained SQLite WAL has a truncated header');
  const magic = wal.readUInt32BE(0);
  if (
    (magic !== 0x377f0682 && magic !== 0x377f0683) ||
    wal.readUInt32BE(4) !== 3_007_000 ||
    wal.readUInt32BE(8) !== size
  )
    invalid('Retained SQLite WAL has an unsupported header or page size');
  const bigEndian = magic === 0x377f0683;
  let sum = checksum(wal.subarray(0, 24), bigEndian);
  if (!matchesChecksum(wal, 24, sum)) invalid('Retained SQLite WAL header checksum differs');
  const frames: { page: number; data: Buffer }[] = [];
  let committedFrames = 0;
  let pages = main.length / size;
  let staleSuffixBytes = 0;
  for (let offset = 32; offset < wal.length; offset += 24 + size) {
    if (wal.length - offset < 24) invalid('Retained SQLite WAL has an incomplete frame header');
    // SQLite reuses WAL allocation across checkpoints; another salt ends the current generation.
    if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) {
      staleSuffixBytes = wal.length - offset;
      break;
    }
    if (wal.length - offset < 24 + size)
      invalid('Retained SQLite WAL has an incomplete current frame');
    const page = wal.readUInt32BE(offset);
    if (page === 0 || page > 0xfffffffe)
      invalid('Retained SQLite WAL has an invalid page identity');
    const data = wal.subarray(offset + 24, offset + 24 + size);
    sum = checksum(wal.subarray(offset, offset + 8), bigEndian, sum);
    sum = checksum(data, bigEndian, sum);
    if (!matchesChecksum(wal, offset + 16, sum))
      invalid('Retained SQLite WAL frame checksum differs');
    frames.push({ page, data });
    const committedSize = wal.readUInt32BE(offset + 4);
    if (committedSize) {
      pages = committedSize;
      committedFrames = frames.length;
    }
  }
  if (!committedFrames)
    return { bytes: Buffer.from(main), frames: frames.length, committedFrames, staleSuffixBytes };
  if (pages > main.length / size + committedFrames)
    invalid('Retained SQLite WAL declares pages without retained source bytes');
  const image = Buffer.alloc(pages * size);
  main.copy(image);
  const supplied = new Set<number>();
  for (const frame of frames.slice(0, committedFrames)) {
    if (frame.page <= pages) frame.data.copy(image, (frame.page - 1) * size);
    supplied.add(frame.page);
  }
  for (let page = main.length / size + 1; page <= pages; page++)
    if (!supplied.has(page)) invalid('Retained SQLite WAL leaves a missing new page');
  if (pageSize(image) !== size) invalid('Retained SQLite WAL changes the database page size');
  return { bytes: image, frames: frames.length, committedFrames, staleSuffixBytes };
}

function verifyWalIndex(image: WalImage, wal: Buffer | undefined, shm: Buffer | undefined): void {
  if (shm === undefined) {
    if (image.staleSuffixBytes)
      invalid('Retained SQLite stale WAL allocation lacks a corroborating committed header');
    return;
  }
  if (shm.length < 96 || !shm.subarray(0, 48).equals(shm.subarray(48, 96)) || shm[12] !== 1)
    invalid('Retained SQLite shared headers are incomplete or disagree');
  const bigEndian = shm.readUInt32BE(0) === 3_007_000;
  if (!bigEndian && shm.readUInt32LE(0) !== 3_007_000)
    invalid('Retained SQLite shared header version is unsupported');
  const word = (offset: number) =>
    bigEndian ? shm.readUInt32BE(offset) : shm.readUInt32LE(offset);
  const sum = checksum(shm.subarray(0, 40), bigEndian);
  if (word(40) !== sum[0] || word(44) !== sum[1])
    invalid('Retained SQLite shared header checksum differs');
  if (word(16) !== image.committedFrames)
    invalid('Retained SQLite WAL does not cover its acknowledged committed frame');
  if (!image.committedFrames) return;
  const size = pageSize(image.bytes);
  const encodedSize = bigEndian ? shm.readUInt16BE(14) : shm.readUInt16LE(14);
  if (
    (encodedSize === 1 ? 65_536 : encodedSize) !== size ||
    word(20) !== image.bytes.length / size ||
    !wal ||
    shm[13] !== (wal.readUInt32BE(0) & 1) ||
    !shm.subarray(32, 40).equals(wal.subarray(16, 24))
  )
    invalid('Retained SQLite shared header disagrees with its committed WAL generation');
  const offset = 32 + (image.committedFrames - 1) * (24 + size);
  if (word(24) !== wal.readUInt32BE(offset + 16) || word(28) !== wal.readUInt32BE(offset + 20))
    invalid('Retained SQLite committed frame checksum differs from its acknowledged header');
}

const preservedTables = [
  'artifacts',
  'cli_session_branch_state',
  'plan_idempotency',
  'idempotency_blocks',
  'source_plan_links',
  'usage_snapshots',
  'evaluator_lifecycles',
] as const;
const supportedBaselineVersions = [20, 22, 23, 24, 25] as const;
type SupportedBaselineVersion = (typeof supportedBaselineVersions)[number];
const migratedSchemaSignatures = new Map<SupportedBaselineVersion, string>([
  [20, 'c62d9703a0a218ad78201df4576f4426f426789af49837f8da56f0ae8c35947c'],
  [22, '03fd070a7d2b2c003445dec8e92ff08be0fe0681432c7e843613f6e4af277c18'],
]);
const originKindDefinition =
  "  origin_kind   TEXT CHECK (origin_kind IS NULL OR origin_kind = 'git-import'),\n";
const providerDefinition =
  "  provider            TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),\n";
function schemaFor(version: SupportedBaselineVersion): string {
  let schema = BASELINE_SCHEMA.replace(
    `VALUES ('version', '${BASELINE_VERSION}')`,
    `VALUES ('version', '${version}')`
  );
  if (version < 25) schema = schema.replace(originKindDefinition, '');
  if (version < 24) schema = schema.replace(providerDefinition, '');
  return schema;
}
type PreservedTable = (typeof preservedTables)[number];
type Scalar = string | number | null;
export interface LegacySqlite {
  readonly baselineVersion: SupportedBaselineVersion;
  readonly sources: readonly {
    kind: 'main' | 'wal' | 'shm';
    sha256: string;
    bytesBase64: string;
  }[];
  readonly wal: { frames: number; committedFrames: number; staleSuffixBytes: number };
  readonly rows: Readonly<Record<PreservedTable, readonly Readonly<Record<string, Scalar>>[]>>;
  readonly tableCounts: Readonly<Record<string, number>>;
}
const decoded = new WeakSet<LegacySqlite>();
const schemaRows = (db: Database.Database) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
    )
    .all();
const schemaSignature = (db: Database.Database) =>
  createHash('sha256')
    .update(JSON.stringify(schemaRows(db)))
    .digest('hex');

function scalar(value: unknown): Scalar {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      invalid('Retained SQLite integer exceeds the supported exact counter range');
    return Number(value);
  }
  if (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  return invalid('Retained SQLite operational field has an unsupported value type');
}

export function decodeLegacySqlite(input: {
  main: Buffer;
  wal?: Buffer;
  shm?: Buffer;
  rollbackJournal?: Buffer;
}): LegacySqlite {
  const main = Buffer.from(input.main);
  const wal = input.wal === undefined ? undefined : Buffer.from(input.wal);
  const shm = input.shm === undefined ? undefined : Buffer.from(input.shm);
  if (input.rollbackJournal?.length)
    invalid('Retained SQLite rollback journal requires explicit recovery before conversion');
  const image = reconstruct(main, wal ?? Buffer.alloc(0));
  verifyWalIndex(image, wal, shm);
  // deserialize cannot consult a WAL; only this isolated, already reconciled image changes modes.
  image.bytes[18] = 1;
  image.bytes[19] = 1;
  let db: Database.Database | undefined;
  let expected: Database.Database | undefined;
  try {
    const DatabaseConstructor = createRequire(import.meta.url)('better-sqlite3') as typeof Database;
    db = new DatabaseConstructor(image.bytes);
    db.defaultSafeIntegers();
    db.pragma('query_only = ON');
    const storedVersion = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .pluck()
      .get();
    const version = supportedBaselineVersions.find((value) => String(value) === storedVersion);
    if (version === undefined)
      invalid('Retained SQLite version differs from every frozen supported baseline');
    const migratedSignature = migratedSchemaSignatures.get(version);
    if (migratedSignature !== undefined) {
      if (schemaSignature(db) !== migratedSignature)
        invalid('Retained SQLite schema differs from the complete frozen baseline');
    } else {
      expected = new DatabaseConstructor(':memory:');
      expected.exec(schemaFor(version));
      if (JSON.stringify(schemaRows(db)) !== JSON.stringify(schemaRows(expected)))
        invalid('Retained SQLite schema differs from the complete frozen baseline');
    }
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      invalid('Retained SQLite database failed its complete integrity check');
    const foreignKeys = db.pragma('foreign_key_check');
    if (!Array.isArray(foreignKeys) || foreignKeys.length)
      invalid('Retained SQLite database has broken ownership references');
    const rows = {} as Record<PreservedTable, readonly Readonly<Record<string, Scalar>>[]>;
    for (const table of preservedTables) {
      rows[table] = Object.freeze(
        db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((raw) =>
            Object.freeze(
              Object.fromEntries(
                Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
                  key,
                  scalar(value),
                ])
              )
            )
          )
      );
    }
    const tableCounts: Record<string, number> = {};
    for (const { name } of db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]) {
      const count = scalar(
        db
          .prepare(`SELECT COUNT(*) FROM "${name.replaceAll('"', '""')}"`)
          .pluck()
          .get()
      );
      if (typeof count !== 'number') invalid('Retained SQLite row count is invalid');
      tableCounts[name] = count;
    }
    const sources: LegacySqlite['sources'][number][] = [];
    for (const [kind, bytes] of [
      ['main', main],
      ['wal', wal],
      ['shm', shm],
    ] as const)
      if (bytes !== undefined)
        sources.push(
          Object.freeze({
            kind,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytesBase64: bytes.toString('base64'),
          })
        );
    const result: LegacySqlite = Object.freeze({
      baselineVersion: version,
      sources: Object.freeze(sources),
      wal: Object.freeze({
        frames: image.frames,
        committedFrames: image.committedFrames,
        staleSuffixBytes: image.staleSuffixBytes,
      }),
      rows: Object.freeze(rows),
      tableCounts: Object.freeze(tableCounts),
    });
    decoded.add(result);
    return result;
  } catch (error) {
    if (error instanceof HistoryConversionError) throw error;
    return invalid('Retained SQLite bytes could not be verified against the frozen local format');
  } finally {
    db?.close();
    expected?.close();
  }
}

export function assertDecodedLegacySqlite(value: LegacySqlite): void {
  if (!decoded.has(value)) invalid('SQLite import requires an independently decoded source');
}
