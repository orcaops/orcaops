import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  importProjectHistory,
  normalizeHistoryRoot,
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
  readProjectHistoryImport,
} from '@orcaops/storage/history/database';

import { compareLegacyImport, prepareLegacyImport } from './import.js';
import { materializeLegacyFixture } from './legacy-fixture.js';
import { prepareLegacySources } from './prepared-sources.js';
import { previewLegacyRepository } from './preview.js';
import { inventoryLegacySource } from './source-files.js';

const directories: string[] = [];
const handles: ProjectDatabase[] = [];
const conversionOperationId = '01a07e00-0000-7000-8000-000000000001';
const creation = {
  commonDirectory: '/legacy/repository/.git',
  device: '77',
  inode: '4242',
  birthtimeNs: '1730000000000000001',
};

afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

async function converted() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-convert-')));
  directories.push(directory);
  const legacy = await materializeLegacyFixture({ directory });
  const preview = await previewLegacyRepository({
    cwd: legacy.cwd,
    root: legacy.root,
    env: legacy.env,
  });
  const prepared = await prepareLegacySources(preview);
  const { source, expected } = prepareLegacyImport(prepared, { conversionOperationId });
  const root = await normalizeHistoryRoot({ root: legacy.root });
  const authority: ProjectDatabaseAuthority = {
    ...root,
    projectId: legacy.projectId,
    storeInstanceId: '01a07e00-0000-7000-8000-000000000002',
    repositoryInstanceId: '01a07e00-0000-7000-8000-000000000003',
  };
  const result = await importProjectHistory({
    authority,
    operationId: conversionOperationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation: creation,
    source,
    authorize() {},
  });
  return { legacy, preview, prepared, source, expected, authority, result };
}

async function opened(authority: ProjectDatabaseAuthority) {
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(handle);
  return handle;
}

describe('legacy conversion apply', { timeout: 180_000 }, () => {
  it('converts the genuine fixture and compares every family against independent source decoding', async () => {
    const { expected, authority, result, legacy } = await converted();
    expect(result.replayed).toBe(false);
    const database = new Database(projectDatabasePath(authority), { readonly: true });
    try {
      const saved = JSON.parse(
        await fs.readFile(
          new URL('../../storage/src/history/database/fixtures/current.json', import.meta.url),
          'utf8'
        )
      );
      expect(database.pragma('user_version', { simple: true })).toBe(29);
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      const definitions = database
        .prepare(
          'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name'
        )
        .all();
      const normalize = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (key, cell) =>
            key === 'sql' ? cell.replace(/\s+/g, ' ').trim() : cell
          )
        );
      expect(normalize(definitions)).toEqual(normalize(saved.definitions));
      expect(database.pragma('foreign_key_check')).toEqual([]);
    } finally {
      database.close();
    }
    const handle = await opened(authority);
    const comparison = handle.read((view) => compareLegacyImport(expected, view)).value;
    expect(comparison.differences).toEqual([]);
    expect(comparison.ok).toBe(true);
    expect(comparison.families.map((family) => family.family).sort()).toEqual([
      'artifacts',
      'attempts',
      'cloudFacts',
      'lifecycles',
      'planIdempotency',
      'receipt',
      'seed',
      'sessionBranches',
      'sourcePlanRecords',
      'sqliteImages',
      'usage',
    ]);
    const byFamily = new Map(comparison.families.map((family) => [family.family, family]));
    expect(byFamily.get('artifacts')!.expected).toBe(6);
    expect(byFamily.get('usage')!.expected).toBe(15);
    expect(byFamily.get('seed')!.expected).toBe(3);
    expect(byFamily.get('lifecycles')!.expected).toBe(12);
    expect(byFamily.get('planIdempotency')!.expected).toBe(3);
    expect(byFamily.get('attempts')!.expected).toBe(1);
    expect(byFamily.get('sourcePlanRecords')!.expected).toBe(3);
    expect(byFamily.get('sessionBranches')!.expected).toBe(1);
    expect(byFamily.get('cloudFacts')!.expected).toBe(2);
    expect(byFamily.get('sqliteImages')!.expected).toBe(1);
    expect(comparison.families.every((family) => family.matched)).toBe(true);
    // Faithful shape: all eight of the frozen writer's cloud columns are carried, and a session
    // carries no update time because the frozen profile records none.
    for (const fact of expected.cloudFacts)
      expect(Object.keys(fact).sort()).toEqual([
        'artifactId',
        'consecutiveFailures',
        'externalId',
        'lastPushAttemptAt',
        'lastPushErrorKind',
        'lastPushErrorMessage',
        'orgId',
        'sourceLocation',
        'syncHash',
        'syncedAt',
      ]);
    for (const session of expected.sessionBranches) expect(session).not.toHaveProperty('updatedAt');
    const receipt = readProjectHistoryImport(handle)!;
    expect(receipt.operationId).toBe(conversionOperationId);
    expect(receipt.sourceManifestHash).toBe(expected.sourceManifestHash);
    expect(receipt.sourceProfile).toBe('orcaops-0.2.0-rc.2');
    expect(receipt.sourceRevision).toBe('9cb6e606cebed31a3e22bb928119c04cb041bfc3');
    expect(JSON.stringify(receipt.omissions)).toContain('intentionally-not-inspected');
    expect((receipt.gitResources as unknown[]).length).toBe(
      legacy.fixture.repository.refs.filter((ref) => ref.ref.startsWith('refs/orcaops/')).length
    );
  });

  it('keeps the prepared source hash stable once the conversion target exists', async () => {
    const { legacy, prepared } = await converted();
    const after = await prepareLegacySources(
      await previewLegacyRepository({ cwd: legacy.cwd, root: legacy.root, env: legacy.env })
    );
    expect(after.manifestSha256).toEqual(prepared.manifestSha256);
    expect(after.manifest.files).toEqual(prepared.manifest.files);
  });

  it('detects a mutated retained row in the converted database', async () => {
    const { expected, authority } = await converted();
    const file = projectDatabasePath(authority);
    const writable = new Database(file);
    try {
      writable.exec(
        "UPDATE artifact_metadata SET origin_kind = 'captured' WHERE origin_kind = 'git-import'"
      );
    } finally {
      writable.close();
    }
    const handle = await opened(authority);
    const comparison = handle.read((view) => compareLegacyImport(expected, view)).value;
    expect(comparison.ok).toBe(false);
    expect(comparison.differences.some((entry) => entry.includes('listing provenance'))).toBe(true);
  });

  it('detects a removed retained legacy row', async () => {
    const { expected, authority } = await converted();
    const writable = new Database(projectDatabasePath(authority));
    try {
      expect(() => writable.exec('DELETE FROM legacy_sqlite_images')).toThrow(
        'Imported legacy history is retained'
      );
      writable.unsafeMode(true);
      writable.exec('PRAGMA writable_schema=ON');
      writable.exec("DELETE FROM sqlite_schema WHERE name='legacy_sqlite_images_no_delete'");
      writable.exec('PRAGMA writable_schema=RESET');
      writable.close();
    } catch (cause) {
      writable.close();
      throw cause;
    }
    const reopened = new Database(projectDatabasePath(authority));
    try {
      reopened.exec('DELETE FROM legacy_sqlite_images');
    } finally {
      reopened.close();
    }
    const view = new Database(projectDatabasePath(authority), { readonly: true });
    try {
      const comparison = compareLegacyImport(expected, {
        all: (sql, ...parameters) => view.prepare(sql).all(...parameters) as never[],
        get: (sql, ...parameters) => (view.prepare(sql).get(...parameters) ?? null) as never,
      });
      expect(comparison.ok).toBe(false);
      expect(
        comparison.differences.some((entry) => entry.includes('sqliteImages: expected 1 rows'))
      ).toBe(true);
    } finally {
      view.close();
    }
  });

  it('leaves the original legacy bytes and refs untouched after the conversion', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'orcaops-convert-')));
    directories.push(directory);
    const legacy = await materializeLegacyFixture({ directory });
    const checkoutBefore = await inventoryLegacySource({ root: legacy.cwd });
    const preview = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    const prepared = await prepareLegacySources(preview);
    const archiveBefore = await inventoryLegacySource({
      root: path.join(legacy.root, 'projects', legacy.projectId),
    });
    const { source } = prepareLegacyImport(prepared, { conversionOperationId });
    const root = await normalizeHistoryRoot({ root: legacy.root });
    await importProjectHistory({
      authority: {
        ...root,
        projectId: legacy.projectId,
        storeInstanceId: '01a07e00-0000-7000-8000-000000000002',
        repositoryInstanceId: '01a07e00-0000-7000-8000-000000000003',
      },
      operationId: conversionOperationId,
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation: creation,
      source,
      authorize() {},
    });
    expect(await inventoryLegacySource({ root: legacy.cwd })).toEqual(checkoutBefore);
    const archiveAfter = await inventoryLegacySource({
      root: path.join(legacy.root, 'projects', legacy.projectId),
    });
    const withoutTarget = (inventory: typeof archiveBefore) =>
      inventory.files.filter((file) => !file.relativePath.startsWith('history.sqlite3'));
    expect(withoutTarget(archiveAfter)).toEqual(withoutTarget(archiveBefore));
    const after = await previewLegacyRepository({
      cwd: legacy.cwd,
      root: legacy.root,
      env: legacy.env,
    });
    expect(after.manifestHash).toEqual(preview.manifestHash);
    expect(after.target?.database.state).toEqual('present');
  });
});

/**
 * Alters one retained value in the converted database and reads the comparison back. Retained
 * tables refuse updates, so the guard is dropped first — the point is to prove the comparison
 * would catch a value that changed, not that the guards can be bypassed in normal use.
 */
function mutate(
  file: string,
  table: string,
  column: string,
  value: string | number | Buffer | null
): void {
  const database = new Database(file);
  try {
    expect(() => database.prepare(`UPDATE ${table} SET ${column} = ?`).run(value as never)).toThrow(
      'Imported legacy history is immutable'
    );
    database.unsafeMode(true);
    database.exec('PRAGMA writable_schema=ON');
    database.prepare('DELETE FROM sqlite_schema WHERE name = ?').run(`${table}_no_update`);
    database.exec('PRAGMA writable_schema=RESET');
  } finally {
    database.close();
  }
  const writable = new Database(file);
  try {
    writable.prepare(`UPDATE ${table} SET ${column} = ?`).run(value as never);
  } finally {
    writable.close();
  }
}

describe('every retained legacy value is compared', { timeout: 300_000 }, () => {
  // Columns whose CHECK constraints already refuse a changed value (account_provenance and
  // baseline_version) are covered by the schema itself and are asserted separately below.
  const cases: readonly [string, string, string | number | Buffer | null][] = [
    ['legacy_session_branch_state', 'current_branch', 'rewritten'],
    ['legacy_session_branch_state', 'branch_history_json', '["rewritten"]'],
    ['legacy_session_branch_state', 'base_commit_sha', 'f'.repeat(40)],
    ['legacy_session_branch_state', 'acked_at', '2099-01-01T00:00:00.000Z'],
    ['legacy_session_branch_state', 'updated_at', '2099-01-01T00:00:00.000Z'],
    ['legacy_session_branch_state', 'source_location', '/rewritten'],
    ['legacy_artifact_cloud_facts', 'synced_at', '2099-01-01T00:00:00.000Z'],
    ['legacy_artifact_cloud_facts', 'sync_hash', 'a'.repeat(64)],
    ['legacy_artifact_cloud_facts', 'external_id', 'rewritten'],
    ['legacy_artifact_cloud_facts', 'org_id', 'rewritten'],
    ['legacy_artifact_cloud_facts', 'last_push_attempt_at', '2099-01-01T00:00:00.000Z'],
    ['legacy_artifact_cloud_facts', 'last_push_error_kind', 'rewritten'],
    ['legacy_artifact_cloud_facts', 'last_push_error_message', 'rewritten'],
    ['legacy_artifact_cloud_facts', 'consecutive_failures', 99],
    ['legacy_artifact_cloud_facts', 'source_location', '/rewritten'],
    ['legacy_source_plan_records', 'kind', 'review'],
    ['legacy_source_plan_records', 'namespace_base_url', 'https://rewritten.example'],
    ['legacy_source_plan_records', 'namespace_org_id', 'rewritten'],
    ['legacy_source_plan_records', 'external_id', 'rewritten'],
    ['legacy_source_plan_records', 'slug', 'rewritten'],
    ['legacy_source_plan_records', 'version_number', 99],
    ['legacy_source_plan_records', 'version_id', 'rewritten'],
    ['legacy_source_plan_records', 'title', 'rewritten'],
    ['legacy_source_plan_records', 'content_hash', 'b'.repeat(64)],
    ['legacy_source_plan_records', 'real_path', '/rewritten'],
    ['legacy_source_plan_records', 'pulled_at', '2099-01-01T00:00:00.000Z'],
    ['legacy_source_plan_records', 'record_sha256', 'c'.repeat(64)],
    ['legacy_source_plan_records', 'record_bytes', Buffer.from('{"rewritten":true}')],
    ['legacy_source_plan_records', 'body_bytes', Buffer.from('rewritten body')],
    ['legacy_sqlite_images', 'sha256', 'd'.repeat(64)],
    ['legacy_sqlite_images', 'byte_length', 99],
    ['legacy_sqlite_images', 'wal_frames', 99],
    ['legacy_sqlite_images', 'committed_frames', 99],
    ['legacy_sqlite_images', 'table_counts_json', '{"rewritten":1}'],
  ];

  it.each(cases)('refuses a rewritten %s.%s', async (table, column, value) => {
    const { expected, authority } = await converted();
    const file = projectDatabasePath(authority);
    mutate(file, table, column, value);
    const view = new Database(file, { readonly: true });
    try {
      const comparison = compareLegacyImport(expected, {
        all: (sql, ...parameters) => view.prepare(sql).all(...parameters) as never[],
        get: (sql, ...parameters) => (view.prepare(sql).get(...parameters) ?? null) as never,
      });
      expect(comparison.ok).toBe(false);
      expect(comparison.differences.join('\n')).toContain('field');
    } finally {
      view.close();
    }
  });

  // These four cannot be rewritten to a wrong value at all: their CHECK constraints refuse
  // before a comparison is needed, which is why they are absent from the mutation cases above.
  it.each([
    ['legacy_session_branch_state', 'account_provenance', "'invented'"],
    ['legacy_artifact_cloud_facts', 'account_provenance', "'invented'"],
    ['legacy_source_plan_records', 'account_provenance', "'invented'"],
    ['legacy_sqlite_images', 'baseline_version', '21'],
  ] as const)('refuses a rewritten %s.%s at the schema itself', async (table, column, value) => {
    const { authority } = await converted();
    const database = new Database(projectDatabasePath(authority));
    try {
      database.unsafeMode(true);
      database.exec('PRAGMA writable_schema=ON');
      database.prepare('DELETE FROM sqlite_schema WHERE name = ?').run(`${table}_no_update`);
      database.exec('PRAGMA writable_schema=RESET');
    } finally {
      database.close();
    }
    const writable = new Database(projectDatabasePath(authority));
    try {
      expect(() => writable.prepare(`UPDATE ${table} SET ${column} = ${value}`).run()).toThrow(
        /CHECK constraint failed/
      );
    } finally {
      writable.close();
    }
  });
});
