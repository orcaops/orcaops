import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import type { AgentUsageSnapshotPayload } from '../../schema/usage-ledger.js';
import { deriveUsageLedgerRecord } from '../../usage/record.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import { aggregateCanonicalUsage } from '../usage-accounting.js';
import {
  initializeProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import {
  aggregateProjectUsage,
  discoverProjectUsageSessions,
  estimateProjectArtifactUsage,
  readProjectUsageAccounting,
} from './usage-accounting.js';
import { appendProjectUsageEvents, readProjectUsage } from './usage.js';

const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-usage-accounting-')),
  });
  roots.push(root.resolvedRoot);
  const authority = {
    ...root,
    projectId: uuidv7(),
    storeInstanceId: uuidv7(),
    repositoryInstanceId: uuidv7(),
  };
  await mkdir(path.dirname(projectDatabasePath(authority)), { recursive: true });
  const handle = await initializeProjectDatabase({
    authority,
    initializationOperationId: uuidv7(),
    initializedAt: new Date().toISOString(),
    authorize() {},
  });
  handles.push(handle);
  return { handle, authority };
}
function counters(input: number) {
  return {
    input_tokens: input,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
function observation(count: number, changes: Partial<AgentUsageSnapshotPayload> = {}) {
  const payload: AgentUsageSnapshotPayload = {
    snapshot_id: uuidv7(),
    idempotency_key: uuidv7(),
    agent: 'codex',
    session_id: 'session',
    artifact_id: 'artifact',
    source_plan_ref_id: null,
    lifecycle_event: 'checkpoint_close',
    checkpoint_n: 1,
    cumulative_usage: counters(count),
    delta_usage: null,
    baseline_kind: 'first_observation',
    model_breakdown: [{ model: 'model', cumulative: counters(count), delta: null }],
    record_count: count,
    as_of: `2026-09-05T00:${String(count % 60).padStart(2, '0')}:00.000Z`,
    ...changes,
  };
  return deriveUsageLedgerRecord({
    type: 'agent_usage_snapshot_recorded',
    ts: payload.as_of,
    idempotency_key: payload.idempotency_key,
    payload,
  }).record;
}
async function append(handle: ProjectDatabase, records: ReturnType<typeof observation>[]) {
  return appendProjectUsageEvents(handle, {
    operationId: uuidv7(),
    expectedRevision: readProjectUsage(handle)?.revision ?? null,
    eventBytes: Buffer.from(records.map((record) => JSON.stringify(record) + '\n').join('')),
    sidecarPayloads: [],
    secretAllow: [],
  });
}
describe('database usage accounting', () => {
  it('discovers scoped sessions without decoding observations and refuses a changed selection', async () => {
    const { handle, authority } = await fixture();
    await append(handle, [observation(10)]);
    const before = discoverProjectUsageSessions(handle, { artifactIds: ['artifact'] });
    expect(before.sessions).toEqual([{ agent: 'codex', sessionId: 'session' }]);
    const db = new Database(projectDatabasePath(authority));
    try {
      db.prepare(
        "UPDATE usage_snapshots SET cumulative_json = '{}' WHERE session_id = 'session'"
      ).run();
      expect(discoverProjectUsageSessions(handle, { artifactIds: ['artifact'] })).toEqual(before);
      expect(() => readProjectUsageAccounting(handle, { sessions: before.sessions })).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      db.prepare("UPDATE usage_snapshots SET cumulative_json = ? WHERE session_id = 'session'").run(
        JSON.stringify(counters(10))
      );
    } finally {
      db.close();
    }
    await append(handle, [observation(20)]);
    for (const read of [discoverProjectUsageSessions, readProjectUsageAccounting])
      expect(() =>
        read(handle, {
          artifactIds: ['artifact'],
          expectedWriteSequence: before.counters.writeSequence,
        })
      ).toThrow(expect.objectContaining({ code: 'STALE_CONTEXT' }));
    const current = discoverProjectUsageSessions(handle, { artifactIds: ['artifact'] });
    expect(
      readProjectUsageAccounting(handle, {
        artifactIds: ['artifact'],
        sessions: current.sessions,
        expectedWriteSequence: current.counters.writeSequence,
      }).counters
    ).toEqual(current.counters);
  });
  it('keeps session tuple identity across projects with different artifact selections', async () => {
    const a = await fixture();
    const b = await fixture();
    await append(a.handle, [observation(10)]);
    await append(b.handle, [
      observation(20, { artifact_id: 'different' }),
      observation(30, { artifact_id: 'different', agent: 'cursor' }),
      observation(40, { artifact_id: 'different', session_id: 'other' }),
    ]);
    const selected = discoverProjectUsageSessions(a.handle, { artifactIds: ['artifact'] });
    const inputs = [
      readProjectUsageAccounting(a.handle, {
        artifactIds: ['artifact'],
        sessions: selected.sessions,
      }),
      readProjectUsageAccounting(b.handle, { artifactIds: [], sessions: selected.sessions }),
    ];
    expect(inputs[1].events).toHaveLength(1);
    expect(aggregateCanonicalUsage(inputs)).toMatchObject({
      status: 'exact',
      totals: counters(20),
    });
    expect(aggregateCanonicalUsage(inputs).sessions).toHaveLength(1);
  });
  it('selects artifact and source-plan associations beyond SQLite parameter limits without duplicate rows', async () => {
    const { handle } = await fixture();
    const ids = Array.from({ length: 18000 }, (_, index) => `selected-${index}`);
    const link = deriveUsageLedgerRecord({
      type: 'source_plan_linked',
      ts: '2026-09-05T00:20:00.000Z',
      idempotency_key: uuidv7(),
      payload: {
        canonical_ref_id: 'plan',
        artifact_id: ids.at(-1)!,
        linked_at: '2026-09-05T00:20:00.000Z',
        pinned_version: null,
      },
    }).record;
    await append(handle, [
      observation(10, { artifact_id: null, source_plan_ref_id: 'plan' }),
      link,
    ]);
    const selected = discoverProjectUsageSessions(handle, { artifactIds: [...ids, ...ids] });
    expect(selected.sessions).toHaveLength(1);
    const input = readProjectUsageAccounting(handle, { artifactIds: [...ids, ...ids] });
    expect(input.events).toHaveLength(2);
    expect(aggregateCanonicalUsage([input])).toMatchObject({
      status: 'exact',
      totals: counters(10),
    });
  });
  it('rejects malformed session selections and write sequences before opening a read', async () => {
    const { handle } = await fixture();
    for (const selection of [null, [], { artifactIds: Array(1) }, { sessions: Array(1) }])
      expect(() => readProjectUsageAccounting(handle, selection as never)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' })
      );
    for (const expectedWriteSequence of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => discoverProjectUsageSessions(handle, { expectedWriteSequence })).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' })
      );
    expect(() =>
      readProjectUsageAccounting(handle, { sessions: [{ agent: '', sessionId: 'session' }] })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('includes a shared session high-water from a project with no local selected artifact association', async () => {
    const first = await fixture();
    const second = await fixture();
    await append(first.handle, [observation(10)]);
    await append(second.handle, [
      observation(20, { artifact_id: 'elsewhere' }),
      observation(50, { session_id: 'unrelated', artifact_id: 'elsewhere' }),
    ]);
    const result = aggregateProjectUsage([first.handle, second.handle], {
      artifactIds: ['artifact'],
    });
    expect(result).toMatchObject({ status: 'exact', totals: counters(20) });
    expect(result.sessions).toHaveLength(1);
    expect(
      readProjectUsageAccounting(second.handle, { artifactIds: ['artifact'] }).events
    ).toHaveLength(0);
  });
  it('deduplicates mirrored original sidecar observations across typed and original accounting inputs', async () => {
    const a = await fixture();
    const b = await fixture();
    const original = observation(15);
    if (!('payload' in original)) throw new Error('Fixture must start inline');
    const bytes = Buffer.from(' ' + JSON.stringify(original.payload) + '\n');
    const { payload: _payload, checksum: _checksum, ...envelope } = original;
    const unsigned = { ...envelope, sidecar_sha256: digest(bytes), sidecar_size: bytes.length };
    const record = { ...unsigned, checksum: recordChecksum(unsigned) };
    for (const { handle } of [a, b])
      await appendProjectUsageEvents(handle, {
        operationId: uuidv7(),
        expectedRevision: null,
        eventBytes: Buffer.from(JSON.stringify(record) + '\n'),
        sidecarPayloads: [{ eventId: record.event_id, bytes }],
        secretAllow: [],
      });
    const typed = readProjectUsageAccounting(a.handle);
    const historical = readProjectUsage(b.handle)!;
    expect(aggregateCanonicalUsage([typed, historical])).toMatchObject({
      status: 'exact',
      totals: counters(15),
    });
    expect(aggregateProjectUsage([a.handle, b.handle]).sessions).toHaveLength(1);
  });
  it('retains sparse high-water dimensions and flags resets and disappearing dimensions', async () => {
    const { handle } = await fixture();
    const rich = { ...counters(10), dimensions: { reasoning: 4 } };
    await append(handle, [
      observation(10, {
        cumulative_usage: rich,
        model_breakdown: [{ model: 'model', cumulative: rich, delta: null }],
      }),
      observation(20),
    ]);
    expect(aggregateProjectUsage([handle])).toMatchObject({
      status: 'partial',
      totals: null,
      sessions: [{ status: 'incomplete', observed_high_water: counters(20) }],
    });
    expect(aggregateProjectUsage([handle]).sessions[0].reasons).toContain(
      'incomplete session dimensions history'
    );
    await append(handle, [observation(5, { as_of: '2026-09-05T01:00:00.000Z' })]);
    expect(aggregateProjectUsage([handle]).sessions[0].reasons).toContain(
      'incompatible cumulative counter reset'
    );
  });
  it('detects divergent source identities after typed row normalization', async () => {
    const a = await fixture();
    const b = await fixture();
    const first = observation(10);
    if (!('payload' in first)) throw new Error('Fixture must be inline');
    const snapshotId = (first.payload as AgentUsageSnapshotPayload).snapshot_id;
    await append(a.handle, [first]);
    await append(b.handle, [observation(20, { snapshot_id: snapshotId })]);
    const result = aggregateProjectUsage([a.handle, b.handle]);
    expect(result.status).toBe('partial');
    expect(result.sessions[0].reasons).toContain('divergent duplicate source identity');
  });
  it('uses time-bounded source-plan links to choose sessions without making links adoption', async () => {
    const { handle } = await fixture();
    const source = observation(10, { artifact_id: null, source_plan_ref_id: 'plan' });
    const future = observation(30, {
      artifact_id: null,
      source_plan_ref_id: 'plan',
      session_id: 'future',
    });
    const linked = deriveUsageLedgerRecord({
      type: 'source_plan_linked',
      ts: '2026-09-05T00:20:00.000Z',
      idempotency_key: uuidv7(),
      payload: {
        canonical_ref_id: 'plan',
        artifact_id: 'selected',
        linked_at: '2026-09-05T00:20:00.000Z',
        pinned_version: '2',
      },
    }).record;
    await append(handle, [source, future, linked]);
    await append(handle, [observation(40, { artifact_id: 'elsewhere' })]);
    expect(aggregateProjectUsage([handle], { artifactIds: ['selected'] })).toMatchObject({
      status: 'exact',
      totals: counters(40),
    });
    expect(readProjectUsageAccounting(handle).counters.intentChangeCounter).toBe(0);
  });
  it('keeps checkpoint and artifact estimates distinct from cumulative exact totals', async () => {
    const { handle } = await fixture();
    await append(handle, [
      observation(10),
      observation(20, { baseline_kind: 'checkpoint_open', delta_usage: counters(10) }),
      observation(30, { baseline_kind: 'checkpoint_open', delta_usage: counters(20) }),
    ]);
    const input = readProjectUsageAccounting(handle, { artifactIds: ['artifact'] });
    expect(estimateProjectArtifactUsage(input, 'artifact')).toMatchObject({
      kind: 'estimate',
      totals: counters(20),
      checkpoints: [{ checkpoint_n: 1, deltas: counters(20) }],
    });
    expect(aggregateProjectUsage([handle]).totals).toEqual(counters(30));
  });
  it('does not decode unrelated typed payloads or exact journal bytes for selected accounting', async () => {
    const { handle, authority } = await fixture();
    await append(handle, [
      observation(10),
      observation(50, { artifact_id: 'unrelated', session_id: 'other' }),
    ]);
    const db = new Database(projectDatabasePath(authority));
    try {
      db.prepare(
        "UPDATE usage_snapshots SET cumulative_json = '{}' WHERE session_id = 'other'"
      ).run();
      expect(aggregateProjectUsage([handle], { artifactIds: ['artifact'] })).toMatchObject({
        status: 'exact',
        totals: counters(10),
      });
      expect(() => aggregateProjectUsage([handle])).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      const plan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT event_id FROM usage_snapshots WHERE (agent, session_id) IN (VALUES (?, ?))'
        )
        .all('codex', 'session');
      expect(JSON.stringify(plan)).toContain('usage_session_lookup');
    } finally {
      db.close();
    }
  });
  it('materializes only the selected session observations in a seeded project', async () => {
    const { handle } = await fixture();
    const records = Array.from({ length: 1000 }, (_, index) =>
      observation(index + 1, {
        artifact_id: `artifact-${index % 50}`,
        session_id: `session-${index % 50}`,
        as_of: new Date(Date.UTC(2026, 8, 5) + index * 1000).toISOString(),
      })
    );
    await append(handle, records);
    const measure = (selection: { artifactIds?: string[] }) => {
      const times: number[] = [];
      for (let n = 0; n < 6; n++) {
        const start = performance.now();
        aggregateProjectUsage([handle], selection);
        times.push(performance.now() - start);
      }
      const sorted = times.slice(1).sort((a, b) => a - b);
      return { firstOpenMs: times[0], warmP50Ms: sorted[2] };
    };
    expect(readProjectUsageAccounting(handle, { artifactIds: ['artifact-1'] }).events).toHaveLength(
      20
    );
    expect(readProjectUsageAccounting(handle).events).toHaveLength(1000);
    const measurement = {
      observations: 1000,
      sessions: 50,
      selectedObservations: 20,
      bytes: Buffer.byteLength(records.map((record) => JSON.stringify(record)).join('\n')),
      unscoped: measure({}),
      selected: measure({ artifactIds: ['artifact-1'] }),
    };
    if (process.env.USAGE_ACCOUNTING_MEASUREMENT_PATH)
      await writeFile(
        process.env.USAGE_ACCOUNTING_MEASUREMENT_PATH,
        JSON.stringify(measurement, null, 2)
      );
  });
  it('refuses a missing publication selection while retaining exact and accounting history', async () => {
    const { handle, authority } = await fixture();
    await append(handle, [observation(10)]);
    const db = new Database(projectDatabasePath(authority));
    const countersBefore = db.prepare('SELECT * FROM project_counters').all();
    const eventsBefore = db.prepare('SELECT * FROM usage_events').all();
    const trigger = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'usage_selection_no_delete'")
      .get() as { sql: string };
    try {
      db.exec('DROP TRIGGER usage_selection_no_delete; DELETE FROM usage_selection');
      db.exec(trigger.sql);
      for (const read of [
        () => readProjectUsage(handle),
        () => readProjectUsageAccounting(handle),
        () => aggregateProjectUsage([handle], { artifactIds: ['artifact'] }),
        () => aggregateProjectUsage([handle]),
      ])
        expect(read).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
      expect(db.prepare('SELECT * FROM usage_events').all()).toEqual(eventsBefore);
      expect(db.prepare('SELECT * FROM project_counters').all()).toEqual(countersBefore);
      db.prepare('INSERT INTO usage_selection VALUES (1, 1)').run();
      expect(aggregateProjectUsage([handle])).toMatchObject({
        status: 'exact',
        totals: counters(10),
      });
    } finally {
      db.close();
    }
  });
  it.each(['snapshot', 'link'] as const)(
    'refuses a missing derived %s row while preserving original history',
    async (kind) => {
      const { handle, authority } = await fixture();
      const source = observation(10, { artifact_id: null, source_plan_ref_id: 'source-plan' });
      const linked = deriveUsageLedgerRecord({
        type: 'source_plan_linked',
        ts: '2026-09-05T00:20:00.000Z',
        idempotency_key: uuidv7(),
        payload: {
          canonical_ref_id: 'source-plan',
          artifact_id: 'selected',
          linked_at: '2026-09-05T00:20:00.000Z',
          pinned_version: null,
        },
      }).record;
      await append(handle, [source, linked]);
      const before = readProjectUsage(handle)!;
      const db = new Database(projectDatabasePath(authority));
      const table = kind === 'snapshot' ? 'usage_snapshots' : 'usage_links';
      const retained = db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>;
      try {
        db.prepare(`DELETE FROM ${table}`).run();
        expect(readProjectUsage(handle)).toEqual(before);
        for (const read of [
          () => readProjectUsageAccounting(handle),
          () => aggregateProjectUsage([handle]),
          () => aggregateProjectUsage([handle], { artifactIds: ['selected'] }),
        ])
          expect(read).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
        await expect(append(handle, [observation(20)])).rejects.toMatchObject({
          code: 'HISTORY_INTEGRITY_REQUIRED',
        });
        expect(readProjectUsage(handle)).toEqual(before);
        db.prepare(
          `INSERT INTO ${table} (${Object.keys(retained).join(',')}) VALUES (${Object.keys(retained)
            .map(() => '?')
            .join(',')})`
        ).run(...Object.values(retained));
        expect(aggregateProjectUsage([handle], { artifactIds: ['selected'] })).toMatchObject({
          status: 'exact',
          totals: counters(10),
        });
        const plan = db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT event_id FROM usage_events WHERE event_type = 'agent_usage_snapshot_recorded'"
          )
          .all();
        expect(JSON.stringify(plan)).toContain('usage_event_type_lookup');
      } finally {
        db.close();
      }
    }
  );
  it('reports absent scope as unavailable and rejects malformed selections', async () => {
    const { handle } = await fixture();
    expect(aggregateProjectUsage([handle])).toMatchObject({ status: 'unavailable', totals: null });
    await append(handle, [observation(10)]);
    expect(aggregateProjectUsage([handle], { artifactIds: [] }).status).toBe('unavailable');
    expect(() => readProjectUsageAccounting(handle, { artifactIds: [''] })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });
});
