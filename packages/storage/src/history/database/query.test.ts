import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

import { initializeCapturedExecution } from '../execution.js';
import { decodeArtifactInput, reconstructDatabaseArtifact } from './artifact-events.js';
import type { ProjectReadView } from './connection.js';
import { registerQueryFunctions } from './query-functions.js';
import {
  prepareArtifactQueryMetadata,
  prepareExecutionQueryMetadata,
  replaceArtifactQueryMetadata,
  replaceExecutionQueryMetadata,
} from './query-metadata-records.js';
import { selectProjectArtifactRows } from './query.js';
import { PROJECT_DATABASE_SCHEMA } from './schema.js';

const saved = JSON.parse(
  readFileSync(new URL('./fixtures/artifact-history.json', import.meta.url), 'utf8')
) as { rows: Record<string, Record<string, unknown>[]> };
const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const blob = (value: unknown) => Buffer.from((value as { blobHex: string }).blobHex, 'hex');
it.each([' ', '\t', ' \t '])(
  'rejects a whitespace-only touching filter %j before querying',
  (touching) => {
    const view: ProjectReadView = {
      get() {
        throw new Error('Unexpected database read');
      },
      all() {
        throw new Error('Unexpected database read');
      },
    };
    expect(() => selectProjectArtifactRows(view, { touching })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  }
);
async function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  registerQueryFunctions(db);
  db.exec(PROJECT_DATABASE_SCHEMA);
  const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as {
    name: string;
    sql: string;
  }[];
  for (const t of triggers) db.exec('DROP TRIGGER ' + t.name);
  db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
  for (const [table, rows] of Object.entries(saved.rows))
    for (const row of rows) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      ).run(
        ...Object.values(row).map((v) =>
          v && typeof v === 'object' && 'blobHex' in v ? blob(v) : v
        )
      );
    }
  db.exec('COMMIT');
  for (const t of triggers) db.exec(t.sql);
  const tx = {
    run(sql: string, ...params: unknown[]) {
      return db.prepare(sql).run(...params);
    },
  };
  const ids = saved.rows.artifacts.map((row) => row.artifact_id as string);
  for (const id of ids) {
    const rows = saved.rows.artifact_events.filter((row) => row.artifact_id === id);
    const input = decodeArtifactInput(
      Buffer.concat(rows.map((r) => blob(r.record_bytes))),
      rows.flatMap((r) =>
        r.sidecar_payload_bytes
          ? [{ eventId: r.event_id as string, bytes: blob(r.sidecar_payload_bytes) }]
          : []
      ),
      [],
      false
    );
    const thread = reconstructDatabaseArtifact(id, input, true);
    const original = saved.rows.artifacts.find((row) => row.artifact_id === id)!;
    const prepared = await prepareArtifactQueryMetadata(
      thread,
      original.current_generation as number
    );
    replaceArtifactQueryMetadata(tx, prepared);
    const transition = saved.rows.execution_transitions.find((row) => row.artifact_id === id);
    if (transition) {
      const value = JSON.parse(blob(transition.record_bytes).toString());
      const state = initializeCapturedExecution({
        artifactId: id,
        operationId: value.operation_id,
        context: value.binding,
        ts: value.ts,
      });
      const preparedExecution = prepareExecutionQueryMetadata(state, 1);
      replaceExecutionQueryMetadata(tx, preparedExecution);
    }
  }
  const view: ProjectReadView = {
    get<T>(sql: string, ...params: unknown[]) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all<T>(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
  return { db, view, ids };
}

it('orders equal instants by exact artifact identity before applying offsets and limits', async () => {
  const { db, view, ids } = await fixture();
  db.prepare('UPDATE artifact_metadata SET started_at=? WHERE artifact_id=?').run(
    '2026-09-01T12:00:00.000+02:00',
    ids[0]
  );
  db.prepare('UPDATE artifact_metadata SET started_at=? WHERE artifact_id=?').run(
    '2026-09-01T10:00:00.000Z',
    ids[1]
  );
  const result = selectProjectArtifactRows(view, { profile: 'versions', limit: 1, offset: 1 });
  expect(result.rows.map((r) => r.artifactId)).toEqual([...ids].sort().slice(1));
  expect(result.counts.captured + result.counts.imported).toBe(2);
  expect(result.rows[0].startedMs).toBe(Date.parse('2026-09-01T10:00:00Z'));
  expect(result.rows[0]).toMatchObject({
    label: null,
    task: null,
    watchJson: null,
    detailsJson: null,
    provenanceJson: null,
    executionJson: null,
    planStepCount: expect.any(Number),
    completedPlanStepCount: expect.any(Number),
  });
  expect(selectProjectArtifactRows(view, { limit: 1001 }).rows).toHaveLength(2);
});

it('filters complete artifact and handoff branch membership and project-relative globs', async () => {
  const { db, view, ids } = await fixture();
  const executionId = saved.rows.execution_initializations[0].artifact_id as string;
  db.prepare('INSERT INTO execution_query_branches VALUES (?,?)').run(executionId, 'handoff-only');
  db.prepare(
    'UPDATE execution_query_metadata SET branch_count=branch_count+1 WHERE artifact_id=?'
  ).run(executionId);
  db.prepare('INSERT INTO artifact_touched_files VALUES (?,?)').run(
    executionId,
    'src/nested/file.ts'
  );
  db.prepare(
    'UPDATE artifact_query_metadata SET touched_file_count=touched_file_count+1 WHERE artifact_id=?'
  ).run(executionId);
  expect(
    selectProjectArtifactRows(view, { branch: 'handoff-only', touching: 'src/**/*.ts' }).rows.map(
      (r) => r.artifactId
    )
  ).toEqual([executionId]);
  expect(selectProjectArtifactRows(view, { touching: 'src/*.ts' }).rows).toEqual([]);
  expect(() => selectProjectArtifactRows(view, { touching: '../**' })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(selectProjectArtifactRows(view, { artifactIds: [] }).rows).toEqual([]);
  expect(
    selectProjectArtifactRows(view, { artifactIds: [ids[0]] }).rows.map((r) => r.artifactId)
  ).toEqual([ids[0]]);
});

it('refuses missing indexed membership and original revisions before a filter can hide them', async () => {
  const { db, view, ids } = await fixture();
  db.prepare('DELETE FROM artifact_branches WHERE artifact_id=?').run(ids[0]);
  expect(() => selectProjectArtifactRows(view, { branch: 'no-match', limit: 1 })).toThrow(
    expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
  );
  expect(() => selectProjectArtifactRows(view, { artifactIds: [ids[1]] })).not.toThrow();
  db.exec('DROP TRIGGER artifact_revisions_no_delete');
  db.pragma('foreign_keys=OFF');
  db.prepare('DELETE FROM artifact_revisions WHERE artifact_id=?').run(ids[1]);
  expect(() =>
    selectProjectArtifactRows(view, { artifactIds: [ids[1]], branch: 'no-match' })
  ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
});

it('selects bounded Watch values without original event bodies or complete details', async () => {
  const { view } = await fixture();
  const statements: string[] = [];
  const observed: ProjectReadView = {
    get<T>(sql: string, ...params: unknown[]) {
      statements.push(sql);
      return view.get<T>(sql, ...params);
    },
    all<T>(sql: string, ...params: unknown[]) {
      statements.push(sql);
      return view.all<T>(sql, ...params);
    },
  };
  const rows = selectProjectArtifactRows(observed, { profile: 'watch' }).rows;
  expect(rows).toHaveLength(2);
  expect(
    rows.every((r) => r.watchJson !== null && r.detailsJson === null && r.executionJson === null)
  ).toBe(true);
  // The completeness check may read one finite scalar from details_json; the
  // Watch profile must never hydrate or filter on the bodies themselves.
  const bodies = statements
    .join('\n')
    .replaceAll("json_extract(q.details_json,'$.historicalStepCount')", '');
  expect(bodies).not.toMatch(
    /record_bytes|sidecar_payload_bytes|state_json|details_json|provenance_json|SELECT\s+\*/iu
  );
  expect(rows.some((r) => r.bindingUpdatedAt !== null)).toBe(true);
});

it('preserves worktree uncertainty and time-window counts independently from the page', async () => {
  const { db, view, ids } = await fixture();
  const worktree = saved.rows.execution_associations[0].worktree_id as string;
  db.prepare('UPDATE artifact_metadata SET started_at=?,completed_at=?').run(
    '2026-09-01T00:00:00Z',
    null
  );
  const result = selectProjectArtifactRows(view, {
    worktreeId: worktree,
    sinceMs: Date.parse('2026-09-01'),
    untilMs: Date.parse('2026-09-02'),
    activeSinceMs: Date.parse('2026-06-01'),
    limit: 1,
  });
  expect(result.rows).toHaveLength(1);
  expect(result.unknownAssociations).toBe(1);
  expect(result.counts.captured + result.counts.imported).toBe(1);
  expect(selectProjectArtifactRows(view, { sinceMs: Date.parse('2026-09-02') }).rows).toEqual([]);
  expect(() => selectProjectArtifactRows(view, { sinceMs: 2, untilMs: 1 })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(() => selectProjectArtifactRows(view, { offset: -1 })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' })
  );
  expect(ids).toHaveLength(2);
});

it('does not turn unknown artifact lifetime bounds into activity in an unrelated window', async () => {
  const { db, view } = await fixture();
  db.prepare('UPDATE artifact_metadata SET started_at=?,completed_at=?').run('unknown', 'unknown');
  const active = selectProjectArtifactRows(view, { activeSinceMs: 1, activeUntilMs: 2 });
  expect(active.rows).toEqual([]);
  expect(selectProjectArtifactRows(view, { sinceMs: 1, untilMs: 2 }).rows).toEqual([]);
});

it.each(['artifact_events', 'artifact_revisions'])(
  'refuses a missing header with retained %s before filtering or pagination',
  async (retained) => {
    const { db, view, ids } = await fixture();
    const triggers = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")
      .all() as {
      name: string;
      sql: string;
    }[];
    db.pragma('foreign_keys=OFF');
    for (const trigger of triggers) db.exec('DROP TRIGGER ' + trigger.name);
    db.prepare('DELETE FROM artifacts WHERE artifact_id=?').run(ids[0]);
    const other = retained === 'artifact_events' ? 'artifact_revisions' : 'artifact_events';
    db.prepare(`DELETE FROM ${other} WHERE artifact_id=?`).run(ids[0]);
    for (const trigger of triggers) db.exec(trigger.sql);
    expect(() => selectProjectArtifactRows(view, { branch: 'no-match', limit: 1 })).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(() => selectProjectArtifactRows(view, { artifactIds: [ids[0]], limit: 1 })).toThrow(
      expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
    );
    expect(() => selectProjectArtifactRows(view, { artifactIds: [ids[1]] })).not.toThrow();
    expect(selectProjectArtifactRows(view, { artifactIds: [] }).rows).toEqual([]);
  }
);

it('selects current binding and progress scalars without full detail or execution JSON', async () => {
  const { db, view } = await fixture();
  const executionId = saved.rows.execution_initializations[0].artifact_id as string;
  const expected = db
    .prepare(
      `SELECT e.binding_branch AS bindingBranch,
    e.binding_updated_at AS bindingUpdatedAt,q.plan_step_count AS planStepCount,
    q.completed_plan_step_count AS completedPlanStepCount
    FROM execution_query_metadata e JOIN artifact_query_metadata q USING(artifact_id)
    WHERE e.artifact_id=?`
    )
    .get(executionId);
  const result = selectProjectArtifactRows(view, { artifactIds: [executionId], profile: 'watch' });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    ...(expected as Record<string, unknown>),
    detailsJson: null,
    provenanceJson: null,
    executionJson: null,
    watchJson: expect.any(String),
  });
});

it('selects details and provenance together for provenance reads', async () => {
  const { view, ids } = await fixture();
  const result = selectProjectArtifactRows(view, { artifactIds: [ids[0]], profile: 'provenance' });
  expect(result.rows).toEqual([
    expect.objectContaining({
      detailsJson: expect.any(String),
      provenanceJson: expect.any(String),
      executionJson: null,
      watchJson: null,
    }),
  ]);
});

it('excludes dormant gaps before limiting activity matches', async () => {
  const { db, view, ids } = await fixture();
  const startedAt = '2026-09-01T00:00:00.000Z';
  const completedAt = '2026-09-10T00:00:00.000Z';
  db.prepare('UPDATE artifact_metadata SET started_at=?,completed_at=?').run(
    startedAt,
    completedAt
  );
  for (const [index, id] of ids.entries()) {
    const row = db
      .prepare('SELECT details_json FROM artifact_query_metadata WHERE artifact_id=?')
      .get(id) as { details_json: string };
    const details = JSON.parse(row.details_json);
    details.activity = {
      startedAt,
      summaryAt: completedAt,
      checkpoints: [
        {
          openedAt: index === 0 ? '2026-09-02T00:00:00.000Z' : '2026-09-04T00:00:00.000Z',
          endedAt: index === 0 ? '2026-09-03T00:00:00.000Z' : null,
        },
      ],
    };
    db.prepare('UPDATE artifact_query_metadata SET details_json=? WHERE artifact_id=?').run(
      JSON.stringify(details),
      id
    );
  }
  const result = selectProjectArtifactRows(view, {
    activeSinceMs: Date.parse('2026-09-05'),
    activeUntilMs: Date.parse('2026-09-06'),
    limit: 1,
  });
  expect(result.counts.captured + result.counts.imported).toBe(1);
  expect(result.rows.map((row) => row.artifactId)).toEqual([ids[1]]);
});

it('refuses missing activity metadata before a filter can hide the row', async () => {
  const { db, view } = await fixture();
  db.prepare(
    "UPDATE artifact_query_metadata SET details_json=json_remove(details_json,'$.activity')"
  ).run();
  expect(() =>
    selectProjectArtifactRows(view, { branch: 'not-matching', activeSinceMs: 1, limit: 1 })
  ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
});

it.each([
  null,
  'invalid member',
  42,
  [],
  {},
  { openedAt: 42, endedAt: null },
  { openedAt: '2026-01-01T00:00:00.000Z', endedAt: 42 },
])('refuses malformed activity members before unrelated filters: %j', async (member) => {
  const { db, view, ids } = await fixture();
  db.prepare(
    "UPDATE artifact_query_metadata SET details_json=json_set(details_json,'$.activity.checkpoints',json(?)) WHERE artifact_id=?"
  ).run(JSON.stringify([member]), ids[0]);
  const before = db
    .prepare('SELECT details_json FROM artifact_query_metadata ORDER BY artifact_id')
    .all();
  expect(() =>
    selectProjectArtifactRows(view, { branch: 'not-matching', activeSinceMs: 1, limit: 1 })
  ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
  expect(
    db.prepare('SELECT details_json FROM artifact_query_metadata ORDER BY artifact_id').all()
  ).toEqual(before);
  expect(() =>
    selectProjectArtifactRows(view, { artifactIds: [ids[1]], activeSinceMs: 1 })
  ).not.toThrow();
});
