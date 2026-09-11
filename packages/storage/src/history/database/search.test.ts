import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventType } from '../../events/event-log.js';
import { uuidv7 } from '../../ids/uuidv7.js';
import { digest, recordChecksum } from '../event-integrity.js';
import { normalizeHistoryRoot } from '../paths.js';
import {
  appendProjectArtifactEvents,
  type AppendProjectArtifactEvents,
  readProjectArtifact,
} from './artifacts.js';
import {
  initializeProjectDatabase,
  openProjectDatabase,
  type ProjectDatabase,
  projectDatabasePath,
} from './connection.js';
import { appendProjectExecutionCapture } from './execution-capture.js';
import { queryProjectSearch } from './search.js';
const roots: string[] = [];
const handles: ProjectDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  handles.splice(0).forEach((handle) => handle.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await normalizeHistoryRoot({
    root: await mkdtemp(path.join(tmpdir(), 'database-artifacts-')),
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
function plan(artifactId: string, branch = 'topic', startedAt = '2026-06-01T00:00:00.000Z') {
  return {
    schema_version: 4,
    artifact_id: artifactId,
    branch,
    base_sha: 'original-base',
    agent: 'codex',
    agent_session_id: null,
    task: 'Retain original bytes',
    label: 'Original plan',
    plan_steps: [
      {
        step_id: uuidv7(),
        text: 'Keep identities',
        label: 'Keep identities',
        acceptance_criteria: [],
      },
    ],
    touched_scope: [],
    non_goals: [],
    decisions: [],
    started_at: startedAt,
    revision_n: 0,
    revised_at: null,
    rationale: null,
    step_lineage: { added: [], dropped: [], unchanged: [], rewritten: [] },
    criterion_lineage: { added: [], carried: [], removed: [], rewritten: [] },
    prior_plan_event_id: null,
  };
}
function event(type: EventType, payload: unknown, sidecar = false) {
  const payloadBytes = Buffer.from(JSON.stringify(payload));
  const record = {
    event_id: uuidv7(),
    type,
    ts: '2026-06-01T00:01:00.000Z',
    schema_version: 1,
    idempotency_key: uuidv7(),
    ...(sidecar
      ? { sidecar_sha256: digest(payloadBytes), sidecar_size: payloadBytes.length }
      : { payload }),
  };
  const checked = { ...record, checksum: recordChecksum(record) };
  return { record: checked, bytes: Buffer.from(` ${JSON.stringify(checked)} \n`), payloadBytes };
}
function input(artifactId = uuidv7(), branch?: string): AppendProjectArtifactEvents {
  return {
    operationId: uuidv7(),
    artifactId,
    expectedRevision: null,
    eventBytes: event('plan_captured', plan(artifactId, branch)).bytes,
    sidecarPayloads: [],
    secretAllow: [],
  };
}

interface IndexedSource {
  artifactId: string;
  sourceId: string;
  match: 'intent' | 'body' | 'terms';
  origin: 0 | 1;
  evidenceTime: string | null;
}

async function replaceIndexedSources(
  handle: ProjectDatabase,
  authority: Awaited<ReturnType<typeof fixture>>['authority'],
  sources: IndexedSource[]
) {
  const artifactIds = [...new Set(sources.map((source) => source.artifactId))];
  for (const artifactId of artifactIds)
    await appendProjectArtifactEvents(handle, input(artifactId));
  const raw = new Database(projectDatabasePath(authority));
  try {
    const insert = raw.prepare('INSERT INTO artifact_search_sources VALUES (?, ?, ?, ?, ?, ?, ?)');
    raw.transaction(() => {
      raw.exec('DELETE FROM artifact_search_sources');
      for (const source of sources) {
        const tokens =
          source.match === 'intent'
            ? { intent_fields: [['project', 'history']], body_fields: [] }
            : source.match === 'body'
              ? { intent_fields: [], body_fields: [['project', 'history']] }
              : { intent_fields: [], body_fields: [['project'], ['history']] };
        insert.run(
          source.artifactId,
          source.sourceId,
          'plan',
          source.origin,
          source.evidenceTime,
          JSON.stringify(tokens),
          JSON.stringify({ source_id: source.sourceId })
        );
      }
      for (const artifactId of artifactIds)
        raw
          .prepare('UPDATE artifact_search_state SET source_count=? WHERE artifact_id=?')
          .run(sources.filter((source) => source.artifactId === artifactId).length, artifactId);
    })();
  } finally {
    raw.close();
  }
}

describe('project database search', () => {
  it('orders every match before limiting and reports full counts from a read-only connection', async () => {
    const { handle, authority } = await fixture();
    const expected: string[] = [];
    for (let n = 0; n < 18; n++) {
      const artifactId = uuidv7();
      const payload = plan(artifactId);
      if (n % 3 === 0) {
        payload.task = 'precise search';
        expected.push(artifactId);
      }
      if (n % 3 === 1) payload.plan_steps[0].text = 'precise search';
      if (n % 3 === 2) {
        payload.task = 'precise';
        payload.plan_steps[0].text = 'search';
      }
      await appendProjectArtifactEvents(handle, {
        ...input(artifactId),
        eventBytes: event('plan_captured', payload).bytes,
      });
    }
    const reader = await openProjectDatabase({ authority, mode: 'reader' });
    handles.push(reader);
    const before = handle.read(() => null).counters;
    const prepared = vi.spyOn(Database.prototype, 'prepare');
    const page = queryProjectSearch(reader, {
      query: ['precise', 'search'],
      sourceKinds: ['plan'],
      limit: 4,
    });
    expect(page.rows.map((row) => row.artifact_id)).toEqual(expected.sort().slice(0, 4));
    expect(page.rows.map((row) => row.match_class)).toEqual([0, 0, 0, 0]);
    expect(page.counts).toEqual({ captured: 18, imported: 0 });
    expect(page.scanned).toBe(18);
    expect(page.counters).toEqual(before);
    expect(
      prepared.mock.calls.some(([sql]) => /record_bytes|sidecar_payload_bytes/.test(sql))
    ).toBe(false);
    const all = queryProjectSearch(reader, {
      query: ['precise', 'search'],
      sourceKinds: ['plan'],
      limit: 30,
    });
    expect(all.rows.map((row) => row.match_class)).toEqual([
      ...Array(6).fill(0),
      ...Array(6).fill(1),
      ...Array(6).fill(2),
    ]);
    expect(handle.read(() => null).counters).toEqual(before);
  });

  it('applies class, origin, time, artifact and source ordering before the final limit', async () => {
    const { handle, authority } = await fixture();
    const [firstArtifact, secondArtifact] = [uuidv7(), uuidv7()].sort();
    const sources: IndexedSource[] = [
      {
        artifactId: firstArtifact!,
        sourceId: 'captured-new-a',
        match: 'intent',
        origin: 0,
        evidenceTime: '2026-06-03T00:00:00.000Z',
      },
      {
        artifactId: firstArtifact!,
        sourceId: 'captured-new-b',
        match: 'intent',
        origin: 0,
        evidenceTime: '2026-06-03T00:00:00.000Z',
      },
      {
        artifactId: secondArtifact!,
        sourceId: 'captured-new-other',
        match: 'intent',
        origin: 0,
        evidenceTime: '2026-06-03T00:00:00.000Z',
      },
      {
        artifactId: firstArtifact!,
        sourceId: 'captured-old',
        match: 'intent',
        origin: 0,
        evidenceTime: '2020-01-01T00:00:00.000Z',
      },
      {
        artifactId: firstArtifact!,
        sourceId: 'captured-unknown',
        match: 'intent',
        origin: 0,
        evidenceTime: null,
      },
      {
        artifactId: firstArtifact!,
        sourceId: 'imported-new',
        match: 'intent',
        origin: 1,
        evidenceTime: '2026-09-01T00:00:00.000Z',
      },
      {
        artifactId: firstArtifact!,
        sourceId: 'body',
        match: 'body',
        origin: 0,
        evidenceTime: '2026-09-01T00:00:00.000Z',
      },
      {
        artifactId: firstArtifact!,
        sourceId: 'terms',
        match: 'terms',
        origin: 0,
        evidenceTime: '2026-09-01T00:00:00.000Z',
      },
    ];
    await replaceIndexedSources(handle, authority, sources);
    const selection = { query: ['project', 'history'], sourceKinds: ['plan'], limit: 5 };
    const page = queryProjectSearch(handle, selection);
    expect(page.rows.map((row) => row.source_id)).toEqual([
      'captured-new-a',
      'captured-new-b',
      'captured-new-other',
      'captured-old',
      'captured-unknown',
    ]);
    expect(page.counts).toEqual({ captured: 7, imported: 1 });
    expect(page.scanned).toBe(8);
    expect(
      queryProjectSearch(handle, { ...selection, limit: 20 }).rows.map((row) => row.source_id)
    ).toEqual([
      'captured-new-a',
      'captured-new-b',
      'captured-new-other',
      'captured-old',
      'captured-unknown',
      'imported-new',
      'body',
      'terms',
    ]);
  });

  it('finds the strongest match beyond ten thousand weaker candidates before limiting', async () => {
    const { handle, authority } = await fixture();
    const artifactId = uuidv7();
    const sources: IndexedSource[] = [
      ...Array.from({ length: 10_001 }, (_, index) => ({
        artifactId,
        sourceId: `body-${String(index).padStart(5, '0')}`,
        match: 'body' as const,
        origin: 0 as const,
        evidenceTime: '2026-01-01T00:00:00.000Z',
      })),
      {
        artifactId,
        sourceId: 'strong-intent',
        match: 'intent',
        origin: 1,
        evidenceTime: null,
      },
    ];
    await replaceIndexedSources(handle, authority, sources);
    const page = queryProjectSearch(handle, {
      query: ['project', 'history'],
      sourceKinds: ['plan'],
      limit: 1,
    });
    expect(page.rows.map((row) => row.source_id)).toEqual(['strong-intent']);
    expect(page.counts).toEqual({ captured: 10_001, imported: 1 });
    expect(page.scanned).toBe(10_002);
    expect(page.rankingComplete).toBe(true);
  });

  it('commits branch selection and refreshed source rows with an append and replays without writes', async () => {
    const { handle } = await fixture();
    const original = input();
    const first = await appendProjectArtifactEvents(handle, original);
    expect(
      queryProjectSearch(handle, { query: ['original'], branch: 'rebased', limit: 10 }).rows
    ).toEqual([]);
    const next = {
      ...original,
      operationId: uuidv7(),
      expectedRevision: first.value.revision,
      eventBytes: event('branch_lineage_updated', {
        artifact_id: original.artifactId,
        branch: 'rebased',
        head_sha: 'next-head',
        ts: '2026-06-01T00:02:00.000Z',
        event: 'rebased',
      }).bytes,
    };
    await appendProjectArtifactEvents(handle, next);
    const found = queryProjectSearch(handle, {
      query: ['original'],
      branch: 'rebased',
      sourceKinds: ['plan'],
      limit: 10,
    });
    expect(found.rows).toHaveLength(1);
    expect(JSON.parse(found.rows[0].payload_json).metadata.artifact_commit_generation).toBe(2);
    await appendProjectArtifactEvents(handle, original);
    expect(
      queryProjectSearch(handle, {
        query: ['original'],
        branch: 'rebased',
        sourceKinds: ['plan'],
        limit: 10,
      }).counters
    ).toEqual(found.counters);
    expect(
      queryProjectSearch(handle, { query: ['original'], artifactIds: [], limit: 10 }).rows
    ).toEqual([]);
  });

  it('rolls back authored rows when index publication fails', async () => {
    const { handle, authority } = await fixture();
    const raw = new Database(projectDatabasePath(authority));
    try {
      raw.exec(
        `CREATE TRIGGER refuse_search BEFORE INSERT ON artifact_search_sources BEGIN SELECT RAISE(ABORT, 'test publication failure'); END;`
      );
      const original = input();
      const before = handle.read(() => null).counters;
      await expect(appendProjectArtifactEvents(handle, original)).rejects.toMatchObject({
        code: 'TRANSACTION_FAILED',
      });
      expect(readProjectArtifact(handle, original.artifactId)).toBeNull();
      expect(
        handle.read((view) =>
          view.get<{ n: number }>('SELECT count(*) n FROM artifact_search_sources')
        ).value!.n
      ).toBe(0);
      expect(handle.read(() => null).counters).toEqual(before);
      raw.exec('DROP TRIGGER refuse_search');
      await appendProjectArtifactEvents(handle, original);
      expect(queryProjectSearch(handle, { query: ['original'], limit: 1 }).rows).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it('reports missing or incompatible derived rows without repairing them', async () => {
    const { handle, authority } = await fixture();
    await appendProjectArtifactEvents(handle, input());
    const raw = new Database(projectDatabasePath(authority));
    try {
      raw.exec('DELETE FROM artifact_search_sources');
      const before = handle.read(() => null).counters;
      expect(() => queryProjectSearch(handle, { query: ['original'], limit: 1 })).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      expect(raw.prepare('SELECT count(*) n FROM artifact_search_sources').get()).toEqual({ n: 0 });
      expect(handle.read(() => null).counters).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it('reports malformed derived tokens without reading or rewriting authoritative events', async () => {
    const { handle, authority } = await fixture();
    await appendProjectArtifactEvents(handle, input());
    const raw = new Database(projectDatabasePath(authority));
    try {
      raw.exec(
        `UPDATE artifact_search_sources SET tokens_json='{"intent_fields":[7],"body_fields":[]}'`
      );
      const before = handle.read(() => null).counters;
      expect(() => queryProjectSearch(handle, { query: ['original'], limit: 1 })).toThrow(
        expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })
      );
      expect(handle.read(() => null).counters).toEqual(before);
    } finally {
      raw.close();
    }
  });

  it.each([
    { query: [] },
    { query: ['Two Words'] },
    { query: ['é'] },
    { query: ['ok'], limit: 0 },
    { query: ['ok'], artifactIds: ['prefix'] },
    { query: ['ok'], sourceKinds: ['anything'] },
    { query: ['ok'], branch: '' },
    { query: ['ok'], sinceMs: 2, untilMs: 1 },
    { query: ['ok'], touching: '../**' },
    { query: ['ok'], worktreeId: 'prefix' },
    { query: ['ok'], branch: ' \t' },
  ])('rejects invalid selection before reading storage: %j', async (invalid) => {
    const { handle } = await fixture();
    const prepared = vi.spyOn(Database.prototype, 'prepare');
    expect(() => queryProjectSearch(handle, { limit: 1, ...invalid })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
    expect(prepared).not.toHaveBeenCalled();
  });
});

it('filters current execution branches and associations before ranking and limiting', async () => {
  const { handle, authority } = await fixture();
  const worktrees = [uuidv7(), uuidv7()];
  const ids = [uuidv7(), uuidv7()];
  for (let index = 0; index < ids.length; index++) {
    await appendProjectExecutionCapture(handle, {
      ...input(ids[index]),
      eventBytes: event(
        'plan_captured',
        plan(ids[index], 'original-branch', `2026-06-0${index + 1}T00:00:00.000Z`)
      ).bytes,
      execution: {
        kind: 'create',
        context: {
          repository_instance_id: authority.repositoryInstanceId,
          worktree_id: worktrees[index],
          git_context: { branch: `execution-${index}`, head_sha: 'a'.repeat(40) },
        },
        ts: '2026-06-01T00:00:00.000Z',
      },
    });
  }
  const query = { query: ['original'], sourceKinds: ['plan'], limit: 1 };
  expect(
    queryProjectSearch(handle, { ...query, branch: 'execution-1' }).rows.map((r) => r.artifact_id)
  ).toEqual([ids[1]]);
  expect(
    queryProjectSearch(handle, { ...query, worktreeId: worktrees[1] }).rows.map(
      (r) => r.artifact_id
    )
  ).toEqual([ids[1]]);
  expect(
    queryProjectSearch(handle, { ...query, sinceMs: Date.parse('2026-06-02') }).rows.map(
      (r) => r.artifact_id
    )
  ).toEqual([ids[1]]);
  expect(
    queryProjectSearch(handle, { ...query, untilMs: Date.parse('2026-06-01') }).rows.map(
      (r) => r.artifact_id
    )
  ).toEqual([ids[0]]);
  expect(
    queryProjectSearch(handle, { ...query, branch: 'execution-1', worktreeId: worktrees[0] }).rows
  ).toEqual([]);
  expect(queryProjectSearch(handle, { ...query, origin: 'imported' }).counts).toEqual({
    captured: 0,
    imported: 0,
  });
  expect(queryProjectSearch(handle, { ...query, state: 'summarized' }).rows).toEqual([]);
  expect(queryProjectSearch(handle, { ...query, touching: 'src/**' }).rows).toEqual([]);
  expect(
    queryProjectSearch(handle, {
      ...query,
      activeSinceMs: Date.parse('2026-06-01'),
      activeUntilMs: Date.parse('2026-06-03'),
    }).rows
  ).toHaveLength(1);
});

it('checks missing search and branch rows before filters can hide them', async () => {
  const { handle, authority } = await fixture();
  const first = input();
  const second = input();
  await appendProjectArtifactEvents(handle, first);
  await appendProjectArtifactEvents(handle, second);
  const raw = new Database(projectDatabasePath(authority));
  try {
    raw.prepare('DELETE FROM artifact_search_sources WHERE artifact_id=?').run(first.artifactId);
    expect(() =>
      queryProjectSearch(handle, { query: ['original'], branch: 'no-match', limit: 1 })
    ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(
      queryProjectSearch(handle, {
        query: ['original'],
        artifactIds: [second.artifactId],
        limit: 1,
      }).rows
    ).toHaveLength(1);
    raw.prepare('DELETE FROM artifact_branches WHERE artifact_id=?').run(second.artifactId);
    expect(() =>
      queryProjectSearch(handle, {
        query: ['original'],
        artifactIds: [second.artifactId],
        branch: 'no-match',
        limit: 1,
      })
    ).toThrow(expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' }));
    expect(
      queryProjectSearch(handle, { query: ['original'], artifactIds: [], limit: 1 }).rows
    ).toEqual([]);
  } finally {
    raw.close();
  }
});

it('discloses uncertain worktree membership without inventing zero matching counts', async () => {
  const { handle } = await fixture();
  const original = input();
  await appendProjectArtifactEvents(handle, original);
  const worktreeId = uuidv7();
  expect(queryProjectSearch(handle, { query: ['original'], worktreeId, limit: 1 })).toMatchObject({
    rows: [],
    unknownAssociations: 1,
    counts: { captured: null, imported: null },
    sourceComplete: true,
    candidateComplete: false,
    rankingComplete: false,
  });
  expect(
    queryProjectSearch(handle, { query: ['original'], worktreeId, artifactIds: [], limit: 1 })
  ).toMatchObject({
    rows: [],
    unknownAssociations: 0,
    counts: { captured: 0, imported: 0 },
    sourceComplete: true,
    candidateComplete: true,
    rankingComplete: true,
  });
  expect(
    queryProjectSearch(handle, { query: ['original'], worktreeId, branch: 'no-match', limit: 1 })
      .unknownAssociations
  ).toBe(0);
});
it.each([null, undefined, 7, 'query', []])(
  'rejects non-object search input %j before storage access',
  (input) => {
    expect(() =>
      queryProjectSearch(
        null as unknown as ProjectDatabase,
        input as unknown as Parameters<typeof queryProjectSearch>[1]
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  }
);
