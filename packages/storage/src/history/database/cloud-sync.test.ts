import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { appendProjectArtifactEvents } from './artifacts.js';
import * as inputs from './cloud-sync-input.js';
import { readProjectCloudSyncStatus } from './cloud-sync-status.js';
import { readProjectCloudSyncState, recordProjectCloudSyncFailure } from './cloud-sync.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectUsageEvents } from './usage.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { deriveUsageLedgerRecord } from '../../usage/record.js';
import { recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';

const roots: string[] = [],
  handles: ProjectDatabase[] = [],
  databases: Database.Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const target = { server_url: 'https://example.test', org_id: 'org', account_id: 'account' },
  options = { secretAllow: [] as string[] };
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'cloud-sync-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  const file = projectDatabasePath(authority);
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: '2026-09-01T00:00:00Z',
    authorize() {},
  });
  handles.push(handle);
  const db = new Database(file);
  databases.push(db);
  db.pragma('foreign_keys=ON');
  const artifactId = uuidv7();
  const payload = {
    schema_version: 4,
    artifact_id: artifactId,
    branch: 'main',
    base_sha: 'original base',
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain cloud state',
    label: 'Cloud state',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Retain original state',
        label: 'Original state',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: '2026-09-01T00:00:00Z',
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
  const event = {
    event_id: uuidv7(),
    type: 'plan_captured',
    ts: '2026-09-01T00:00:00Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload,
  };
  await appendProjectArtifactEvents(handle, {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
  });
  return { handle, db, authority, artifactId };
}
function input(artifactId: string): inputs.ProjectCloudSyncFailureInput {
  return {
    operationId: uuidv7(),
    revisionId: uuidv7(),
    artifactId,
    target: structuredClone(target),
    kind: 'network',
    message: 'Original unavailable transport',
    attemptedAt: '2026-09-01T00:00:01Z',
    attemptStartedAt: '2026-09-01T00:00:00Z',
  };
}
function rows(handle: ProjectDatabase) {
  return handle.read((view) => ({
    records: view.all('SELECT * FROM cloud_sync_records ORDER BY revision_id'),
    current: view.all('SELECT * FROM cloud_sync_current'),
    receipts: view.all('SELECT * FROM operations ORDER BY operation_id'),
  }));
}
function corrupt(db: Database.Database, change: () => void) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as {
    name: string;
    sql: string;
  }[];
  db.pragma('foreign_keys=OFF');
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    change();
  } finally {
    for (const trigger of triggers) db.exec(trigger.sql);
    db.pragma('foreign_keys=ON');
  }
}
const integrity = { code: 'HISTORY_INTEGRITY_REQUIRED' };
it('retains original failure scalars and one applied result without duplicating the message in its receipt', async () => {
  const { handle, artifactId, db } = await fixture(),
    value = input(artifactId);
  const initial = readProjectCloudSyncState(handle, artifactId, target)!;
  expect(initial).toMatchObject({
    selection: null,
    publicState: null,
    consecutiveFailures: 0,
    pending: true,
  });
  const result = await recordProjectCloudSyncFailure(handle, value, options);
  expect(result).toMatchObject({
    value: {
      revisionId: value.revisionId,
      previousSelection: null,
      applied: true,
      selection: { revisionId: value.revisionId, version: 1 },
    },
    counters: { writeSequence: 3, intentChangeCounter: 1 },
  });
  expect(readProjectCloudSyncState(handle, artifactId, target)).toMatchObject({
    consecutiveFailures: 1,
    lastAttemptAt: value.attemptedAt,
    lastError: { kind: value.kind, message: value.message },
    pending: true,
  });
  const receipt = db
    .prepare('SELECT payload_json FROM operations WHERE operation_id=?')
    .get(value.operationId) as { payload_json: string };
  expect(Object.keys(JSON.parse(receipt.payload_json)).sort()).toEqual([
    'inputSha256',
    'revisionId',
  ]);
  expect(receipt.payload_json).not.toContain(value.message);
});
it('replays original failure after a later failure without incrementing again or preparing', async () => {
  const { handle, artifactId } = await fixture(),
    value = input(artifactId);
  const first = await recordProjectCloudSyncFailure(handle, value, options);
  await recordProjectCloudSyncFailure(
    handle,
    { ...input(artifactId), message: 'Later failure' },
    options
  );
  const before = rows(handle);
  const prepare = vi.spyOn(inputs, 'prepareProjectCloudSyncFailure').mockImplementation(() => {
    throw new Error('must not prepare replay');
  });
  const replay = await recordProjectCloudSyncFailure(handle, value, options);
  expect(replay.value).toEqual(first.value);
  expect(replay.replayed).toBe(true);
  expect(prepare).not.toHaveBeenCalled();
  expect(rows(handle)).toEqual(before);
  await expect(
    recordProjectCloudSyncFailure(handle, { ...value, message: 'Changed original' }, options)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(readProjectCloudSyncState(handle, artifactId, target)!.consecutiveFailures).toBe(2);
});
it('serializes distinct concurrent failures using the actual selected predecessor', async () => {
  const { handle, authority, db, artifactId } = await fixture();
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const one = input(artifactId),
    two = input(artifactId),
    waiting = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  const wait = (name: string) => {
    waiting.add(name);
    if (waiting.size === 2 && db.inTransaction) db.exec('ROLLBACK');
  };
  const results = await Promise.all([
    recordProjectCloudSyncFailure(handle, one, {
      ...options,
      onWait() {
        wait('first');
      },
    }),
    recordProjectCloudSyncFailure(other, two, {
      ...options,
      onWait() {
        wait('second');
      },
    }),
  ]);
  expect(waiting.size).toBe(2);
  expect(results.map((result) => result.value.selection!.version).sort()).toEqual([1, 2]);
  expect(readProjectCloudSyncState(handle, artifactId, target)!.consecutiveFailures).toBe(2);
  expect(rows(handle).value.records).toHaveLength(2);
});
it('serializes equal original failure identity with one receipt and increment', async () => {
  const { handle, authority, db, artifactId } = await fixture(),
    value = input(artifactId);
  const other = await openProjectDatabase({ authority, mode: 'writer' });
  handles.push(other);
  const waiting = new Set<string>();
  db.exec('BEGIN IMMEDIATE');
  const wait = (name: string) => {
    waiting.add(name);
    if (waiting.size === 2 && db.inTransaction) db.exec('ROLLBACK');
  };
  const results = await Promise.all([
    recordProjectCloudSyncFailure(handle, value, {
      ...options,
      onWait() {
        wait('first');
      },
    }),
    recordProjectCloudSyncFailure(other, value, {
      ...options,
      onWait() {
        wait('second');
      },
    }),
  ]);
  expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.value).toEqual(results[1]!.value);
  expect(readProjectCloudSyncState(handle, artifactId, target)!.consecutiveFailures).toBe(1);
});
it('cancels actual SQLite waiting and preserves original copied input for retry', async () => {
  const { handle, db, artifactId } = await fixture(),
    value = input(artifactId),
    saved = structuredClone(value),
    before = rows(handle),
    controller = new AbortController();
  db.exec('BEGIN IMMEDIATE');
  await expect(
    recordProjectCloudSyncFailure(handle, value, {
      ...options,
      signal: controller.signal,
      onWait() {
        value.message = 'mutated';
        controller.abort();
      },
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  db.exec('ROLLBACK');
  expect(rows(handle)).toEqual(before);
  await recordProjectCloudSyncFailure(handle, saved, options);
  expect(readProjectCloudSyncState(handle, artifactId, target)!.lastError!.message).toBe(
    saved.message
  );
});
it('guards supplied handle methods and genuine readonly claims', async () => {
  const read = vi.fn(),
    forged = { read } as unknown as ProjectDatabase;
  expect(() => readProjectCloudSyncState(forged, uuidv7(), target)).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  await expect(
    recordProjectCloudSyncFailure(forged, input(uuidv7()), options)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(read).not.toHaveBeenCalled();
  const { handle, authority, artifactId } = await fixture();
  await recordProjectCloudSyncFailure(handle, input(artifactId), options);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  expect(readProjectCloudSyncState(reader, artifactId, target)).toEqual(
    readProjectCloudSyncState(handle, artifactId, target)
  );
  expect(readProjectCloudSyncState(reader, artifactId, target)!.consecutiveFailures).toBe(1);
});
it.each(['current', 'row', 'both', 'receipt', 'predecessor'] as const)(
  'refuses missing %s without writing another failure',
  async (loss) => {
    const { handle, db, artifactId } = await fixture(),
      first = input(artifactId),
      second = input(artifactId);
    await recordProjectCloudSyncFailure(handle, first, options);
    await recordProjectCloudSyncFailure(handle, second, options);
    corrupt(db, () => {
      if (loss === 'current' || loss === 'both') db.exec('DELETE FROM cloud_sync_current');
      if (loss === 'row' || loss === 'both')
        db.prepare('DELETE FROM cloud_sync_records WHERE revision_id=?').run(second.revisionId);
      if (loss === 'receipt')
        db.prepare('DELETE FROM operations WHERE operation_id=?').run(second.operationId);
      if (loss === 'predecessor')
        db.prepare('DELETE FROM cloud_sync_records WHERE revision_id=?').run(first.revisionId);
    });
    const before = rows(handle);
    expect(() => readProjectCloudSyncState(handle, artifactId, target)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(
      recordProjectCloudSyncFailure(handle, input(artifactId), options)
    ).rejects.toMatchObject(integrity);
    await expect(recordProjectCloudSyncFailure(handle, second, options)).rejects.toMatchObject(
      integrity
    );
    expect(rows(handle)).toEqual(before);
  }
);
it.each(['message', 'hash', 'result', 'kind', 'version'] as const)(
  'refuses inconsistent original %s',
  async (field) => {
    const { handle, db, artifactId } = await fixture(),
      value = input(artifactId);
    await recordProjectCloudSyncFailure(handle, value, options);
    corrupt(db, () => {
      if (field === 'message') db.exec("UPDATE cloud_sync_records SET failure_message='changed'");
      if (field === 'hash')
        db.prepare('UPDATE cloud_sync_records SET record_sha256=?').run('c'.repeat(64));
      if (field === 'result')
        db.prepare('UPDATE operations SET result_json=? WHERE operation_id=?').run(
          '{}',
          value.operationId
        );
      if (field === 'kind')
        db.prepare('UPDATE operations SET operation_kind=? WHERE operation_id=?').run(
          'different.owner',
          value.operationId
        );
      if (field === 'version') db.exec('UPDATE cloud_sync_current SET version=2');
    });
    expect(() => readProjectCloudSyncState(handle, artifactId, target)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(recordProjectCloudSyncFailure(handle, value, options)).rejects.toMatchObject(
      integrity
    );
  }
);
it('refuses authored secrets and absent artifacts without publication', async () => {
  const { handle, artifactId } = await fixture(),
    before = rows(handle),
    value = input(artifactId);
  value.message = ['ghp', 'A'.repeat(36)].join('_');
  await expect(recordProjectCloudSyncFailure(handle, value, options)).rejects.toMatchObject({
    code: 'SECRET_IN_PAYLOAD',
  });
  await expect(
    recordProjectCloudSyncFailure(handle, input(uuidv7()), options)
  ).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
  expect(rows(handle)).toEqual(before);
  expect(readProjectCloudSyncState(handle, uuidv7(), target)).toBeNull();
});
it('keeps unrelated account histories independent', async () => {
  const { handle, artifactId } = await fixture();
  await recordProjectCloudSyncFailure(handle, input(artifactId), options);
  expect(
    readProjectCloudSyncState(handle, artifactId, { ...target, account_id: 'other' })!
      .consecutiveFailures
  ).toBe(0);
  const other = { ...input(artifactId), target: { ...target, account_id: 'other' } };
  await recordProjectCloudSyncFailure(handle, other, options);
  expect(readProjectCloudSyncState(handle, artifactId, target)!.consecutiveFailures).toBe(1);
  expect(readProjectCloudSyncState(handle, artifactId, other.target)!.consecutiveFailures).toBe(1);
});
it('measures scoped retained failure validation and indexed ownership reads', async () => {
  const { handle, db, artifactId } = await fixture();
  const count = 1000,
    started = performance.now();
  for (let n = 0; n < count; n++)
    await recordProjectCloudSyncFailure(
      handle,
      { ...input(artifactId), message: `Retained failure ${n}` },
      options
    );
  const populateMs = performance.now() - started;
  const began = new Map<Database.Database, number>(),
    holds: number[] = [],
    exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const result = exec.call(this, sql);
    if (sql === 'BEGIN IMMEDIATE') began.set(this, performance.now());
    if (sql === 'COMMIT' && began.has(this)) {
      holds.push(performance.now() - began.get(this)!);
      began.delete(this);
    }
    return result;
  });
  await recordProjectCloudSyncFailure(handle, input(artifactId), options);
  const reads: number[] = [];
  for (let n = 0; n < 5; n++) {
    const start = performance.now();
    expect(readProjectCloudSyncState(handle, artifactId, target)!.consecutiveFailures).toBe(
      count + 1
    );
    reads.push(performance.now() - start);
  }
  const plans = {
    records: db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT r.*,o.payload_json FROM cloud_sync_records r LEFT JOIN operations o ON o.operation_id=r.operation_id WHERE r.artifact_id=? AND r.server_url=? AND r.org_id=? AND r.account_id=?'
      )
      .all(artifactId, target.server_url, target.org_id, target.account_id),
    receipts: db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM operations o WHERE o.operation_kind IN ('cloud.sync.failure','artifact.push.complete') AND json_extract(o.target_json,'$.artifactId')=? AND json_extract(o.target_json,'$.target.server_url')=? AND json_extract(o.target_json,'$.target.org_id')=? AND json_extract(o.target_json,'$.target.account_id')=? AND NOT EXISTS (SELECT 1 FROM cloud_sync_records r WHERE r.operation_id=o.operation_id) LIMIT 1`
      )
      .all(artifactId, target.server_url, target.org_id, target.account_id),
  };
  expect(JSON.stringify(plans.records)).toContain('cloud_sync_records_scope');
  expect(JSON.stringify(plans.receipts)).toContain('operations_artifact_target_lookup');
  expect(holds).toHaveLength(1);
  process.stdout.write(
    JSON.stringify({
      observations: count + 1,
      populateMs,
      writerHoldMs: holds[0],
      readMs: reads,
      plans,
    }) + '\n'
  );
}, 120000);
it.each(['reader', 'writer'] as const)(
  'refuses a missing source publication receipt in the cloud %s',
  async (action) => {
    const { handle, db, artifactId } = await fixture();
    await recordProjectCloudSyncFailure(handle, input(artifactId), options);
    const source = db
      .prepare('SELECT operation_id FROM artifact_revisions WHERE artifact_id=? AND generation=1')
      .get(artifactId) as { operation_id: string };
    corrupt(db, () =>
      db.prepare('DELETE FROM operations WHERE operation_id=?').run(source.operation_id)
    );
    const before = rows(handle);
    if (action === 'reader')
      expect(() => readProjectCloudSyncState(handle, artifactId, target)).toThrowError(
        expect.objectContaining(integrity)
      );
    else
      await expect(
        recordProjectCloudSyncFailure(handle, input(artifactId), options)
      ).rejects.toMatchObject(integrity);
    expect(rows(handle)).toEqual(before);
  }
);

it.each(['receipt', 'all rows'] as const)(
  'refuses missing original usage %s as fresh source absence',
  async (loss) => {
    const { handle, db, artifactId } = await fixture(),
      operationId = uuidv7();
    const counters = {
      input_tokens: 12,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const payload = {
      snapshot_id: uuidv7(),
      idempotency_key: uuidv7(),
      agent: 'codex' as const,
      session_id: 'original session',
      artifact_id: artifactId,
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close' as const,
      checkpoint_n: 1,
      cumulative_usage: counters,
      delta_usage: null,
      baseline_kind: 'first_observation' as const,
      model_breakdown: [{ model: 'original model', cumulative: counters, delta: null }],
      record_count: 1,
      as_of: '2026-09-01T00:00:00Z',
    };
    const { record } = deriveUsageLedgerRecord({
      type: 'agent_usage_snapshot_recorded',
      ts: payload.as_of,
      idempotency_key: payload.idempotency_key,
      payload,
    });
    await appendProjectUsageEvents(handle, {
      operationId,
      expectedRevision: null,
      eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
      sidecarPayloads: [],
      secretAllow: [],
    });
    expect(readProjectCloudSyncState(handle, artifactId, target)!.sources.usageGeneration).toBe(1);
    corrupt(db, () => {
      if (loss === 'receipt')
        db.prepare('DELETE FROM operations WHERE operation_id=?').run(operationId);
      else
        db.exec(
          'DELETE FROM usage_selection; DELETE FROM usage_snapshots; DELETE FROM usage_links; DELETE FROM usage_events; DELETE FROM usage_revisions'
        );
    });
    const before = rows(handle);
    expect(() => readProjectCloudSyncState(handle, artifactId, target)).toThrowError(
      expect.objectContaining(integrity)
    );
    await expect(
      recordProjectCloudSyncFailure(handle, input(artifactId), options)
    ).rejects.toMatchObject(integrity);
    expect(rows(handle)).toEqual(before);
  }
);

it('reports never-uploaded artifacts without inventing an account and keeps recorded account failures separate', async () => {
  const f = await fixture();
  expect(readProjectCloudSyncStatus(f.handle).rows).toMatchObject([
    {
      artifactId: f.artifactId,
      target: null,
      pending: true,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    },
  ]);
  await recordProjectCloudSyncFailure(f.handle, input(f.artifactId), options);
  await recordProjectCloudSyncFailure(f.handle, input(f.artifactId), options);
  const other = { ...target, account_id: 'another-account' };
  await recordProjectCloudSyncFailure(
    f.handle,
    { ...input(f.artifactId), target: other, kind: 'upgrade-required' },
    options
  );
  const before = rows(f.handle);
  const result = readProjectCloudSyncStatus(f.handle);
  expect(result.rows).toHaveLength(2);
  expect(result.rows.find((row) => row.target?.account_id === target.account_id)).toMatchObject({
    target,
    pending: true,
    consecutiveFailures: 2,
    nextAttemptAt: '2026-09-01T00:01:01.000Z',
    lastError: { kind: 'network' },
  });
  expect(result.rows.find((row) => row.target?.account_id === other.account_id)).toMatchObject({
    target: other,
    pending: true,
    consecutiveFailures: 1,
    lastError: { kind: 'upgrade-required' },
  });
  expect(rows(f.handle)).toEqual(before);
});

it.each([false, true])(
  'refuses a missing cloud selection even when its record is also missing: %s',
  async (removeRecord) => {
    const f = await fixture();
    await recordProjectCloudSyncFailure(f.handle, input(f.artifactId), options);
    corrupt(f.db, () => {
      f.db.exec('DELETE FROM cloud_sync_current');
      if (removeRecord) f.db.exec('DELETE FROM cloud_sync_records');
    });
    const before = rows(f.handle);
    expect(() => readProjectCloudSyncStatus(f.handle)).toThrow(expect.objectContaining(integrity));
    expect(rows(f.handle)).toEqual(before);
  }
);
