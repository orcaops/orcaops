import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { aggregateProjectUsage, readProjectUsageAccounting } from './usage-accounting.js';
import { appendProjectUsageEvents, readProjectUsage } from './usage.js';
import {
  type ExecutionState,
  prepareExecutionCheckpointRecovery,
  prepareExecutionTransition,
} from '../execution.js';
import { normalizeHistoryRoot } from '../paths.js';
import { readProjectArtifactDetails, resolveProjectArtifactDetails } from './artifact-details.js';
import { resolveProjectArtifactOverview } from './artifact-overview.js';
import * as artifacts from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  appendProjectExecutionCapture,
  prepareExecutionCaptureRequest,
  prepareExecutionCaptureSettlement,
} from './execution-capture.js';
import {
  prepareExecutionRecords,
  readProjectExecution,
  settleExecutionRecords,
} from './execution-records.js';
import { runProjectOperation } from './transactions.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { deriveUsageLedgerRecord } from '../../usage/record.js';
import { recordChecksum } from '../event-integrity.js';

vi.mock('./artifacts.js', async (original) => ({
  ...(await original<typeof import('./artifacts.js')>()),
}));
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(withExecution = true) {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'artifact-details-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const writer = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(writer);
  const saved = JSON.parse(
    await readFile(new URL('./fixtures/artifact-history.json', import.meta.url), 'utf8')
  );
  const event = saved.rows.artifact_events[0];
  const context = {
    repository_instance_id: authority.repositoryInstanceId,
    worktree_id: uuidv7(),
    git_context: { branch: 'topic', head_sha: 'a'.repeat(40) },
  };
  const append = {
    operationId: uuidv7(),
    artifactId: event.artifact_id,
    expectedRevision: null,
    eventBytes: Buffer.from(event.record_bytes.blobHex, 'hex'),
    sidecarPayloads: [],
    secretAllow: [],
  };
  if (withExecution)
    await appendProjectExecutionCapture(writer, {
      ...append,
      execution: { kind: 'create', context, ts: '2026-06-01T00:00:00.000Z' },
    });
  else await artifacts.appendProjectArtifactEvents(writer, append);
  const reader = await openProjectDatabase({ authority, mode: 'reader' });
  handles.push(reader);
  return { writer, reader, context, artifactId: event.artifact_id as string };
}
async function opening(f: Awaited<ReturnType<typeof fixture>>) {
  const artifact = artifacts.readProjectArtifact(f.writer, f.artifactId)!;
  const execution = readProjectExecution(f.writer, f.artifactId)!;
  const event = {
    event_id: uuidv7(),
    type: 'checkpoint_opened' as const,
    ts: '2026-06-01T00:03:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    payload: {
      artifact_id: f.artifactId,
      n: 1,
      declared_step_ids: [artifact.thread.plan!.plan_steps[0].step_id],
      agent: 'codex',
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: artifact.thread.plan!.source_event_id,
      opened_at: '2026-06-01T00:03:00.000Z',
      head_sha: 'a'.repeat(40),
      open_snapshot: {
        snapshot_ref: null,
        tree_sha: null,
        snapshot_commit_sha: null,
        snapshot_error_reason: null,
      },
    },
  };
  const request = prepareExecutionCaptureRequest(f.writer, {
    operationId: uuidv7(),
    artifactId: f.artifactId,
    expectedRevision: artifact.revision,
    eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
    sidecarPayloads: [],
    secretAllow: [],
    execution: {
      kind: 'task',
      context: f.context,
      expectedVersion: execution.version,
      expectedGeneration: execution.state.binding_generation,
      explicitTarget: true,
    },
  });
  return { request, settlement: await prepareExecutionCaptureSettlement(f.writer, request) };
}
it.each(['details', 'resolution', 'overview'] as const)(
  'copies artifact and execution at one snapshot for %s while another writer commits',
  async (mode) => {
    const f = await fixture();
    const { request, settlement } = await opening(f);
    const before = f.reader.read(() => null).counters;
    let publication: ReturnType<typeof runProjectOperation> | undefined;
    const select = artifacts.selectProjectArtifactRecords;
    vi.spyOn(artifacts, 'selectProjectArtifactRecords').mockImplementationOnce((...args) => {
      const value = select(...args);
      publication = runProjectOperation(f.writer, request.operation, settlement.settle);
      publication.catch(() => {});
      expect(f.writer.read(() => null).counters.writeSequence).toBe(before.writeSequence + 1);
      return value;
    });
    const hydrate = artifacts.hydrateProjectArtifactRecords;
    vi.spyOn(artifacts, 'hydrateProjectArtifactRecords').mockImplementationOnce((...args) => {
      expect(f.reader.read(() => null).counters.writeSequence).toBe(before.writeSequence + 1);
      return hydrate(...args);
    });
    const result =
      mode === 'details'
        ? readProjectArtifactDetails(f.reader, [{ artifactId: f.artifactId, executionVersion: 1 }])
        : (() => {
            const resolved =
              mode === 'overview'
                ? resolveProjectArtifactOverview(f.reader, f.artifactId.slice(0, -1))
                : resolveProjectArtifactDetails(f.reader, f.artifactId.slice(0, -1));
            if (resolved.kind !== 'resolved') throw new Error('Expected original artifact');
            return { artifacts: [resolved], counters: resolved.counters };
          })();
    await publication;
    expect(result.counters).toEqual(before);
    expect(result.artifacts[0].artifact!.thread.checkpoints).toHaveLength(0);
    expect(result.artifacts[0].execution!.version).toBe(1);
    expect(result.artifacts[0].execution!.state.checkpoint_execution).toHaveLength(0);
    const next = readProjectArtifactDetails(f.reader, [{ artifactId: f.artifactId }]);
    expect(next.artifacts[0].artifact!.thread.checkpoints).toHaveLength(1);
    expect(next.artifacts[0].execution!.version).toBe(2);
    expect(next.artifacts[0].execution!.state.checkpoint_execution).toHaveLength(1);
  }
);
it('keeps an exact retained artifact revision and reports a changed execution selection', async () => {
  const f = await fixture();
  const original = artifacts.readProjectArtifact(f.reader, f.artifactId)!;
  const { request, settlement } = await opening(f);
  await runProjectOperation(f.writer, request.operation, settlement.settle);
  expect(() =>
    readProjectArtifactDetails(f.reader, [
      { artifactId: f.artifactId, revision: original.revision, executionVersion: 1 },
    ])
  ).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
  const retained = readProjectArtifactDetails(f.reader, [
    { artifactId: f.artifactId, revision: original.revision, executionVersion: 2 },
  ]);
  expect(retained.artifacts[0].artifact!.eventBytes).toEqual(original.eventBytes);
  expect(retained.artifacts[0].artifact!.revision).toEqual(original.revision);
  expect(retained.artifacts[0].execution!.version).toBe(2);
  const missing = readProjectArtifactDetails(f.reader, [{ artifactId: uuidv7() }]);
  expect(missing.artifacts[0]).toMatchObject({ artifact: null, execution: null });
  expect(() =>
    readProjectArtifactDetails(f.reader, [{ artifactId: uuidv7(), revision: original.revision }])
  ).toThrow(expect.objectContaining({ code: 'HISTORY_MISSING' }));
});
it('reports orphan execution associations as damaged history instead of absent execution', async () => {
  const f = await fixture();
  const raw = new Database(f.writer.databasePath);
  try {
    raw.pragma('foreign_keys=OFF');
    const triggers: string[] = [];
    for (const table of [
      'execution_current',
      'execution_transitions',
      'execution_initializations',
    ]) {
      for (const row of raw
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
        .all(table) as { name: string; sql: string }[]) {
        triggers.push(row.sql);
        raw.exec(`DROP TRIGGER ${row.name}`);
      }
      raw.prepare(`DELETE FROM ${table} WHERE artifact_id=?`).run(f.artifactId);
    }
    for (const sql of triggers) raw.exec(sql);
    expect(() => readProjectArtifactDetails(f.reader, [{ artifactId: f.artifactId }])).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(() => readProjectExecution(f.reader, f.artifactId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
  } finally {
    raw.close();
  }
});

it('rejects sparse requests before using a closed database', async () => {
  const f = await fixture();
  f.reader.close();
  expect(() => readProjectArtifactDetails(f.reader, new Array(1))).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
});
it('rejects a structural handle before invoking its read method', () => {
  const read = vi.fn();
  expect(() => readProjectArtifactDetails({ read } as unknown as ProjectDatabase, [])).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(read).not.toHaveBeenCalled();
});
it.each(['artifact_revisions', 'artifact_events'])(
  'refuses a missing artifact header with retained %s',
  async (retainedTable) => {
    const f = await fixture(false);
    const raw = new Database(f.writer.databasePath);
    try {
      raw.pragma('foreign_keys=OFF');
      const removedTable =
        retainedTable === 'artifact_revisions' ? 'artifact_events' : 'artifact_revisions';
      for (const table of ['artifacts', removedTable]) {
        const triggers = raw
          .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
          .all(table) as { name: string; sql: string }[];
        for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
        raw.prepare(`DELETE FROM ${table} WHERE artifact_id=?`).run(f.artifactId);
        for (const trigger of triggers) raw.exec(trigger.sql);
      }
      for (const read of [
        () => readProjectArtifactDetails(f.reader, [{ artifactId: f.artifactId }]),
        () => artifacts.readProjectArtifact(f.reader, f.artifactId),
        () => resolveProjectArtifactDetails(f.reader, f.artifactId),
      ])
        expect(read).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    } finally {
      raw.close();
    }
  }
);

it('resolves exact UUID and unique prefix without hydrating unrelated artifacts', async () => {
  const f = await fixture();
  const select = vi.spyOn(artifacts, 'selectProjectArtifactRecords');
  const exact = resolveProjectArtifactDetails(f.reader, f.artifactId.toUpperCase());
  const prefix = resolveProjectArtifactDetails(f.reader, f.artifactId.slice(0, -1));
  expect(prefix).toEqual(exact);
  expect(exact.kind).toBe('resolved');
  expect(select).toHaveBeenCalledTimes(2);
  expect(select.mock.calls.every((call) => call[1] === f.artifactId)).toBe(true);
  const missing = resolveProjectArtifactDetails(f.reader, uuidv7());
  expect(missing.kind).toBe('missing');
  expect(select).toHaveBeenCalledTimes(3);
});

it('bounds ambiguous prefix candidates using an indexed range without decoding history', async () => {
  const f = await fixture(false);
  const original = JSON.parse(
    artifacts.readProjectArtifact(f.writer, f.artifactId)!.eventBytes.toString('utf8')
  );
  const ids = '0123'
    .split('')
    .map((digit) => f.artifactId.slice(0, -1) + digit)
    .filter((id) => id !== f.artifactId);
  const append = async (artifactId: string) => {
    const { checksum: _checksum, ...event } = structuredClone(original);
    event.event_id = uuidv7();
    event.idempotency_key = uuidv7();
    event.payload.artifact_id = artifactId;
    await artifacts.appendProjectArtifactEvents(f.writer, {
      artifactId,
      operationId: uuidv7(),
      expectedRevision: null,
      eventBytes: Buffer.from(JSON.stringify({ ...event, checksum: recordChecksum(event) }) + '\n'),
      sidecarPayloads: [],
      secretAllow: [],
    });
  };
  await append(ids[0]);
  const decode = vi.spyOn(artifacts, 'hydrateProjectArtifactRecords');
  const pair = resolveProjectArtifactDetails(f.reader, f.artifactId.slice(0, -1));
  expect(pair).toMatchObject({
    kind: 'ambiguous',
    candidates: [f.artifactId, ids[0]].sort(),
    truncated: false,
  });
  expect(decode).not.toHaveBeenCalled();
  decode.mockRestore();
  await append(ids[1]);
  await append(ids[2]);
  const hydration = vi.spyOn(artifacts, 'hydrateProjectArtifactRecords');
  const many = resolveProjectArtifactDetails(f.reader, f.artifactId.slice(0, -1));
  expect(many).toMatchObject({
    kind: 'ambiguous',
    candidates: [f.artifactId, ...ids.slice(0, 3)].sort().slice(0, 2),
    truncated: true,
  });
  expect(hydration).not.toHaveBeenCalled();
  const prefix = f.artifactId.slice(0, -1);
  const raw = new Database(f.reader.databasePath, { readonly: true, fileMustExist: true });
  const plan = raw
    .prepare(
      'EXPLAIN QUERY PLAN SELECT artifact_id FROM artifacts WHERE artifact_id >= ? AND artifact_id < ? ORDER BY artifact_id COLLATE BINARY LIMIT 3'
    )
    .all(
      prefix,
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    ) as Array<{ detail: string }>;
  raw.close();
  expect(plan.some((row) => row.detail.includes('SEARCH artifacts USING'))).toBe(true);
});

it.each(['', '%', 'not-an-id', '0'.repeat(37), null, 42])(
  'refuses invalid identity %s before accessing a reader',
  (requested) => {
    const read = vi.fn();
    expect(() =>
      resolveProjectArtifactDetails({ read } as unknown as ProjectDatabase, requested as string)
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(read).not.toHaveBeenCalled();
  }
);

it('requires a genuine open reader for artifact identity resolution', async () => {
  const read = vi.fn();
  expect(() =>
    resolveProjectArtifactDetails({ read } as unknown as ProjectDatabase, uuidv7())
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(read).not.toHaveBeenCalled();
  const f = await fixture();
  f.reader.close();
  expect(() => resolveProjectArtifactDetails(f.reader, f.artifactId)).toThrow(
    expect.objectContaining({ code: 'HISTORY_INACCESSIBLE' })
  );
});

async function retainExecutionState(handle: ProjectDatabase, state: ExecutionState) {
  const previous = readProjectExecution(handle, state.artifact_id)!;
  const operationId = uuidv7();
  const prepared = prepareExecutionRecords({
    state,
    previous,
    operationId,
    secretAllow: [],
    artifactRevision: artifacts.readProjectArtifact(handle, state.artifact_id)!.revision,
  });
  await runProjectOperation(
    handle,
    {
      operationId,
      kind: 'execution.records',
      target: { artifactId: state.artifact_id },
      payload: { state },
      expectedState: { version: previous.version },
      intentChange: false,
    },
    (view) => settleExecutionRecords(view, prepared)
  );
}

it.each([
  'execution_initializations',
  'execution_current',
  'execution_transitions',
  'execution_associations',
  'execution_checkpoint_attributions',
  'execution_checkpoint_recoveries',
])('preserves prefix identity when only original %s remains', async (retainedTable) => {
  const f = await fixture();
  const { request, settlement } = await opening(f);
  await runProjectOperation(f.writer, request.operation, settlement.settle);
  const current = readProjectExecution(f.writer, f.artifactId)!.state;
  const checkpointId = current.checkpoint_execution[0].checkpoint_event_id;
  const recovered = prepareExecutionTransition({
    state: current,
    operationId: uuidv7(),
    expectedGeneration: current.binding_generation,
    expectedBinding: current.current_binding,
    action: 'orphan_recovered',
    target: { ...current.current_binding!, worktree_id: uuidv7() },
    reason: 'Original checkout is unavailable',
    openCheckpointIds: [checkpointId],
    ts: '2026-06-01T00:04:00.000Z',
  }).executionState;
  await retainExecutionState(f.writer, recovered);
  await retainExecutionState(
    f.writer,
    prepareExecutionCheckpointRecovery({
      state: recovered,
      operationId: uuidv7(),
      checkpointEventId: checkpointId,
      action: 'verified_continuation',
      reason: 'Original evidence was reviewed',
    })
  );
  const raw = new Database(f.writer.databasePath);
  try {
    expect(
      (
        raw
          .prepare(`SELECT count(*) AS n FROM ${retainedTable} WHERE artifact_id=?`)
          .get(f.artifactId) as { n: number }
      ).n
    ).toBeGreaterThan(0);
    raw.pragma('foreign_keys=OFF');
    for (const table of [
      'artifacts',
      'artifact_events',
      'artifact_revisions',
      'execution_initializations',
      'execution_current',
      'execution_transitions',
      'execution_associations',
      'execution_checkpoint_attributions',
      'execution_checkpoint_recoveries',
    ]) {
      if (table === retainedTable) continue;
      const triggers = raw
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
        .all(table) as Array<{ name: string; sql: string }>;
      for (const trigger of triggers) raw.exec(`DROP TRIGGER ${trigger.name}`);
      raw.prepare(`DELETE FROM ${table} WHERE artifact_id=?`).run(f.artifactId);
      for (const trigger of triggers) raw.exec(trigger.sql);
    }
    const before = f.reader.read(() => null).counters;
    expect(() => resolveProjectArtifactDetails(f.reader, f.artifactId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(() => resolveProjectArtifactDetails(f.reader, f.artifactId.slice(0, -1))).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(resolveProjectArtifactDetails(f.reader, 'ffffffff').kind).toBe('missing');
    expect(f.reader.read(() => null).counters).toEqual(before);
  } finally {
    raw.close();
  }
});

it('checks retained prefix identities through bounded indexes without decoding records', async () => {
  const f = await fixture();
  const queries = new Set<string>();
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.includes('SELECT retained.artifact_id')) queries.add(sql);
    return prepare.call(this, sql);
  });
  const hydrate = vi.spyOn(artifacts, 'hydrateProjectArtifactRecords');
  expect(resolveProjectArtifactDetails(f.reader, 'ffffffff').kind).toBe('missing');
  expect(hydrate).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  expect(queries.size).toBe(8);
  const raw = new Database(f.reader.databasePath, { readonly: true, fileMustExist: true });
  try {
    for (const sql of queries) {
      expect(sql).not.toMatch(/record_bytes|record_hash|payload|state_json/);
      const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('ffffffff', 'fffffffg') as Array<{
        detail: string;
      }>;
      expect(
        rows.some(
          (row) =>
            row.detail.includes('SEARCH retained USING') &&
            row.detail.includes('artifact_id>? AND artifact_id<?')
        )
      ).toBe(true);
      expect(
        rows.some(
          (row) =>
            row.detail.includes('SEARCH original USING') && row.detail.includes('artifact_id=?')
        )
      ).toBe(true);
      expect(rows.some((row) => row.detail.includes('SCAN '))).toBe(false);
    }
  } finally {
    raw.close();
  }
});

function usageObservation(artifactId: string, count: number, sessionId = 'selected-session') {
  const usage = {
    input_tokens: count,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const ts = '2026-06-01T00:04:00.000Z';
  const idempotencyKey = uuidv7();
  return deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts,
    idempotency_key: idempotencyKey,
    payload: {
      snapshot_id: uuidv7(),
      idempotency_key: idempotencyKey,
      agent: 'codex',
      session_id: sessionId,
      artifact_id: artifactId,
      source_plan_ref_id: null,
      lifecycle_event: 'checkpoint_close',
      checkpoint_n: 1,
      cumulative_usage: usage,
      delta_usage: null,
      baseline_kind: 'first_observation',
      model_breakdown: [{ model: 'model', cumulative: usage, delta: null }],
      record_count: count,
      as_of: ts,
    },
  }).record;
}
function appendUsage(handle: ProjectDatabase, records: ReturnType<typeof usageObservation>[]) {
  return appendProjectUsageEvents(handle, {
    operationId: uuidv7(),
    expectedRevision: readProjectUsage(handle)?.revision ?? null,
    eventBytes: Buffer.from(records.map((record) => JSON.stringify(record) + '\n').join('')),
    sidecarPayloads: [],
    secretAllow: [],
  });
}
it('copies exact artifact and selected usage before a concurrent usage publication', async () => {
  const f = await fixture();
  await appendUsage(f.writer, [usageObservation(f.artifactId, 10)]);
  const before = f.reader.read(() => null).counters;
  let publication: ReturnType<typeof appendUsage> | undefined;
  const select = artifacts.selectProjectArtifactRecords;
  vi.spyOn(artifacts, 'selectProjectArtifactRecords').mockImplementationOnce((...args) => {
    const value = select(...args);
    publication = appendUsage(f.writer, [usageObservation(f.artifactId, 20)]);
    publication.catch(() => {});
    expect(f.writer.read(() => null).counters.writeSequence).toBe(before.writeSequence + 1);
    return value;
  });
  const hydrate = artifacts.hydrateProjectArtifactRecords;
  vi.spyOn(artifacts, 'hydrateProjectArtifactRecords').mockImplementationOnce((...args) => {
    expect(f.reader.read(() => null).counters.writeSequence).toBe(before.writeSequence + 1);
    return hydrate(...args);
  });
  const result = resolveProjectArtifactOverview(f.reader, f.artifactId);
  await publication;
  expect(result.kind).toBe('resolved');
  if (result.kind !== 'resolved') throw new Error('Expected artifact');
  expect(result.counters).toEqual(before);
  expect(result.usage.counters).toEqual(before);
  expect(result.usage.events).toHaveLength(1);
  expect(result.usage.events[0].payload).toMatchObject({ cumulative_usage: { input_tokens: 10 } });
  const next = resolveProjectArtifactOverview(f.reader, f.artifactId);
  if (next.kind !== 'resolved') throw new Error('Expected artifact');
  expect(next.usage.events).toHaveLength(2);
  expect(next.usage.events[1].payload).toMatchObject({ cumulative_usage: { input_tokens: 20 } });
});
it('keeps related session high-waters and excludes unrelated session bodies from exact usage', async () => {
  const f = await fixture();
  const other = uuidv7();
  await appendUsage(f.writer, [
    usageObservation(f.artifactId, 10),
    usageObservation(other, 20),
    usageObservation(other, 30, 'unrelated'),
  ]);
  const before = f.reader.read(() => null).counters;
  const result = resolveProjectArtifactOverview(f.reader, f.artifactId);
  if (result.kind !== 'resolved') throw new Error('Expected artifact');
  expect(result.usage.artifactIds).toEqual([f.artifactId]);
  expect(result.usage.events).toHaveLength(2);
  expect(
    result.usage.events.every(
      (event) => (event.payload as { session_id: string }).session_id === 'selected-session'
    )
  ).toBe(true);
  expect(
    result.usage.events.map((event) => (event.payload as { artifact_id: string }).artifact_id)
  ).toEqual([f.artifactId, other]);
  expect(f.reader.read(() => null).counters).toEqual(before);
});
it('rejects forged overview and accounting handles without invoking supplied getters or methods', () => {
  const read = vi.fn();
  const authority = vi.fn();
  const fake = {
    read,
    get authority() {
      authority();
      return {};
    },
  } as unknown as ProjectDatabase;
  for (const operation of [
    () => resolveProjectArtifactOverview(fake, uuidv7()),
    () => readProjectUsageAccounting(fake),
    () => aggregateProjectUsage([fake], { artifactIds: ['selected'] }),
  ])
    expect(operation).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(read).not.toHaveBeenCalled();
  expect(authority).not.toHaveBeenCalled();
});
it('does not read usage for an unresolved artifact and refuses missing selected usage instead of rebuilding it', async () => {
  const f = await fixture();
  await appendUsage(f.writer, [usageObservation(f.artifactId, 10)]);
  const raw = new Database(f.writer.databasePath);
  try {
    raw.prepare('DELETE FROM usage_snapshots').run();
    const before = f.reader.read(() => null).counters;
    expect(resolveProjectArtifactOverview(f.reader, uuidv7()).kind).toBe('missing');
    expect(() => resolveProjectArtifactOverview(f.reader, f.artifactId)).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(raw.prepare('SELECT count(*) AS count FROM usage_snapshots').get()).toEqual({
      count: 0,
    });
    expect(f.reader.read(() => null).counters).toEqual(before);
  } finally {
    raw.close();
  }
});
