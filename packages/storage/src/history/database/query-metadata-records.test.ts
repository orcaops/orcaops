import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

import { uuidv7 } from '../../ids/uuidv7.js';
import { initializeCapturedExecution, prepareExecutionTransition } from '../execution.js';
import { decodeArtifactInput, reconstructDatabaseArtifact } from './artifact-events.js';
import type { ProjectReadView } from './connection.js';
import {
  assertQueryMetadataComplete,
  prepareArtifactQueryMetadata,
  prepareExecutionQueryMetadata,
  replaceArtifactQueryMetadata,
  replaceExecutionQueryMetadata,
} from './query-metadata-records.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
const saved = JSON.parse(
  readFileSync(new URL('./fixtures/artifact-history.json', import.meta.url), 'utf8')
) as { rows: Record<string, Record<string, unknown>[]> };
const artifactId = saved.rows.execution_initializations[0].artifact_id as string;
const original = saved.rows.artifact_events.filter((row) => row.artifact_id === artifactId);
const blob = (value: unknown) => Buffer.from((value as { blobHex: string }).blobHex, 'hex');
function thread() {
  const bytes = Buffer.concat(original.map((row) => blob(row.record_bytes)));
  const sidecars = original.flatMap((row) =>
    row.sidecar_payload_bytes
      ? [{ eventId: row.event_id as string, bytes: blob(row.sidecar_payload_bytes) }]
      : []
  );
  return reconstructDatabaseArtifact(
    artifactId,
    decodeArtifactInput(bytes, sidecars, [], false),
    true
  );
}
function execution() {
  const transition = JSON.parse(blob(saved.rows.execution_transitions[0].record_bytes).toString());
  return initializeCapturedExecution({
    artifactId,
    operationId: transition.operation_id,
    context: transition.binding,
    ts: transition.ts,
  });
}
async function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  db.exec(PROJECT_DATABASE_SCHEMA);
  const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger'").all() as {
    name: string;
    sql: string;
  }[];
  // Restore settled fixture rows before enabling rules for an original publication.
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
  for (const [table, rows] of Object.entries(saved.rows))
    for (const row of rows) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      ).run(
        ...Object.values(row).map((value) =>
          value && typeof value === 'object' && 'blobHex' in value ? blob(value) : value
        )
      );
    }
  db.exec('COMMIT');
  for (const trigger of triggers) db.exec(trigger.sql);
  const view: ProjectReadView = {
    get<T>(sql: string, ...parameters: unknown[]) {
      return (db.prepare(sql).get(...parameters) as T | undefined) ?? null;
    },
    all<T>(sql: string, ...parameters: unknown[]) {
      return db.prepare(sql).all(...parameters) as T[];
    },
  };
  const transaction = {
    run(sql: string, ...parameters: unknown[]) {
      return db.prepare(sql).run(...parameters);
    },
  };
  const artifact = await prepareArtifactQueryMetadata(thread(), 1);
  replaceArtifactQueryMetadata(transaction, artifact);
  replaceExecutionQueryMetadata(transaction, prepareExecutionQueryMetadata(execution(), 1));
  return { db, view, transaction, artifact };
}

it('keeps bounded display separate from complete retained details', async () => {
  const source = thread();
  const row = await prepareArtifactQueryMetadata(source, 1);
  const watch = JSON.parse(row.watchJson);
  const details = JSON.parse(row.detailsJson);
  expect(watch.events).toEqual(
    source.events.map(({ record }) => ({ ts: record.ts, type: record.type }))
  );
  expect(details).not.toHaveProperty('watch');
  expect(details).not.toHaveProperty('execution');
  expect(details.planStepIds).toEqual(source.plan!.plan_steps.map((step) => step.step_id));
  expect(JSON.parse(row.provenanceJson)).toMatchObject({ omitted: false, unavailable: false });
  source.plan!.task = 'Later caller mutation';
  expect(JSON.parse(row.detailsJson).task).not.toBe(source.plan!.task);
});

it('bounds Watch event copies while retaining the omitted count', async () => {
  const source = thread();
  const event = source.events[0];
  source.events = Array.from({ length: 300 }, () => structuredClone(event));
  const row = await prepareArtifactQueryMetadata(source, 1);
  const watch = JSON.parse(row.watchJson);
  expect(watch.events).toHaveLength(256);
  expect(watch.omittedEvents).toBe(44);
  expect(source.events).toHaveLength(300);
});

it.each([
  'DELETE FROM artifact_metadata WHERE artifact_id=?',
  'DELETE FROM artifact_query_metadata WHERE artifact_id=?',
  'DELETE FROM artifact_branches WHERE artifact_id=?',
  'UPDATE artifact_query_metadata SET compiler_version=999 WHERE artifact_id=?',
  'UPDATE artifact_query_metadata SET touched_file_count=touched_file_count+1 WHERE artifact_id=?',
  'DELETE FROM execution_query_metadata WHERE artifact_id=?',
  'DELETE FROM execution_query_branches WHERE artifact_id=?',
  'UPDATE execution_query_metadata SET version=version+1 WHERE artifact_id=?',
])('rejects incomplete metadata before derived filtering: %s', async (sql) => {
  const { db, view } = await fixture();
  expect(() => assertQueryMetadataComplete(view, { artifactIds: [artifactId] })).not.toThrow();
  db.prepare(sql).run(artifactId);
  expect(() => assertQueryMetadataComplete(view, { artifactIds: [artifactId] })).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  const retained = db
    .prepare('SELECT record_bytes FROM artifact_events WHERE artifact_id=? ORDER BY ordinal')
    .all(artifactId) as { record_bytes: Buffer }[];
  expect(retained.map((row) => row.record_bytes)).toEqual(
    original.map((row) => blob(row.record_bytes))
  );
  expect(() => assertQueryMetadataComplete(view, { artifactIds: [] })).not.toThrow();
});

it('keeps execution branch history when artifact metadata is replaced', async () => {
  const { db, view, transaction, artifact } = await fixture();
  const state = execution();
  const moved = prepareExecutionTransition({
    state,
    operationId: uuidv7(),
    expectedGeneration: state.binding_generation,
    expectedBinding: state.current_binding,
    action: 'handoff',
    target: {
      ...state.current_binding!,
      worktree_id: uuidv7(),
      git_context: { head_sha: null, branch: 'other' },
    },
    openCheckpointIds: [],
    ts: '2026-09-01T00:00:00.000Z',
  }).executionState;
  const prepared = prepareExecutionQueryMetadata(moved, 2);
  expect(prepared.branches).toEqual(['other', state.current_binding!.git_context.branch].sort());
  replaceExecutionQueryMetadata(transaction, prepared);
  replaceArtifactQueryMetadata(transaction, artifact);
  expect(db.prepare('SELECT branch FROM execution_query_branches ORDER BY branch').all()).toEqual(
    prepared.branches.map((branch) => ({ branch }))
  );
  expect(() => assertQueryMetadataComplete(view, { artifactIds: [artifactId] })).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
});

it('rebuilds derived rows without changing original records or counters', async () => {
  const { db, view, transaction, artifact } = await fixture();
  const before = Object.fromEntries(
    Object.keys(saved.rows).map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])
  );
  db.prepare('DELETE FROM artifact_query_metadata WHERE artifact_id=?').run(artifactId);
  db.prepare('DELETE FROM execution_query_branches WHERE artifact_id=?').run(artifactId);
  replaceArtifactQueryMetadata(transaction, artifact);
  replaceExecutionQueryMetadata(transaction, prepareExecutionQueryMetadata(execution(), 1));
  expect(() => assertQueryMetadataComplete(view, { artifactIds: [artifactId] })).not.toThrow();
  for (const [table, rows] of Object.entries(before))
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
});

it('binds metadata to an existing exact revision of its artifact', async () => {
  const { db } = await fixture();
  expect(() =>
    db
      .prepare('UPDATE artifact_query_metadata SET generation=2 WHERE artifact_id=?')
      .run(artifactId)
  ).toThrow('FOREIGN KEY constraint failed');
});

it('detaches artifact identity and nested inputs before asynchronous preparation', async () => {
  const source = thread();
  const original = structuredClone(source);
  const pending = prepareArtifactQueryMetadata(source, 1);
  source.artifactId = uuidv7();
  source.plan!.task = 'Changed while preparation yields';
  source.artifactJson!.branch_lineage.length = 0;
  source.events.length = 0;
  source.checkpoints.length = 0;
  expect(await pending).toEqual(await prepareArtifactQueryMetadata(original, 1));
});

it.each(['current', 'transitions', 'associations'] as const)(
  'refuses missing initialization while original execution %s remains',
  async (retained) => {
    const { db, view } = await fixture();
    const triggers = db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name LIKE 'execution_%'"
      )
      .all() as { name: string; sql: string }[];
    db.pragma('foreign_keys=OFF');
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare('DELETE FROM execution_initializations WHERE artifact_id=?').run(artifactId);
    for (const table of ['current', 'transitions', 'associations'])
      if (table !== retained)
        db.prepare(`DELETE FROM execution_${table} WHERE artifact_id=?`).run(artifactId);
    for (const trigger of triggers) db.exec(trigger.sql);
    db.pragma('foreign_keys=ON');
    const before = db.prepare('SELECT * FROM project_counters').all();
    expect(
      db
        .prepare(`SELECT count(*) AS count FROM execution_${retained} WHERE artifact_id=?`)
        .get(artifactId)
    ).toMatchObject({ count: 1 });
    expect(() => assertQueryMetadataComplete(view, { artifactIds: [artifactId] })).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(db.prepare('SELECT * FROM project_counters').all()).toEqual(before);
  }
);

it('counts only distinct completed steps in the latest plan', async () => {
  const source = thread();
  const step = source.plan!.plan_steps[0].step_id;
  const retiredStep = uuidv7();
  const checkpoint = {
    artifact_id: artifactId,
    n: 1,
    status: 'closed',
    head_sha: 'a'.repeat(40),
    completed_step_ids: [step, step, retiredStep],
    files_changed: [],
    diff_fingerprint_summary: { status: 'skipped' },
    source_event_ids: { opened: uuidv7(), closed: uuidv7() },
    summary: 'Completed one retained step',
    uncertainty: [],
    decisions: [],
    opened_at: '2026-06-02T00:00:00.000Z',
    closed_at: '2026-06-03T00:00:00.000Z',
  } as unknown as (typeof source.checkpoints)[number];
  source.checkpoints = [checkpoint, { ...checkpoint, n: 2 }];
  const row = await prepareArtifactQueryMetadata(source, 1);
  expect(row.planStepCount).toBe(source.plan!.plan_steps.length);
  expect(row.completedPlanStepCount).toBe(1);
});
it('retains the last binding timestamp when execution becomes unbound', () => {
  const state = execution();
  const last = state.binding_history.at(-1)!;
  const unbound = prepareExecutionTransition({
    state,
    operationId: uuidv7(),
    expectedGeneration: state.binding_generation,
    expectedBinding: state.current_binding,
    action: 'completed',
    openCheckpointIds: [],
    reason: 'completed',
    ts: '2026-06-03T00:00:00.000Z',
  });
  const row = prepareExecutionQueryMetadata(unbound.executionState, 2);
  expect(row.bindingBranch).toBeNull();
  expect(row.bindingUpdatedAt).toBe('2026-06-03T00:00:00.000Z');
  expect(row.branches).toContain(last.binding!.git_context.branch);
});
