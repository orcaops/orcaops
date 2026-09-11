import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { digest } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { listProjectArtifacts, readProjectArtifact } from './artifacts.js';
import { readProjectArtifactAttempts } from './capture-attempts.js';
import {
  readProjectLifecycleCompletions,
  readProjectPlanIdempotency,
} from './capture-lifecycles.js';
import {
  openProjectDatabase,
  type ProjectDatabase,
  type ProjectDatabaseAuthority,
  projectDatabasePath,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { readProjectExecution } from './execution-records.js';
import {
  derivedImportOperationId,
  importProjectHistory,
  readProjectHistoryImport,
} from './legacy-import.js';
import { readProjectUsage } from './usage.js';
import { legacySource, record } from '../../../tests/legacy-import-source.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function target(): Promise<ProjectDatabaseAuthority> {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'legacy-import-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  return authority;
}

const repositoryCreation = {
  commonDirectory: '/legacy/repository/.git',
  device: '77',
  inode: '4242',
  birthtimeNs: '1730000000000000001',
};

async function opened(authority: ProjectDatabaseAuthority) {
  const handle = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(handle);
  return handle;
}

it('creates the target and commits every legacy family in one transaction', async () => {
  const authority = await target();
  const { source, first, second } = legacySource();
  const operationId = uuidv7();
  const result = await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  expect(result.replayed).toBe(false);
  expect(result.receipt).toMatchObject({
    operationId,
    sourceProfile: 'orcaops-0.2.0-rc.2',
    sourceManifestHash: source.sourceManifestHash,
    importedAt: '2026-09-07T12:00:00.000Z',
  });
  expect(result.receipt.counts).toMatchObject({
    artifacts: 2,
    artifactEvents: 2,
    usageEvents: 2,
    sessionBranches: 1,
    cloudFacts: 2,
    sourcePlanRecords: 1,
    sqliteImages: 1,
  });

  const handle = await opened(authority);
  expect(readProjectHistoryImport(handle)).toEqual(result.receipt);
  expect(
    listProjectArtifacts(handle, { limit: 10 }).artifacts.map((row) => row.artifactId)
  ).toEqual([second, first]);
  expect(readProjectArtifact(handle, first)!.eventBytes).toEqual(
    Buffer.from(source.artifacts[0]!.eventBytes)
  );
  expect(readProjectUsage(handle)!.revision.eventCount).toBe(2);
  expect(readProjectExecution(handle, first)!.state.origin_kind).toBe('captured');
  const rows = handle.read((view) => ({
    counters: view.get<{ w: number; i: number }>(
      'SELECT write_sequence AS w, intent_change_counter AS i FROM project_counters'
    )!,
    operations: view.all<{ operation_kind: string }>(
      'SELECT operation_kind FROM operations ORDER BY committed_write_sequence'
    ),
    sessions: view.all<Record<string, unknown>>('SELECT * FROM legacy_session_branch_state'),
    cloud: view.all<Record<string, unknown>>(
      'SELECT * FROM legacy_artifact_cloud_facts ORDER BY artifact_id'
    ),
    sessionColumns: view.all<Record<string, unknown>>(
      'SELECT * FROM legacy_session_branch_state ORDER BY ordinal'
    ),
    plans: view.all<Record<string, unknown>>(
      `SELECT source_location, kind, external_id, slug, version_number, title, content_hash,
         account_provenance, record_sha256, hex(body_bytes) AS body
       FROM legacy_source_plan_records`
    ),
    images: view.all<Record<string, unknown>>('SELECT * FROM legacy_sqlite_images'),
  })).value;
  expect(rows.counters).toEqual({ w: rows.operations.length + 1, i: 3 });
  expect(rows.operations.map((row) => row.operation_kind)).toEqual([
    'capture.append',
    'capture.append',
    'usage.append',
    'history.convert.import',
  ]);
  expect(rows.cloud.map((row) => row.artifact_id).sort()).toEqual([first, second].sort());
  expect(rows.sessions).toHaveLength(1);
  expect(rows.sessions[0]).toMatchObject({
    repo_url: 'https://git.example.test/legacy.git',
    account_provenance: 'unknown',
  });
  expect(rows.cloud.every((row) => row.account_provenance === 'unknown')).toBe(true);
  expect(rows.cloud.find((row) => row.artifact_id === first)).toMatchObject({
    synced_at: '2026-06-02T09:05:00.000Z',
    last_push_error_kind: 'http-5xx',
    last_push_error_message: 'upstream unavailable',
    last_push_attempt_at: '2026-06-02T09:40:00.000Z',
    consecutive_failures: 3,
  });
  expect(rows.sessionColumns[0]).toMatchObject({ acked_at: null, updated_at: null });
  expect(rows.plans[0]).toMatchObject({ external_id: 'plan-gamma', account_provenance: 'unknown' });
  expect(rows.images[0]).toMatchObject({ part: 'main', baseline_version: 25 });
});

it('derives the same family receipts from the same conversion operation', () => {
  const operationId = uuidv7();
  const derived = derivedImportOperationId(operationId, 'usage');
  expect(derived).toEqual(derivedImportOperationId(operationId, 'usage'));
  expect(derived).not.toEqual(derivedImportOperationId(operationId, 'seed'));
  expect(derived).not.toEqual(derivedImportOperationId(uuidv7(), 'usage'));
  expect(derived).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it.each([20, 22, 23, 24, 25] as const)(
  'records legacy SQLite baseline %s provenance',
  async (version) => {
    const authority = await target();
    const fixture = legacySource();
    const source = {
      ...fixture.source,
      sqliteImages: fixture.source.sqliteImages.map((image) => ({
        ...image,
        baselineVersion: version,
      })),
    };
    await importProjectHistory({
      authority,
      operationId: uuidv7(),
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation,
      source,
      authorize() {},
    });
    const handle = await opened(authority);
    expect(
      handle.read((view) =>
        view.get<{ baseline_version: number }>('SELECT baseline_version FROM legacy_sqlite_images')
      ).value
    ).toEqual({ baseline_version: version });
  }
);

it('leaves no committed schema when the commit fails and retries to the same committed result', async () => {
  const authority = await target();
  const { source } = legacySource();
  const operationId = uuidv7();
  const file = projectDatabasePath(authority);
  const commit = Database.prototype.exec;
  const fault = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (this.name === file && sql === 'COMMIT')
      throw new Database.SqliteError('Original conversion interrupted', 'SQLITE_IOERR');
    return commit.call(this, sql);
  });
  await expect(
    importProjectHistory({
      authority,
      operationId,
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation,
      source,
      authorize() {},
    })
  ).rejects.toThrow('Original conversion interrupted');
  fault.mockRestore();
  expect((await stat(file)).isFile()).toBe(true);
  const leftover = new Database(file, { readonly: true });
  try {
    expect(leftover.prepare('SELECT count(*) AS n FROM sqlite_schema').get()).toEqual({ n: 0 });
  } finally {
    leftover.close();
  }
  const retried = await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  expect(retried.replayed).toBe(false);
  expect(retried.receipt.operationId).toBe(operationId);
  const handle = await opened(authority);
  expect(readProjectHistoryImport(handle)!.counts).toEqual(retried.receipt.counts);
});

it('replays the original conversion and refuses a different one without mutating the target', async () => {
  const authority = await target();
  const { source } = legacySource();
  const operationId = uuidv7();
  const original = await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  const file = projectDatabasePath(authority);
  const before = await readFile(file);
  const replayed = await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  expect(replayed).toEqual({ receipt: original.receipt, replayed: true });
  await expect(
    importProjectHistory({
      authority,
      operationId: uuidv7(),
      importedAt: '2026-09-07T12:30:00.000Z',
      repositoryCreation,
      source,
      authorize() {},
    })
  ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  await expect(
    importProjectHistory({
      authority,
      operationId,
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation,
      source: { ...source, sourceManifestHash: createHash('sha256').update('other').digest('hex') },
      authorize() {},
    })
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect((await readFile(file)).equals(before)).toBe(true);
});

it('refuses to label an initialized store converted and keeps imported rows immutable', async () => {
  const authority = await target();
  const { source } = legacySource();
  const operationId = uuidv7();
  await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  const writable = new Database(projectDatabasePath(authority));
  try {
    expect(() =>
      writable.exec("UPDATE legacy_import SET source_revision = 'rewritten' WHERE singleton = 1")
    ).toThrow('Imported legacy history is immutable');
    expect(() => writable.exec('DELETE FROM legacy_sqlite_images')).toThrow(
      'Imported legacy history is retained'
    );
    expect(() =>
      writable.exec(
        "INSERT INTO legacy_artifact_cloud_facts VALUES ('x','t',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'l','unknown')"
      )
    ).toThrow('Legacy rows belong to the original conversion transaction');
  } finally {
    writable.close();
  }
});

it('refuses an occupied target that was never converted', async () => {
  const authority = await target();
  const { source } = legacySource();
  const { initializeProjectDatabase } = await import('./connection.js');
  const existing = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-07T11:00:00.000Z',
    authorize() {},
  });
  existing.close();
  await expect(
    importProjectHistory({
      authority,
      operationId: uuidv7(),
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation,
      source,
      authorize() {},
    })
  ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
});

it('imports retained lifecycle, attempt and plan-key provenance under derived receipts', async () => {
  const authority = await target();
  const base = legacySource();
  const captureSource = {
    identity: 'legacy-cache',
    locator: '/legacy/repository/.orcaops/cache/orcaops.db',
    revisionId: null,
    eventId: null,
    operationId: null,
    sha256: null,
  };
  const lifecycleBytes = Buffer.from(
    JSON.stringify({ fires_at: 'post-plan', cp_n: 0, triggered_at: '2026-06-01T00:02:00.000Z' })
  );
  const laterLifecycleBytes = Buffer.from(
    JSON.stringify({ fires_at: 'post-plan', cp_n: 0, triggered_at: '2026-06-01T00:04:00.000Z' })
  );
  const attemptBytes = Buffer.from(
    JSON.stringify({
      artifact_id: base.first,
      idempotency_key: 'legacy-open-attempt',
      event_type: 'checkpoint_opened',
      outcome: 'soft_blocked',
      payload_hash: digest(Buffer.from('attempt payload')),
      evaluator_fingerprint: null,
      envelope: null,
      recorded_at: '2026-06-01T00:03:00.000Z',
    })
  );
  const operationId = uuidv7();
  const result = await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source: {
      ...base.source,
      planIdempotency: [
        {
          artifactId: base.first,
          idempotencyKey: 'legacy-plan-key',
          createdAt: '2026-06-01T00:00:00.000Z',
          source: captureSource,
        },
      ],
      lifecycles: [
        { artifactId: base.first, bytes: lifecycleBytes, source: captureSource },
        { artifactId: base.first, bytes: laterLifecycleBytes, source: captureSource },
      ],
      attempts: [{ artifactId: base.first, bytes: attemptBytes, source: captureSource }],
    },
    authorize() {},
  });
  expect(result.receipt.counts).toMatchObject({
    planIdempotency: 1,
    lifecycles: 2,
    attempts: 1,
  });
  const handle = await opened(authority);
  const rows = handle.read((view) => ({
    planKeys: view.all<{ idempotency_key: string; source_kind: string; source_profile: string }>(
      'SELECT idempotency_key, source_kind, source_profile FROM plan_idempotency_records'
    ),
    lifecycles: view.all<{ fires_at: string; source_kind: string }>(
      'SELECT fires_at, source_kind FROM artifact_lifecycle_revisions'
    ),
    attempts: view.all<{ idempotency_key: string; outcome: string; source_kind: string }>(
      'SELECT idempotency_key, outcome, source_kind FROM artifact_attempt_revisions'
    ),
    receipts: view.all<{ operation_id: string; operation_kind: string }>(
      `SELECT operation_id, operation_kind FROM operations
       WHERE operation_kind <> 'history.convert.import' AND operation_kind <> 'usage.append'
       ORDER BY committed_write_sequence`
    ),
  })).value;
  expect(rows.planKeys).toEqual([
    {
      idempotency_key: 'legacy-plan-key',
      source_kind: 'historical',
      source_profile: '0.2.0-rc.2',
    },
  ]);
  expect(rows.lifecycles).toEqual([
    { fires_at: 'post-plan', source_kind: 'historical' },
    { fires_at: 'post-plan', source_kind: 'historical' },
  ]);
  expect(rows.attempts).toEqual([
    { idempotency_key: 'legacy-open-attempt', outcome: 'soft_blocked', source_kind: 'historical' },
  ]);
  // The live operation kinds, so the live selection proofs and the artifact-target index see
  // imported receipts exactly as they see authored ones.
  expect(rows.receipts.map((row) => row.operation_kind)).toEqual([
    'capture.append',
    'capture.append',
    'plan-key.publish',
    'lifecycle.publish',
    'lifecycle.publish',
    'attempt.publish',
  ]);
  expect(rows.receipts.at(-1)!.operation_id).toEqual(
    derivedImportOperationId(operationId, 'attempt:0')
  );
  expect(readProjectLifecycleCompletions(handle, base.first).records).toMatchObject([
    { record: { triggered_at: '2026-06-01T00:04:00.000Z' }, selection: { version: 2 } },
  ]);
  expect(readProjectArtifactAttempts(handle, base.first).records).toHaveLength(1);
  expect(readProjectPlanIdempotency(handle, 'legacy-plan-key')?.record.artifact_id).toEqual(
    base.first
  );
});

it('cancels before commit, leaves a schema-less target, and converges on retry', async () => {
  const authority = await target();
  const { source } = legacySource();
  const operationId = uuidv7();
  const file = projectDatabasePath(authority);
  const controller = new AbortController();
  const original = Database.prototype.exec;
  const watch = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const result = original.call(this, sql);
    // Abort once the exclusive transaction is open and rows are going in, so the rollback
    // has something to undo.
    if (this.name === file && sql === 'BEGIN IMMEDIATE') controller.abort();
    return result;
  });
  await expect(
    importProjectHistory({
      authority,
      operationId,
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation,
      source,
      authorize() {},
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  watch.mockRestore();
  const leftover = new Database(file, { readonly: true });
  try {
    expect(leftover.prepare('SELECT count(*) AS n FROM sqlite_schema').get()).toEqual({ n: 0 });
  } finally {
    leftover.close();
  }
  const retried = await importProjectHistory({
    authority,
    operationId,
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  expect(retried.receipt.operationId).toBe(operationId);
  const handle = await opened(authority);
  expect(readProjectHistoryImport(handle)!.operationId).toBe(operationId);
});

it('refuses a retained artifact whose thread has no captured plan', async () => {
  const authority = await target();
  const { source } = legacySource();
  const lineage = record(
    'branch_lineage_updated',
    {
      artifact_id: source.artifacts[0]!.artifactId,
      branch: 'rebased',
      head_sha: 'next-head',
      ts: '2026-06-01T00:02:00.000Z',
      event: 'rebased',
    },
    '2026-06-01T00:02:00.000Z'
  );
  // Whichever guard fires first, a plan-less thread must produce an actionable typed refusal
  // rather than a TypeError from dereferencing the missing plan.
  const refusal = await importProjectHistory({
    authority,
    operationId: uuidv7(),
    importedAt: '2026-09-07T12:00:00.000Z',
    repositoryCreation,
    source: {
      ...source,
      artifacts: [{ ...source.artifacts[0]!, eventBytes: lineage.bytes }],
    },
    authorize() {},
  }).then(
    () => null,
    (cause: unknown) => cause
  );
  expect(refusal).toBeInstanceOf(ProjectDatabaseError);
  expect(refusal).not.toBeInstanceOf(TypeError);
  expect((refusal as ProjectDatabaseError).code).toEqual(expect.any(String));
  expect((refusal as ProjectDatabaseError).message).not.toContain('undefined');
});

it('discloses a concurrent conversion as a retryable outcome, not a silent busy timeout', async () => {
  const authority = await target();
  const { source } = legacySource();
  const file = projectDatabasePath(authority);
  // A concurrent conversion is another connection holding the write lock on a target it created.
  // The file exists, so the import takes the existed branch that used to block on the open-time
  // busy timeout and surface a raw busy error.
  const holder = new Database(file);
  holder.pragma('journal_mode = WAL');
  holder.exec('BEGIN IMMEDIATE');
  try {
    const outcome = await importProjectHistory({
      authority,
      operationId: uuidv7(),
      importedAt: '2026-09-07T12:00:00.000Z',
      repositoryCreation,
      source,
      authorize() {},
    }).catch((cause: unknown) => cause);
    expect(outcome).toBeInstanceOf(ProjectDatabaseError);
    expect(outcome).toMatchObject({ code: 'TRANSACTION_FAILED', reason: 'contention' });
    expect((outcome as Error).message).toMatch(/another conversion is writing/i);
    // The refused conversion committed nothing: the target still holds no store identity.
    expect(
      holder
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='store_identity'"
        )
        .get()
    ).toBeUndefined();
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  // Once the lock is released the leftover empty target is re-entered and converts normally.
  const done = await importProjectHistory({
    authority,
    operationId: uuidv7(),
    importedAt: '2026-09-07T12:05:00.000Z',
    repositoryCreation,
    source,
    authorize() {},
  });
  expect(done.replayed).toBe(false);
  const handle = await opened(authority);
  expect(readProjectHistoryImport(handle)).toEqual(done.receipt);
});
