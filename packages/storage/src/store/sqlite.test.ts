import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_VERSION } from './migrations/index.js';
import { parseCacheSchemaVersion, Store } from './sqlite.js';

describe('parseCacheSchemaVersion', () => {
  it('accepts only canonical non-negative safe integers', () => {
    expect(parseCacheSchemaVersion('0')).toBe(0);
    expect(parseCacheSchemaVersion('23')).toBe(23);
    expect(parseCacheSchemaVersion('23x')).toBeNull();
    expect(parseCacheSchemaVersion('023')).toBeNull();
    expect(parseCacheSchemaVersion('-1')).toBeNull();
    expect(parseCacheSchemaVersion('9007199254740992')).toBeNull();
    expect(parseCacheSchemaVersion(null)).toBeNull();
  });
});

describe('Store', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'orcaops-store-'));
    store = new Store(path.join(tmpDir, 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('initializes the schema on first open', () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('artifacts');
    expect(names).toContain('checkpoints');
    expect(names).toContain('summaries');
    expect(names).toContain('evaluator_runs');
    expect(names).toContain('evaluator_dispositions');
    expect(names).toContain('plan_steps');
    expect(names).toContain('schema_meta');
  });

  it('initializes a fresh DB at the latest schema version (CURRENT_VERSION)', () => {
    const row = store.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
      value: string;
    };
    expect(parseInt(row.value, 10)).toBe(CURRENT_VERSION);
  });

  it('translates an interrupted legacy rebuild marker into pending health', () => {
    store.db.prepare("DELETE FROM schema_meta WHERE key = 'projection_health'").run();
    store.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('needs_rebuild', '1')").run();
    const dbPath = store.dbPath;
    store.close();

    store = new Store(dbPath);
    expect(store.projectionHealth).toBe('rebuild_pending');
    expect(
      store.db.prepare("SELECT value FROM schema_meta WHERE key = 'projection_health'").get()
    ).toEqual({ value: 'rebuild_pending' });
    expect(
      store.db.prepare("SELECT 1 FROM schema_meta WHERE key = 'needs_rebuild'").get()
    ).toBeUndefined();
  });

  it('rebuilds a current-version cache whose health was never certified', () => {
    store.db.prepare("DELETE FROM schema_meta WHERE key = 'projection_health'").run();
    const dbPath = store.dbPath;
    store.close();

    store = new Store(dbPath);
    expect(store.projectionHealth).toBe('rebuild_pending');
    expect(
      store.db.prepare("SELECT value FROM schema_meta WHERE key = 'projection_health'").get()
    ).toEqual({ value: 'rebuild_pending' });
  });

  it('a fresh DB has the checkpoints.completed_step_ids column (migration 008 applied)', () => {
    const cols = store.db.prepare(`PRAGMA table_info(checkpoints)`).all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain('completed_step_ids');
    expect(cols.map((c) => c.name)).toContain('declared_step_ids');
    expect(cols.map((c) => c.name)).toContain('plan_revision_id');
  });

  it('a fresh DB has the artifacts.non_goals column (migration 006 applied)', () => {
    const cols = store.db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'non_goals');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe(`'[]'`);
  });

  it('a fresh DB has the plans.decisions column (migration 017 applied)', () => {
    const cols = store.db.prepare(`PRAGMA table_info(plans)`).all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'decisions');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe(`'[]'`);
  });

  it('a fresh DB has the artifacts.label + plans.label columns (migration 011 applied)', () => {
    const artifactCols = store.db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const aLabel = artifactCols.find((c) => c.name === 'label');
    expect(aLabel).toBeDefined();
    expect(aLabel?.notnull).toBe(1);

    const planCols = store.db.prepare(`PRAGMA table_info(plans)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const pLabel = planCols.find((c) => c.name === 'label');
    expect(pLabel).toBeDefined();
    expect(pLabel?.notnull).toBe(1);
  });

  it('refuses an older cache without mutating it', () => {
    const seed =
      'INSERT INTO artifacts (id, branch, task, agent, base_sha, started_at, completed_at, status, non_goals) ' +
      "VALUES ('legacy-1', 'main', 't', 'claude-code', 'd', '2026-04-25T12:00:00.000Z', NULL, 'active', '[]');\n" +
      "UPDATE schema_meta SET value = '10' WHERE key = 'version';";
    store.db.exec(seed);
    const dbPath = store.dbPath;
    store.close();

    expect(() => new Store(dbPath)).toThrow(/unsupported; expected 25/);
    const raw = new Database(dbPath);
    expect(raw.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()).toEqual({
      value: '10',
    });
    expect(raw.prepare("SELECT id FROM artifacts WHERE id = 'legacy-1'").get()).toBeDefined();
    raw
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
      .run(String(CURRENT_VERSION));
    raw.close();
    store = new Store(dbPath);
  });

  it('lets only the explicit rebuild path open an older cache without mutating it first', () => {
    store.db.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'version'").run();
    const dbPath = store.dbPath;
    store.close();

    const fresh = new Store(dbPath, { rebuildExistingProjection: true });
    try {
      const row = fresh.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
        value: string;
      };
      expect(row.value).toBe('5');
      expect(fresh.projectionHealth).toBe('rebuild_pending');
    } finally {
      fresh.close();
    }
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
      .run(String(CURRENT_VERSION));
    raw.close();
    store = new Store(dbPath);
  });

  it('upsertArtifact requires label and non_goals independently at compile time', () => {
    const base = {
      id: 'aaaaaaaa',
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    } as const;
    // @ts-expect-error — label omitted: independently required
    const missingLabel = () => store.upsertArtifact({ ...base, non_goals: '[]' });
    // @ts-expect-error — non_goals omitted: independently required
    const missingNonGoals = () => store.upsertArtifact({ ...base, label: 'l' });
    void missingLabel;
    void missingNonGoals;
    store.upsertArtifact({ ...base, label: 'l', non_goals: '[]' });
    expect(store.getArtifact('aaaaaaaa')?.non_goals).toBe('[]');
  });

  it('upsertArtifact persists non_goals as a JSON-encoded string', () => {
    store.upsertArtifact({
      label: 'test-label',
      id: 'bbbbbbbb',
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
      non_goals: JSON.stringify(['no DB migration', 'do not change auth']),
    });
    const row = store.getArtifact('bbbbbbbb');
    expect(JSON.parse(row?.non_goals ?? '[]')).toEqual(['no DB migration', 'do not change auth']);
  });

  it('strictly rejects a malformed version instead of parsing its numeric prefix', () => {
    store.db.prepare("UPDATE schema_meta SET value = '23x' WHERE key = 'version'").run();
    const dbPath = store.dbPath;
    store.close();

    expect(() => new Store(dbPath, { rebuildExistingProjection: true })).toThrow(
      /version "23x" is unsupported/
    );
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
      .run(String(CURRENT_VERSION));
    raw.close();
    store = new Store(dbPath);
  });

  it('throws on a future schema version (newer than this orcaops binary supports)', () => {
    store.db.exec(`UPDATE schema_meta SET value = '99' WHERE key = 'version'`);
    const dbPath = store.dbPath;
    store.close();

    expect(() => new Store(dbPath)).toThrow(/newer than supported/);

    // Recovery: rewind to CURRENT_VERSION (not 1, because the schema
    // already matches CURRENT_VERSION; migrate would fail trying to
    // re-add the column). Then reopen via Store cleanly so afterEach
    // can close it.
    const raw = new Database(dbPath);
    raw.exec(`UPDATE schema_meta SET value = '${CURRENT_VERSION}' WHERE key = 'version'`);
    raw.close();
    store = new Store(dbPath);
  });

  it('upserts and retrieves an artifact row', () => {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'abcdef12',
      branch: 'feat/x',
      task: 't',
      agent: 'claude-code',
      base_sha: 'deadbeef',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    const row = store.getArtifact('abcdef12');
    expect(row?.task).toBe('t');
    expect(row?.status).toBe('active');
  });

  describe('listArtifacts filters', () => {
    beforeEach(() => {
      const base = {
        agent: 'claude-code',
        base_sha: 'deadbeef',
        completed_at: null,
        task: 't',
      };
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        ...base,
        id: 'aaaaaaaa',
        branch: 'feat/x',
        started_at: '2026-04-25T10:00:00.000Z',
        status: 'active',
      });
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        ...base,
        id: 'bbbbbbbb',
        branch: 'feat/x',
        started_at: '2026-04-25T11:00:00.000Z',
        status: 'complete',
      });
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        ...base,
        id: 'cccccccc',
        branch: 'feat/y',
        started_at: '2026-04-25T12:00:00.000Z',
        status: 'complete',
      });
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        ...base,
        id: 'dddddddd',
        branch: 'feat/y',
        started_at: '2026-04-25T13:00:00.000Z',
        status: 'active',
      });
    });

    it('returns all rows ordered by started_at DESC when no filter is given', () => {
      const rows = store.listArtifacts();
      expect(rows.map((r) => r.id)).toEqual(['dddddddd', 'cccccccc', 'bbbbbbbb', 'aaaaaaaa']);
    });

    it('filters by status: active', () => {
      const rows = store.listArtifacts({ status: 'active' });
      expect(rows.map((r) => r.id)).toEqual(['dddddddd', 'aaaaaaaa']);
    });

    it('filters by status: complete', () => {
      const rows = store.listArtifacts({ status: 'complete' });
      expect(rows.map((r) => r.id)).toEqual(['cccccccc', 'bbbbbbbb']);
    });

    it('AND-composes branch and status filters', () => {
      const rows = store.listArtifacts({ branch: 'feat/x', status: 'complete' });
      expect(rows.map((r) => r.id)).toEqual(['bbbbbbbb']);
    });

    it('returns no rows when the combined filter matches nothing', () => {
      // feat/z holds only an active artifact, so the status half of the
      // composition is what empties the result.
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        agent: 'claude-code',
        base_sha: 'deadbeef',
        completed_at: null,
        task: 't',
        id: 'eeeeeeee',
        branch: 'feat/z',
        started_at: '2026-04-25T14:00:00.000Z',
        status: 'active',
      });
      const rows = store.listArtifacts({ branch: 'feat/z', status: 'complete' });
      expect(rows).toEqual([]);
    });
  });

  it('upsertPlanRevision projects per-revision metadata + step rows', () => {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a1',
      branch: 'b',
      task: 't',
      agent: 'claude-code',
      base_sha: 'd',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.upsertPlanRevision({
      plan: {
        artifact_id: 'a1',
        revision_n: 0,
        captured_at: '2026-04-25T12:00:00.000Z',
        label: 'plan-headline',
        rationale: null,
        touched_scope: '[]',
        non_goals: '[]',
        decisions: '[]',
        step_lineage: '{"added":[],"dropped":[],"unchanged":[],"rewritten":[]}',
        criterion_lineage: '{"added":[],"removed":[],"rewritten":[]}',
        prior_event_id: null,
        source_event_id: 'evt_initial',
      },
      steps: [
        {
          step_id: 'step-1',
          idx: 0,
          text: 'step one',
          label: 'step-1',
          acceptance_criteria: '[{"criterion_id":"crit-1","text":"covers X"}]',
        },
        { step_id: 'step-2', idx: 1, text: 'step two', label: 'step-2', acceptance_criteria: '[]' },
      ],
    });
    let latest = store.getLatestPlanRevision('a1');
    expect(latest?.plan.revision_n).toBe(0);
    expect(latest?.steps.map((s) => s.text)).toEqual(['step one', 'step two']);
    // acceptance_criteria round-trips as the raw JSON string (the store
    // mapper parses it; the projection row keeps it encoded).
    expect(latest?.steps[0].acceptance_criteria).toBe(
      '[{"criterion_id":"crit-1","text":"covers X"}]'
    );
    expect(latest?.steps[1].acceptance_criteria).toBe('[]');
    expect(store.latestPlanRevisionN('a1')).toBe(0);
    expect(store.latestPlanSourceEventId('a1')).toBe('evt_initial');

    // Append revision 1 — drops step-2, adds step-3.
    store.upsertPlanRevision({
      plan: {
        artifact_id: 'a1',
        revision_n: 1,
        captured_at: '2026-04-25T13:00:00.000Z',
        label: 'plan-headline-rev1',
        rationale: 'reorganized after discovery',
        touched_scope: '[]',
        non_goals: '[]',
        decisions: '[]',
        step_lineage:
          '{"added":["step-3"],"dropped":["step-2"],"unchanged":["step-1"],"rewritten":[]}',
        criterion_lineage: '{"added":[],"removed":[],"rewritten":[]}',
        prior_event_id: 'evt_initial',
        source_event_id: 'evt_revision_1',
      },
      steps: [
        { step_id: 'step-1', idx: 0, text: 'step one', label: 'step-1', acceptance_criteria: '[]' },
        {
          step_id: 'step-3',
          idx: 1,
          text: 'step three',
          label: 'step-3',
          acceptance_criteria: '[]',
        },
      ],
    });
    latest = store.getLatestPlanRevision('a1');
    expect(latest?.plan.revision_n).toBe(1);
    expect(latest?.steps.map((s) => s.step_id)).toEqual(['step-1', 'step-3']);
    expect(store.latestPlanRevisionN('a1')).toBe(1);
    expect(store.latestPlanSourceEventId('a1')).toBe('evt_revision_1');

    // Prior revisions remain queryable.
    const prior = store.getPlanRevision('a1', 0);
    expect(prior?.steps.map((s) => s.step_id)).toEqual(['step-1', 'step-2']);

    const all = store.listPlanRevisions('a1');
    expect(all.map((r) => r.plan.revision_n)).toEqual([0, 1]);
  });

  it('upserts checkpoints with JSON-encoded array fields', () => {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a2',
      branch: 'b',
      task: 't',
      agent: 'claude-code',
      base_sha: 'd',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: 'a2',
      n: 1,
      declared_step_ids: ['step-1', 'step-2'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'wired middleware',
      files_changed: ['src/a.ts'],
      decisions: [{ decision: 'use redis', reason: 'already deployed' }],
      uncertainty: ['ttl strategy'],
      done_criteria: [],
      completed_step_ids: ['step-1', 'step-2'],
      head_sha: 'cafef00d',
    });
    const cps = store.getCheckpoints('a2');
    expect(cps).toHaveLength(1);
    if (cps[0].status !== 'closed') throw new Error('expected closed');
    expect(cps[0].files_changed).toEqual(['src/a.ts']);
    expect(cps[0].decisions).toEqual([{ decision: 'use redis', reason: 'already deployed' }]);
    expect(cps[0].completed_step_ids).toEqual(['step-1', 'step-2']);
  });

  it('FTS5 search returns matching rows', () => {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a3',
      branch: 'b',
      task: 't',
      agent: 'claude-code',
      base_sha: 'd',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.replaceSearchEntry({
      artifact_id: 'a3',
      source: 'plan',
      branch: 'b',
      ts: '2026-04-25T12:00:00.000Z',
      content: 'add rate limiting to /api/charge',
    });
    expect(store.searchCount('rate')).toBe(1);
    expect(store.searchCount('nonexistent')).toBe(0);
  });

  it('findCheckpointsTouchingFile rejects substring false positives via JS exact-match guard', () => {
    // SQLite LIKE '%"src/foo.ts"%' would also match a row whose
    // files_changed contains "src/foo.ts.bak" or "lib/src/foo.ts" — the
    // implementation pre-filters with LIKE then re-checks with
    // Array.includes(). Verify the JS-side guard fires.
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-real',
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'd',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-decoy',
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'd',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: 'a-real',
      n: 1,
      declared_step_ids: ['step-1'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'real',
      files_changed: ['src/foo.ts'],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'aaaa',
    });
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: 'a-decoy',
      n: 1,
      declared_step_ids: ['step-1'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 'decoy',
      files_changed: ['src/foo.ts.bak'],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'bbbb',
    });

    const hits = store.findCheckpointsTouchingFile({ file: 'src/foo.ts' });
    expect(hits).toHaveLength(1);
    expect(hits[0].artifact_id).toBe('a-real');
  });

  it('findCheckpointsTouchingFile projects base_sha for the why resolver predates-artifact check', () => {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-base',
      branch: 'main',
      task: 't',
      agent: 'claude-code',
      base_sha: 'BASE_SHA_DEADBEEF',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    store.upsertCheckpoint({
      status: 'closed',
      artifact_id: 'a-base',
      n: 1,
      declared_step_ids: ['step-1'],
      agent_session_id: null,
      policy_exceptions: [],
      plan_revision_id: null,
      open_plan_revision_event_id: null,
      opened_at: '2026-04-25T12:29:00.000Z',
      closed_at: '2026-04-25T12:30:00.000Z',
      summary: 's',
      files_changed: ['src/x.ts'],
      decisions: [],
      uncertainty: [],
      done_criteria: [],
      completed_step_ids: [],
      head_sha: 'HEAD_SHA',
    });
    const hits = store.findCheckpointsTouchingFile({ file: 'src/x.ts' });
    expect(hits).toHaveLength(1);
    expect(hits[0].base_sha).toBe('BASE_SHA_DEADBEEF');
    expect(hits[0].head_sha).toBe('HEAD_SHA');
  });

  it('search() returns ranked rows with snippets and respects branch + source filters', () => {
    for (const a of ['a-plan', 'a-cp', 'a-other']) {
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id: a,
        branch: a === 'a-other' ? 'feat/other' : 'feat/work',
        task: 't',
        agent: 'claude-code',
        base_sha: 'd',
        started_at: '2026-04-25T12:00:00.000Z',
        completed_at: null,
        status: 'active',
      });
    }
    store.replaceSearchEntry({
      artifact_id: 'a-plan',
      source: 'plan',
      branch: 'feat/work',
      ts: '2026-04-25T12:00:00.000Z',
      content: 'add rate limiting to /api/charge with redis sliding window',
    });
    store.replaceSearchEntry({
      artifact_id: 'a-cp',
      source: 'checkpoint:1',
      branch: 'feat/work',
      ts: '2026-04-25T12:30:00.000Z',
      content: 'wired the redis middleware',
    });
    store.replaceSearchEntry({
      artifact_id: 'a-cp-bare',
      source: 'checkpoint',
      branch: 'feat/work',
      ts: '2026-04-25T12:35:00.000Z',
      content: 'redis checkpoint summary',
    });
    store.replaceSearchEntry({
      artifact_id: 'a-other',
      source: 'plan',
      branch: 'feat/other',
      ts: '2026-04-25T12:00:00.000Z',
      content: 'redis cache eviction policy',
    });

    // No filters — all 4 rows match "redis", ranked.
    const all = store.search('redis');
    expect(all).toHaveLength(4);
    expect(all[0].snippet).toContain('<<redis>>');

    // Branch filter
    const onlyWork = store.search('redis', { branch: 'feat/work' });
    expect(onlyWork.map((r) => r.artifact_id).sort()).toEqual(['a-cp', 'a-cp-bare', 'a-plan']);

    store.db
      .prepare(
        `INSERT INTO search_idx (artifact_id, source, branch, ts, content)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        'a-similar-prefix',
        'checkpointer',
        'feat/work',
        '2026-04-25T12:40:00.000Z',
        'redis lexical prefix decoy'
      );

    // Source-prefix filter — checkpoints only
    const onlyCp = store.search('redis', { sourcePrefix: 'checkpoint' });
    expect(onlyCp.map((row) => row.source).sort()).toEqual(['checkpoint', 'checkpoint:1']);

    // Limit
    const limited = store.search('redis', { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('ranks equivalent imported hits after live captures and can exclude them', () => {
    for (const [id, origin_kind] of [
      ['live-hit', null],
      ['imported-hit', 'git-import'],
    ] as const) {
      store.upsertArtifact({
        label: id,
        non_goals: '[]',
        id,
        branch: 'main',
        task: 'same task',
        agent: 'other',
        base_sha: 'd',
        started_at: '2026-04-25T12:00:00.000Z',
        completed_at: '2026-04-25T12:30:00.000Z',
        status: 'complete',
        origin_kind,
      });
      store.replaceSearchEntry({
        artifact_id: id,
        source: 'summary',
        branch: 'main',
        ts: '2026-04-25T12:30:00.000Z',
        content: 'equivalent ranking needle',
      });
    }

    expect(store.search('needle').map((row) => [row.artifact_id, row.origin_kind])).toEqual([
      ['live-hit', null],
      ['imported-hit', 'git-import'],
    ]);
    expect(
      store.search('needle', { includeImported: false }).map((row) => row.artifact_id)
    ).toEqual(['live-hit']);
  });

  it('reset() drops and recreates all tables', () => {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a4',
      branch: 'b',
      task: 't',
      agent: 'claude-code',
      base_sha: 'd',
      started_at: '2026-04-25T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    expect(store.getArtifact('a4')).not.toBeNull();
    store.reset();
    expect(store.getArtifact('a4')).toBeNull();
  });

  describe('two-phase checkpoint lifecycle', () => {
    const artifactId = 'lifecycle-a';
    beforeEach(() => {
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id: artifactId,
        branch: 'main',
        task: 't',
        agent: 'claude-code',
        base_sha: 'BASE',
        started_at: '2026-04-25T12:00:00.000Z',
        completed_at: null,
        status: 'active',
      });
    });

    it('upserts and reads an open checkpoint via getOpenCheckpoints', () => {
      store.upsertCheckpoint({
        status: 'open',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1', 'step-2'],
        agent_session_id: 'subagent-a',
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:30:00.000Z',
        head_sha: 'aaa',
      });
      const opens = store.getOpenCheckpoints(artifactId);
      expect(opens).toHaveLength(1);
      expect(opens[0].declared_step_ids).toEqual(['step-1', 'step-2']);
      expect(opens[0].agent_session_id).toBe('subagent-a');
      expect(store.getClosedCheckpoints(artifactId)).toHaveLength(0);
    });

    it('upserts and reads a closed checkpoint via getClosedCheckpoints', () => {
      store.upsertCheckpoint({
        status: 'closed',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        closed_at: '2026-04-25T12:30:00.000Z',
        summary: 'done',
        files_changed: ['a'],
        decisions: [],
        uncertainty: ['ttl?'],
        done_criteria: [],
        completed_step_ids: ['step-1'],
        head_sha: 'aaa',
      });
      const closed = store.getClosedCheckpoints(artifactId);
      expect(closed).toHaveLength(1);
      expect(closed[0].summary).toBe('done');
      expect(store.getOpenCheckpoints(artifactId)).toHaveLength(0);
    });

    it('upserts and reads an abandoned checkpoint via getAbandonedCheckpoints', () => {
      store.upsertCheckpoint({
        status: 'abandoned',
        artifact_id: artifactId,
        n: 2,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        abandoned_at: '2026-04-25T12:31:00.000Z',
        reason: 'subagent timed out',
        head_sha: 'aaa',
      });
      const abandoned = store.getAbandonedCheckpoints(artifactId);
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0].reason).toBe('subagent timed out');
    });

    it('getStepClaims unions completed_step_ids across closed cps and reports open declared steps', () => {
      store.upsertCheckpoint({
        status: 'closed',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1', 'step-2'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        closed_at: '2026-04-25T12:30:00.000Z',
        summary: 'one',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: ['step-1', 'step-2'],
        head_sha: 'aaa',
      });
      store.upsertCheckpoint({
        status: 'open',
        artifact_id: artifactId,
        n: 2,
        declared_step_ids: ['step-3', 'step-4'],
        agent_session_id: 'subagent-b',
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:31:00.000Z',
        head_sha: 'bbb',
      });
      const claims = store.getStepClaims(artifactId);
      expect(claims.closedClaimed).toEqual(['step-1', 'step-2']);
      expect(claims.openDeclared).toEqual([{ n: 2, declared: ['step-3', 'step-4'] }]);
    });

    it('getStepClaims excludes abandoned cps from both buckets (declared steps released)', () => {
      store.upsertCheckpoint({
        status: 'abandoned',
        artifact_id: artifactId,
        n: 3,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        abandoned_at: '2026-04-25T12:30:00.000Z',
        reason: 'cancelled',
        head_sha: 'aaa',
      });
      const claims = store.getStepClaims(artifactId);
      expect(claims.closedClaimed).toEqual([]);
      expect(claims.openDeclared).toEqual([]);
    });

    it('nextCheckpointN returns max(n)+1 across every status', () => {
      expect(store.nextCheckpointN(artifactId)).toBe(1);
      store.upsertCheckpoint({
        status: 'open',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        head_sha: 'aaa',
      });
      expect(store.nextCheckpointN(artifactId)).toBe(2);
      store.upsertCheckpoint({
        status: 'abandoned',
        artifact_id: artifactId,
        n: 2,
        declared_step_ids: ['step-2'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:30:00.000Z',
        abandoned_at: '2026-04-25T12:31:00.000Z',
        reason: 'rescope',
        head_sha: 'aaa',
      });
      // Abandoned cp at n=2 still occupies the slot — next is 3.
      expect(store.nextCheckpointN(artifactId)).toBe(3);
    });

    it('upsertCheckpoint can transition a row from open to closed (close-time fields populated)', () => {
      store.upsertCheckpoint({
        status: 'open',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        head_sha: 'aaa',
      });
      expect(store.getOpenCheckpoints(artifactId)).toHaveLength(1);

      store.upsertCheckpoint({
        status: 'closed',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        closed_at: '2026-04-25T12:30:00.000Z',
        summary: 'finalized',
        files_changed: ['x'],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: ['step-1'],
        head_sha: 'bbb',
      });
      expect(store.getOpenCheckpoints(artifactId)).toHaveLength(0);
      expect(store.getClosedCheckpoints(artifactId)).toHaveLength(1);
    });

    it('enforces lifecycle-dependent checkpoint columns in SQLite', () => {
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO checkpoints (
               artifact_id, n, status, declared_step_ids, agent_session_id,
               policy_exceptions, plan_revision_id, opened_at, head_sha,
               closed_at, summary
             ) VALUES (?, ?, 'closed', '[]', NULL, '[]', NULL, ?, ?, NULL, NULL)`
          )
          .run(artifactId, 9, '2026-04-25T12:29:00.000Z', 'aaa')
      ).toThrow(/checkpoints_lifecycle_fields/);
    });

    it('rejects a malformed projected row instead of fabricating close fields', () => {
      store.upsertCheckpoint({
        status: 'closed',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        closed_at: '2026-04-25T12:30:00.000Z',
        summary: 'done',
        files_changed: [],
        decisions: [],
        uncertainty: [],
        done_criteria: [],
        completed_step_ids: [],
        head_sha: 'aaa',
      });
      store.db.pragma('ignore_check_constraints = ON');
      store.db
        .prepare('UPDATE checkpoints SET closed_at = NULL WHERE artifact_id = ? AND n = 1')
        .run(artifactId);

      expect(() => store.getCheckpoints(artifactId)).toThrow(
        'CLOSED row is missing close fields or contains abandon fields'
      );
    });

    it('policy_exceptions persists round-trip', () => {
      store.upsertCheckpoint({
        status: 'open',
        artifact_id: artifactId,
        n: 1,
        declared_step_ids: ['step-1', 'step-2', 'step-3', 'step-4', 'step-5'],
        agent_session_id: null,
        policy_exceptions: [{ evaluator: 'checkpoint-scope-density', reason: 'mechanical rename' }],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: '2026-04-25T12:29:00.000Z',
        head_sha: 'aaa',
      });
      const opens = store.getOpenCheckpoints(artifactId);
      expect(opens[0].policy_exceptions).toEqual([
        { evaluator: 'checkpoint-scope-density', reason: 'mechanical rename' },
      ]);
    });
  });

  describe('findArtifactsForCloudSyncDrain', () => {
    function seed(
      id: string,
      startedAt: string,
      cloud: { syncedAt: string | null; hash: string | null } = { syncedAt: null, hash: null }
    ): void {
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id,
        branch: 'main',
        task: id,
        agent: 'claude',
        base_sha: 'sha',
        started_at: startedAt,
        completed_at: null,
        status: 'active',
      });
      if (cloud.syncedAt && cloud.hash) {
        store.setCloudSyncState(id, {
          syncedAt: cloud.syncedAt,
          hash: cloud.hash,
          externalId: 't_' + id,
          orgId: 'org_1',
        });
      }
    }

    function usageSnapshot(opts: {
      snapshotId: string;
      artifactId: string | null;
      ts: string;
      sessionId?: string;
      sourcePlanRefId?: string | null;
      cumulative?: number;
    }): Parameters<typeof store.insertUsageSnapshot>[0] {
      const cumulative = opts.cumulative ?? 1;
      return {
        snapshot_id: opts.snapshotId,
        idempotency_key: `${opts.snapshotId}-key`,
        artifact_id: opts.artifactId,
        source_plan_ref_id: opts.sourcePlanRefId ?? null,
        agent: 'codex',
        session_id: opts.sessionId ?? 'session',
        lifecycle_event: 'checkpoint_close',
        checkpoint_n: 1,
        cumulative_input_tokens: cumulative,
        cumulative_output_tokens: cumulative,
        cumulative_cache_creation_input_tokens: 0,
        cumulative_cache_read_input_tokens: 0,
        delta_input_tokens: cumulative,
        delta_output_tokens: cumulative,
        delta_cache_creation_input_tokens: 0,
        delta_cache_read_input_tokens: 0,
        baseline_kind: 'prior_same_artifact',
        model_breakdown: '[]',
        dimensions: '{}',
        record_count: 1,
        as_of: opts.ts,
        ts: opts.ts,
      };
    }

    it('does NOT re-drain a fully-synced recent artifact', () => {
      // A recently-started artifact whose cloud sync is current (no checkpoint
      // or summary newer than the sync) has nothing to push. Recency alone must
      // not be a drain reason, else every artifact < 7 days old is perpetually
      // re-drained regardless of sync state.
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('a', recent, { syncedAt: recent, hash: 'h' });
      const { included: ids } = store.findArtifactsForCloudSyncDrain();
      expect(ids).not.toContain('a');
    });

    it('returns never-synced artifacts even when started outside the window', () => {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      seed('b', ancient);
      const { included: ids } = store.findArtifactsForCloudSyncDrain({});
      expect(ids).toContain('b');
    });

    it('omits ancient + already-synced artifacts', () => {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      seed('c', ancient, { syncedAt: ancient, hash: 'h' });
      const { included: ids } = store.findArtifactsForCloudSyncDrain({});
      expect(ids).not.toContain('c');
    });

    it('respects the limit and orders by started_at desc', () => {
      for (let i = 0; i < 5; i++) {
        const ts = new Date(Date.now() - i * 60_000).toISOString();
        seed(`d_${i}`, ts);
      }
      const { included: ids } = store.findArtifactsForCloudSyncDrain({ limit: 3 });
      expect(ids).toHaveLength(3);
      expect(ids).toEqual(['d_0', 'd_1', 'd_2']);
    });

    it('includes artifacts whose checkpoint activity is newer than the last cloud sync', () => {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('long', ancient, { syncedAt: ancient, hash: 'h' });
      store.upsertCheckpoint({
        artifact_id: 'long',
        n: 1,
        status: 'open',
        declared_step_ids: ['s1'],
        agent_session_id: null,
        policy_exceptions: [],
        plan_revision_id: null,
        open_plan_revision_event_id: null,
        opened_at: recent,
        head_sha: 'sha',
      });
      const { included: ids } = store.findArtifactsForCloudSyncDrain({});
      expect(ids).toContain('long');
    });

    it('includes artifacts whose summary is newer than the last cloud sync', () => {
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('summed', ancient, { syncedAt: ancient, hash: 'h' });
      store.upsertSummary({
        artifact_id: 'summed',
        outcome: 'success',
        tests_written: [],
        tests_run: [],
        open_items: [],
        ts: recent,
      });
      const { included: ids } = store.findArtifactsForCloudSyncDrain({});
      expect(ids).toContain('summed');
    });

    it('orders never-synced artifacts ahead of already-synced ones at the limit boundary', () => {
      // 3 fresh-but-synced (would dominate by started_at DESC alone) plus 1
      // ancient-but-never-synced. With limit:3 the never-synced row must
      // still make it in.
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const ts = new Date(now - i * 1000).toISOString();
        seed(`fresh_${i}`, ts, { syncedAt: ts, hash: 'h' });
      }
      const ancient = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      seed('never', ancient);
      const { included: ids } = store.findArtifactsForCloudSyncDrain({ limit: 3 });
      expect(ids).toContain('never');
    });

    it('skips artifacts inside their backoff window (cf=1 → 30s)', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('z', recent);
      // Simulate one recorded failure 10 seconds ago — backoff for cf=1 is
      // 30s, so the artifact should still be gated.
      const tenSecAgo = new Date(Date.now() - 10_000).toISOString();
      store.recordCloudSyncFailure('z', {
        kind: 'http-5xx',
        message: 'cloud said no',
        attemptedAt: tenSecAgo,
        attemptStartedAt: tenSecAgo,
      });
      const { included: ids } = store.findArtifactsForCloudSyncDrain({
        nowOverride: new Date().toISOString(),
      });
      expect(ids).not.toContain('z');
    });

    it('includes artifacts whose backoff window has elapsed (cf=1 + 31s ago)', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('z', recent);
      const thirtyOneSecAgo = new Date(Date.now() - 31_000).toISOString();
      store.recordCloudSyncFailure('z', {
        kind: 'http-5xx',
        message: 'cloud said no',
        attemptedAt: thirtyOneSecAgo,
        attemptStartedAt: thirtyOneSecAgo,
      });
      const { included: ids } = store.findArtifactsForCloudSyncDrain({
        nowOverride: new Date().toISOString(),
      });
      expect(ids).toContain('z');
    });

    it('caps backoff at 1h: cf=20 with attempt 1h+1s ago is included', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('z', recent);
      // Inflate consecutive_failures to 20 directly. The backoff math caps
      // the delay at 3600s, so an attempt 1h+1s ago should pass the gate.
      const longAgo = new Date(Date.now() - 3601_000).toISOString();
      for (let i = 0; i < 20; i++) {
        store.recordCloudSyncFailure('z', {
          kind: 'http-5xx',
          message: null,
          attemptedAt: longAgo,
          attemptStartedAt: longAgo,
        });
      }
      const { included: ids } = store.findArtifactsForCloudSyncDrain({
        nowOverride: new Date().toISOString(),
      });
      expect(ids).toContain('z');
    });

    it('force=true bypasses the backoff filter even mid-window', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('z', recent);
      const now = new Date().toISOString();
      store.recordCloudSyncFailure('z', {
        kind: 'http-5xx',
        message: 'cloud said no',
        attemptedAt: now,
        attemptStartedAt: now,
      });
      const { included: idsForced } = store.findArtifactsForCloudSyncDrain({
        force: true,
        nowOverride: new Date().toISOString(),
      });
      expect(idsForced).toContain('z');
    });

    // ─── Cross-tenant guard (orgIdFilter) ────────────────────────────────
    //
    // post-login `flushPendingPushes` passes the just-authenticated org id
    // through here so the drain doesn't silently re-push a capture that
    // was previously sent to a DIFFERENT org. Fresh artifacts (never
    // pushed; `cloud_org_id IS NULL`) MUST still be drained — cloud-side
    // tenancy on captureThread.create gates those at create time.

    it('excludes rows whose cloud_org_id differs from orgIdFilter and surfaces the count', () => {
      const now = '2026-05-22T10:00:00.000Z';
      for (const id of ['org-a-row', 'org-b-row', 'fresh-row']) {
        store.upsertArtifact({
          label: 'test-label',
          non_goals: '[]',
          id,
          branch: 'main',
          task: id,
          agent: 'claude',
          base_sha: 'deadbeef',
          started_at: now,
          completed_at: null,
          status: 'active',
        });
      }
      store.setCloudSyncState('org-a-row', {
        syncedAt: now,
        hash: 'h1',
        externalId: 't1',
        orgId: 'org-A',
      });
      store.setCloudSyncState('org-b-row', {
        syncedAt: now,
        hash: 'h2',
        externalId: 't2',
        orgId: 'org-B',
      });
      // Make the two synced rows genuine drain candidates: a summary after the
      // sync makes them stale. (Recency alone is no longer a drain reason.)
      const later = '2026-05-22T10:00:00.500Z';
      for (const id of ['org-a-row', 'org-b-row']) {
        store.upsertSummary({
          artifact_id: id,
          outcome: 'success',
          tests_written: [],
          tests_run: [],
          open_items: [],
          ts: later,
        });
      }

      const result = store.findArtifactsForCloudSyncDrain({
        orgIdFilter: 'org-A',
        nowOverride: '2026-05-22T10:00:01.000Z',
      });

      expect(result.included).toContain('org-a-row');
      expect(result.included).toContain('fresh-row');
      expect(result.included).not.toContain('org-b-row');
      expect(result.excludedForeignOrg).toBe(1);
    });

    it('applies organization eligibility before the limit', () => {
      const syncedAt = '2026-05-22T10:00:00.000Z';
      const activityAt = '2026-05-22T10:01:00.000Z';
      for (let i = 0; i < 3; i++) {
        const id = `foreign-${i}`;
        seed(id, `2026-05-22T10:00:0${i + 2}.000Z`, { syncedAt, hash: `h-${id}` });
        store.db.prepare(`UPDATE artifacts SET cloud_org_id = 'org-B' WHERE id = ?`).run(id);
        store.upsertSummary({
          artifact_id: id,
          outcome: 'success',
          tests_written: [],
          tests_run: [],
          open_items: [],
          ts: activityAt,
        });
      }
      seed('eligible', '2026-05-22T10:00:01.000Z', { syncedAt, hash: 'h-eligible' });
      store.upsertSummary({
        artifact_id: 'eligible',
        outcome: 'success',
        tests_written: [],
        tests_run: [],
        open_items: [],
        ts: activityAt,
      });

      const result = store.findArtifactsForCloudSyncDrain({
        orgIdFilter: 'org_1',
        limit: 1,
        force: true,
      });
      expect(result.included).toEqual(['eligible']);
      expect(result.excludedForeignOrg).toBe(3);
    });

    it('recognizes every cloud-bearing post-sync activity family and recorded failures', () => {
      const syncedAt = '2026-05-22T10:00:00.000Z';
      const activityAt = '2026-05-22T10:01:00.000Z';
      for (const id of ['plan', 'evaluator', 'disposition', 'usage', 'link', 'failure']) {
        seed(id, '2026-05-22T09:00:00.000Z', { syncedAt, hash: `h-${id}` });
      }
      store.upsertPlanRevision({
        plan: {
          artifact_id: 'plan',
          revision_n: 1,
          captured_at: activityAt,
          label: 'revised',
          rationale: 'post-sync revision',
          touched_scope: '[]',
          non_goals: '[]',
          decisions: '[]',
          step_lineage: '{}',
          criterion_lineage: '{}',
          prior_event_id: null,
          source_event_id: 'plan-event',
        },
        steps: [],
      });
      store.insertEvaluatorRun({
        run_id: 'post-sync-run',
        artifact_id: 'evaluator',
        evaluator_ref: 'core/example',
        package_id: 'core',
        evaluator_id: 'example',
        phase: 'pre-pr',
        severity: 'warn',
        run_status: 'completed',
        verdict: 'pass',
        body: 'PASS',
        raw: null,
        metrics: null,
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        cost_usd: null,
        duration_ms: 1,
        checkpoint_n: null,
        error_code: null,
        error_message: null,
        ts: activityAt,
        disposition: null,
        source_event_index: 1,
        local_kind_rank: 0,
        local_index: 0,
      });
      store.insertEvaluatorRun({
        run_id: 'post-sync-disposition-run',
        artifact_id: 'disposition',
        evaluator_ref: 'core/example',
        package_id: 'core',
        evaluator_id: 'example',
        phase: 'pre-pr',
        severity: 'warn',
        run_status: 'completed',
        verdict: 'violation',
        body: 'VIOLATION',
        raw: null,
        metrics: null,
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        cost_usd: null,
        duration_ms: 1,
        checkpoint_n: null,
        error_code: null,
        error_message: null,
        ts: '2026-05-22T09:59:00.000Z',
        disposition: 'unresolved',
        source_event_index: 1,
        local_kind_rank: 0,
        local_index: 0,
      });
      store.insertEvaluatorDisposition({
        disposition_id: 'post-sync-disposition',
        artifact_id: 'disposition',
        run_id: 'post-sync-disposition-run',
        evaluator_ref: 'core/example',
        disposition: 'acknowledged',
        reason: 'accepted',
        agent_session_id: null,
        ts: activityAt,
        source_event_index: 2,
        local_kind_rank: 1,
        local_index: 0,
      });
      store.insertUsageSnapshot(
        usageSnapshot({ snapshotId: 'post-sync-usage', artifactId: 'usage', ts: activityAt })
      );
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'pre-sync-link-usage',
          artifactId: 'link',
          ts: '2026-05-22T09:59:00.000Z',
        })
      );
      store.setCloudSyncState('link', {
        syncedAt,
        hash: 'h-link',
        externalId: 't_link',
        orgId: 'org_1',
      });
      store.applySourcePlanLink({
        source_plan_ref_id: 'cloud:plan@1',
        artifact_id: 'link',
        linked_at: activityAt,
        pinned_version: '1',
      });
      store.recordCloudSyncFailure('failure', {
        kind: 'network',
        message: 'retry me',
        attemptedAt: activityAt,
        attemptStartedAt: activityAt,
      });

      const included = store.findArtifactsForCloudSyncDrain({ force: true }).included;
      expect(included).toEqual(
        expect.arrayContaining(['plan', 'evaluator', 'disposition', 'usage', 'link', 'failure'])
      );
      for (const id of ['plan', 'evaluator', 'disposition', 'usage', 'link', 'failure']) {
        expect(store.getCloudSyncStateForArtifact(id)?.pending).toBe(true);
      }
    });

    it('re-drains an artifact when a backdated session high-water advances elsewhere', () => {
      const syncedAt = '2026-05-22T10:00:00.000Z';
      seed('session-origin', '2026-05-22T09:00:00.000Z');
      seed('session-later', '2026-05-22T09:00:00.000Z', {
        syncedAt,
        hash: 'h-later',
      });
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'session-origin-before-sync',
          artifactId: 'session-origin',
          sessionId: 'shared-session',
          ts: '2026-05-22T09:59:00.000Z',
        })
      );
      store.setCloudSyncState('session-origin', {
        syncedAt,
        hash: 'h-origin',
        externalId: 't_session-origin',
        orgId: 'org_1',
      });
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'session-later-after-sync',
          artifactId: 'session-later',
          sessionId: 'shared-session',
          cumulative: 2,
          ts: '2026-05-22T09:58:00.000Z',
        })
      );

      expect(store.findArtifactsForCloudSyncDrain({ force: true }).included).toContain(
        'session-origin'
      );
      expect(store.getCloudSyncStateForArtifact('session-origin')?.pending).toBe(true);
      expect(store.getCloudSyncState('session-origin')?.syncedAt).toBe(syncedAt);
      expect(store.getCloudSyncState('session-origin')?.hash).toBe('h-origin');
      const dirtyHash = store.db
        .prepare(`SELECT cloud_sync_hash AS hash FROM artifacts WHERE id = 'session-origin'`)
        .get() as { hash: string };
      expect(dirtyHash.hash).toMatch(/^dirty:[^:]+:h-origin$/);

      store.setCloudSyncState('session-origin', {
        syncedAt: '2026-05-22T10:02:00.000Z',
        hash: 'h-origin-current',
        externalId: 't_session-origin',
        orgId: 'org_1',
      });
      expect(store.getCloudSyncStateForArtifact('session-origin')?.pending).toBe(false);
      expect(store.getCloudSyncState('session-origin')?.hash).toBe('h-origin-current');
    });

    it('proves token rotation replaces the removed global usage scan', () => {
      const syncedAt = '2026-05-22T10:00:00.000Z';
      seed('guard-origin', '2026-05-22T09:00:00.000Z');
      seed('guard-writer', '2026-05-22T09:00:00.000Z', {
        syncedAt,
        hash: 'h-guard-writer',
      });
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'guard-origin-seed',
          artifactId: 'guard-origin',
          sessionId: 'guard-session',
          ts: '2026-05-22T09:00:00.000Z',
        })
      );
      store.setCloudSyncState('guard-origin', {
        syncedAt,
        hash: 'h-guard-origin',
        externalId: 't-guard-origin',
        orgId: 'org_1',
      });

      const disabled = vi.spyOn(store, 'rotateCloudSyncTokensForUsageSession').mockReturnValue(0);
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'guard-disabled',
          artifactId: 'guard-writer',
          sessionId: 'guard-session',
          cumulative: 2,
          ts: '2026-05-22T09:01:00.000Z',
        })
      );
      expect(store.getCloudSyncStateForArtifact('guard-origin')?.pending).toBe(false);
      disabled.mockRestore();

      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'guard-enabled',
          artifactId: 'guard-writer',
          sessionId: 'guard-session',
          cumulative: 3,
          ts: '2026-05-22T09:02:00.000Z',
        })
      );
      expect(store.getCloudSyncStateForArtifact('guard-origin')?.pending).toBe(true);
    });

    it('rotates exactly the direct, shared-session, and linked attribution set', () => {
      const syncedAt = '2026-05-22T10:00:00.000Z';
      for (const id of ['direct', 'shared', 'linked', 'unrelated']) {
        seed(id, '2026-05-22T09:00:00.000Z', { syncedAt, hash: `h-${id}` });
      }
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'direct-seed',
          artifactId: 'direct',
          sessionId: 'affected-session',
          sourcePlanRefId: null,
          ts: '2026-05-22T09:00:00.000Z',
        })
      );
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'shared-seed',
          artifactId: 'shared',
          sessionId: 'affected-session',
          sourcePlanRefId: null,
          ts: '2026-05-22T09:00:00.000Z',
        })
      );
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'linked-seed',
          artifactId: null,
          sessionId: 'affected-session',
          sourcePlanRefId: 'cloud:affected@1',
          ts: '2026-05-22T09:00:00.000Z',
        })
      );
      store.applySourcePlanLink({
        source_plan_ref_id: 'cloud:affected@1',
        artifact_id: 'linked',
        linked_at: '2026-05-22T09:30:00.000Z',
        pinned_version: '1',
      });
      for (const id of ['direct', 'shared', 'linked']) {
        store.setCloudSyncState(id, {
          syncedAt,
          hash: `h-${id}`,
          externalId: `t-${id}`,
          orgId: 'org_1',
        });
      }

      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'direct-advance',
          artifactId: 'direct',
          sessionId: 'affected-session',
          cumulative: 2,
          sourcePlanRefId: null,
          ts: '2026-05-22T09:01:00.000Z',
        })
      );

      for (const id of ['direct', 'shared', 'linked']) {
        expect(store.getCloudSyncRawHash(id)).toMatch(new RegExp(`^dirty:[^:]+:h-${id}$`));
      }
      expect(store.getCloudSyncRawHash('unrelated')).toBe('h-unrelated');
    });

    it('reapplies usage invalidation when rebuild already projected the same snapshot', () => {
      const snapshot = usageSnapshot({
        snapshotId: 'rebuild-race-snapshot',
        artifactId: 'rebuild-race',
        sessionId: 'rebuild-race-session',
        cumulative: 2,
        ts: '2026-05-22T09:58:00.000Z',
      });
      store.insertUsageSnapshot(snapshot);
      const syncedAt = '2026-05-22T10:00:00.000Z';
      seed('rebuild-race', '2026-05-22T09:00:00.000Z', {
        syncedAt,
        hash: 'h-rebuild-race',
      });

      store.insertUsageSnapshot(snapshot);

      expect(store.getCloudSyncStateForArtifact('rebuild-race')?.pending).toBe(true);
      expect(store.getCloudSyncState('rebuild-race')?.syncedAt).toBe(syncedAt);
      const row = store.db
        .prepare(`SELECT cloud_sync_hash AS hash FROM artifacts WHERE id = 'rebuild-race'`)
        .get() as { hash: string };
      expect(row.hash).toMatch(/^dirty:[^:]+:h-rebuild-race$/);
      store.insertUsageSnapshot(snapshot);
      expect(store.getCloudSyncRawHash('rebuild-race')).not.toBe(row.hash);
    });

    it('does not mark a links-only artifact pending when the link is absent from the wire', () => {
      const syncedAt = '2026-05-22T10:00:00.000Z';
      seed('links-only', '2026-05-22T09:00:00.000Z', {
        syncedAt,
        hash: 'h-links-only',
      });
      store.insertUsageSnapshot(
        usageSnapshot({
          snapshotId: 'after-link-bound',
          artifactId: null,
          sourcePlanRefId: 'cloud:links-only@1',
          ts: '2026-05-22T10:02:00.000Z',
        })
      );
      store.applySourcePlanLink({
        source_plan_ref_id: 'cloud:links-only@1',
        artifact_id: 'links-only',
        linked_at: '2026-05-22T10:01:00.000Z',
        pinned_version: '1',
      });

      expect(store.getCloudSyncStateForArtifact('links-only')?.pending).toBe(false);
      expect(store.findArtifactsForCloudSyncDrain({ force: true }).included).not.toContain(
        'links-only'
      );
    });

    it('reports excludedForeignOrg: 0 when no orgIdFilter is supplied (backwards compat)', () => {
      const now = '2026-05-22T10:00:00.000Z';
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id: 'plain-drain',
        branch: 'main',
        task: 'plain-drain',
        agent: 'claude',
        base_sha: 'deadbeef',
        started_at: now,
        completed_at: null,
        status: 'active',
      });
      const result = store.findArtifactsForCloudSyncDrain();
      expect(result.included).toContain('plain-drain');
      expect(result.excludedForeignOrg).toBe(0);
    });
  });

  describe('recordCloudSyncFailure', () => {
    function seed(id: string): void {
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id,
        branch: 'main',
        task: id,
        agent: 'claude',
        base_sha: 'sha',
        started_at: new Date().toISOString(),
        completed_at: null,
        status: 'active',
      });
    }

    it('persists kind, message, and attempt timestamp on failure', () => {
      seed('f');
      const at = new Date().toISOString();
      store.recordCloudSyncFailure('f', {
        kind: 'http-5xx',
        message: 'cloud broke',
        attemptedAt: at,
        attemptStartedAt: at,
      });
      const row = store.db
        .prepare(
          `SELECT cloud_last_push_attempt_at, cloud_last_push_error_kind,
                  cloud_last_push_error_message, cloud_consecutive_failures
           FROM artifacts WHERE id = 'f'`
        )
        .get() as {
        cloud_last_push_attempt_at: string;
        cloud_last_push_error_kind: string;
        cloud_last_push_error_message: string;
        cloud_consecutive_failures: number;
      };
      expect(row.cloud_last_push_attempt_at).toBe(at);
      expect(row.cloud_last_push_error_kind).toBe('http-5xx');
      expect(row.cloud_last_push_error_message).toBe('cloud broke');
      expect(row.cloud_consecutive_failures).toBe(1);
    });

    it('atomically increments consecutive_failures across repeated calls', () => {
      seed('g');
      for (let i = 0; i < 5; i++) {
        const now = new Date().toISOString();
        store.recordCloudSyncFailure('g', {
          kind: 'timeout',
          message: null,
          attemptedAt: now,
          attemptStartedAt: now,
        });
      }
      const row = store.db
        .prepare(`SELECT cloud_consecutive_failures FROM artifacts WHERE id = 'g'`)
        .get() as { cloud_consecutive_failures: number };
      expect(row.cloud_consecutive_failures).toBe(5);
    });

    it('does not clobber a successful push that landed mid-attempt (race guard)', () => {
      // Simulates: process B started an eager push at T_start. While B's
      // push was in-flight, process A pushed the same artifact and won —
      // setCloudSyncState landed at T_success > T_start. B's push then
      // failed and now wants to record. The guard
      // (cloud_synced_at < @attemptStartedAt) must drop B's failure write
      // because the artifact is genuinely synced.
      seed('race');
      const tStart = new Date(Date.now() - 5_000).toISOString();
      const tSuccess = new Date(Date.now() - 1_000).toISOString();
      // A's success lands first.
      store.setCloudSyncState('race', {
        syncedAt: tSuccess,
        hash: 'h1',
        externalId: 't_race',
        orgId: 'org',
      });
      // B's stale failure tries to land, with attemptStartedAt < tSuccess.
      store.recordCloudSyncFailure('race', {
        kind: 'network',
        message: 'connection reset',
        attemptedAt: new Date().toISOString(),
        attemptStartedAt: tStart,
      });
      const row = store.db
        .prepare(
          `SELECT cloud_synced_at, cloud_last_push_error_kind, cloud_consecutive_failures
           FROM artifacts WHERE id = 'race'`
        )
        .get() as {
        cloud_synced_at: string;
        cloud_last_push_error_kind: string | null;
        cloud_consecutive_failures: number;
      };
      expect(row.cloud_synced_at).toBe(tSuccess);
      expect(row.cloud_last_push_error_kind).toBeNull();
      expect(row.cloud_consecutive_failures).toBe(0);
    });

    it('does not let a stale success overwrite a newer success (setCloudSyncState guard)', () => {
      // Two concurrent successful pushes: A finishes first with syncedAt=T1,
      // B finishes second but with a stale syncedAt=T0 < T1 (clocks aligned,
      // B captured its timestamp before A's success landed). B's write must
      // not roll back `cloud_sync_hash` to the older value — otherwise the
      // next drain's hash-dedup check would see the stale hash and trigger
      // a spurious re-push.
      seed('dual');
      const t0 = new Date(Date.now() - 2_000).toISOString();
      const t1 = new Date(Date.now() - 1_000).toISOString();
      store.setCloudSyncState('dual', {
        syncedAt: t1,
        hash: 'newer',
        externalId: 't_dual',
        orgId: 'org',
      });
      // Stale success arrives second — should be rejected by the guard.
      store.setCloudSyncState('dual', {
        syncedAt: t0,
        hash: 'older',
        externalId: 't_dual',
        orgId: 'org',
      });
      const row = store.db
        .prepare(`SELECT cloud_synced_at, cloud_sync_hash FROM artifacts WHERE id = 'dual'`)
        .get() as { cloud_synced_at: string; cloud_sync_hash: string };
      expect(row.cloud_synced_at).toBe(t1);
      expect(row.cloud_sync_hash).toBe('newer');
    });

    it('records a failure that began AFTER the last successful sync (legitimate retry)', () => {
      // Sequential: success at T1, then later attempt at T2 > T1 fails.
      // attemptStartedAt = T2 > cloud_synced_at = T1, so the guard passes
      // and the failure is recorded normally.
      seed('seq');
      const t1 = new Date(Date.now() - 60_000).toISOString();
      const t2 = new Date(Date.now() - 1_000).toISOString();
      store.setCloudSyncState('seq', {
        syncedAt: t1,
        hash: 'h1',
        externalId: 't_seq',
        orgId: 'org',
      });
      store.recordCloudSyncFailure('seq', {
        kind: 'http-5xx',
        message: 'cloud broke',
        attemptedAt: new Date().toISOString(),
        attemptStartedAt: t2,
      });
      const row = store.db
        .prepare(
          `SELECT cloud_last_push_error_kind, cloud_consecutive_failures
           FROM artifacts WHERE id = 'seq'`
        )
        .get() as { cloud_last_push_error_kind: string | null; cloud_consecutive_failures: number };
      expect(row.cloud_last_push_error_kind).toBe('http-5xx');
      expect(row.cloud_consecutive_failures).toBe(1);
    });

    it('setCloudSyncState clears failure state on a successful push', () => {
      seed('h');
      // Accumulate three failures …
      for (let i = 0; i < 3; i++) {
        const now = new Date().toISOString();
        store.recordCloudSyncFailure('h', {
          kind: 'network',
          message: 'eof',
          attemptedAt: now,
          attemptStartedAt: now,
        });
      }
      // … then a successful push lands.
      const at = new Date().toISOString();
      store.setCloudSyncState('h', { syncedAt: at, hash: 'h1', externalId: 't_h', orgId: 'org' });
      const row = store.db
        .prepare(
          `SELECT cloud_last_push_attempt_at, cloud_last_push_error_kind,
                  cloud_last_push_error_message, cloud_consecutive_failures
           FROM artifacts WHERE id = 'h'`
        )
        .get() as {
        cloud_last_push_attempt_at: string;
        cloud_last_push_error_kind: string | null;
        cloud_last_push_error_message: string | null;
        cloud_consecutive_failures: number;
      };
      expect(row.cloud_last_push_attempt_at).toBe(at);
      expect(row.cloud_last_push_error_kind).toBeNull();
      expect(row.cloud_last_push_error_message).toBeNull();
      expect(row.cloud_consecutive_failures).toBe(0);
    });
  });

  describe('getCloudSyncPendingArtifacts', () => {
    function seed(id: string, startedAt: string, syncedAt?: string): void {
      store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id,
        branch: 'main',
        task: id,
        agent: 'claude',
        base_sha: 'sha',
        started_at: startedAt,
        completed_at: null,
        status: 'active',
      });
      if (syncedAt) {
        store.setCloudSyncState(id, {
          syncedAt,
          hash: 'h_' + id,
          externalId: 't_' + id,
          orgId: 'org',
        });
      }
    }

    it('returns rich rows with full failure state (and SQL-computed next_attempt_at)', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('p', recent);
      store.recordCloudSyncFailure('p', {
        kind: 'http-5xx',
        message: 'cloud broke',
        attemptedAt: recent,
        attemptStartedAt: recent,
      });
      const rows = store.getCloudSyncPendingArtifacts();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id).toBe('p');
      expect(row.cloud_consecutive_failures).toBe(1);
      expect(row.cloud_last_push_error_kind).toBe('http-5xx');
      expect(row.next_attempt_at).not.toBeNull();
      // cf=1 → 30s after attemptedAt = recent + 30s.
      const nextMs = Date.parse(row.next_attempt_at!);
      expect(nextMs - Date.parse(recent)).toBeGreaterThanOrEqual(30_000 - 100);
      expect(nextMs - Date.parse(recent)).toBeLessThanOrEqual(30_000 + 100);
    });

    it('does not apply the backoff filter (returns artifacts in their backoff window)', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('p', recent);
      const now = new Date().toISOString();
      store.recordCloudSyncFailure('p', {
        kind: 'http-5xx',
        message: 'cloud broke',
        attemptedAt: now,
        attemptStartedAt: now,
      });
      // Drain (with backoff) skips it; the push-status surface shows it anyway.
      const { included: drained } = store.findArtifactsForCloudSyncDrain({
        nowOverride: new Date().toISOString(),
      });
      expect(drained).not.toContain('p');
      const pending = store.getCloudSyncPendingArtifacts();
      expect(pending.map((r) => r.id)).toContain('p');
    });

    it('next_attempt_at is null for never-failed artifacts', () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      seed('q', recent);
      const rows = store.getCloudSyncPendingArtifacts();
      const q = rows.find((r) => r.id === 'q');
      expect(q?.cloud_consecutive_failures).toBe(0);
      expect(q?.next_attempt_at).toBeNull();
    });

    it('omits a recent artifact synced AFTER its summary', () => {
      // plan -> summary -> push, with the sync landing after the summary, so
      // the artifact is fully caught up. Recency alone must not keep it
      // "pending", else status/doctor never show 0 within the window.
      const started = new Date(Date.now() - 120_000).toISOString();
      const summaryTs = new Date(Date.now() - 90_000).toISOString();
      const syncedAfter = new Date(Date.now() - 60_000).toISOString();
      seed('done', started);
      store.upsertSummary({
        artifact_id: 'done',
        outcome: 'success',
        tests_written: [],
        tests_run: [],
        open_items: [],
        ts: summaryTs,
      });
      store.setCloudSyncState('done', {
        syncedAt: syncedAfter,
        hash: 'h_done',
        externalId: 't_done',
        orgId: 'org',
      });
      const ids = store.getCloudSyncPendingArtifacts().map((r) => r.id);
      expect(ids).not.toContain('done');
    });
  });

  describe('evaluator runs + dispositions (protocol-aligned)', () => {
    const ARTIFACT_ID = '01HXART0000000000000000000';

    beforeEach(() => {
      store.db.exec(
        `INSERT INTO artifacts (id, branch, task, label, agent, base_sha, started_at, completed_at, status, non_goals)
         VALUES ('${ARTIFACT_ID}', 'main', 'evaluator fixture', 'eval-fx', 'claude', 'deadbeef', '2026-05-12T20:00:00.000Z', NULL, 'active', '[]')`
      );
    });

    function baseRunRow(overrides: Partial<Parameters<typeof store.insertEvaluatorRun>[0]> = {}) {
      return {
        run_id: '01HXRUN0000000000000000000',
        artifact_id: ARTIFACT_ID,
        evaluator_ref: 'core/api-stability',
        package_id: 'core',
        evaluator_id: 'api-stability',
        phase: 'checkpoint-close',
        severity: 'block',
        run_status: 'completed' as const,
        verdict: 'violation' as const,
        body: 'VIOLATION\n\nbreaks src/api/foo.ts',
        raw: JSON.stringify({ removed: ['fooFn'] }),
        metrics: JSON.stringify({ scanned_files: 12 }),
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        cost_usd: null,
        duration_ms: 41,
        checkpoint_n: 2,
        error_code: null,
        error_message: null,
        ts: '2026-05-12T20:30:00.000Z',
        disposition: 'unresolved' as const,
        source_event_index: 4,
        local_kind_rank: 0 as const,
        local_index: 0,
        ...overrides,
      };
    }

    function baseDispositionRow(
      overrides: Partial<Parameters<typeof store.insertEvaluatorDisposition>[0]> = {}
    ) {
      return {
        disposition_id: '01HXDIS0000000000000000000',
        artifact_id: ARTIFACT_ID,
        run_id: '01HXRUN0000000000000000000',
        evaluator_ref: 'core/api-stability',
        disposition: 'acknowledged' as const,
        reason: 'breaking change deliberate; see ADR-014',
        agent_session_id: null,
        ts: '2026-05-12T20:35:00.000Z',
        source_event_index: 5,
        local_kind_rank: 1 as const,
        local_index: 0,
        ...overrides,
      };
    }

    it('insertEvaluatorRun stores every materialized column', () => {
      store.insertEvaluatorRun(baseRunRow({ provider: 'claude', model: 'claude-opus-5[1m]' }));
      const rows = store.listEvaluatorRuns(ARTIFACT_ID);
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.run_id).toBe('01HXRUN0000000000000000000');
      expect(r.evaluator_ref).toBe('core/api-stability');
      expect(r.package_id).toBe('core');
      expect(r.run_status).toBe('completed');
      expect(r.verdict).toBe('violation');
      expect(r.provider).toBe('claude');
      expect(r.model).toBe('claude-opus-5[1m]');
      expect(r.disposition).toBe('unresolved');
      expect(r.source_event_index).toBe(4);
      expect(r.local_kind_rank).toBe(0);
      expect(JSON.parse(r.raw ?? '{}')).toEqual({ removed: ['fooFn'] });
      expect(JSON.parse(r.metrics ?? '{}')).toEqual({ scanned_files: 12 });
    });

    it('listEvaluatorRuns returns rows in order_key order, not ts order', () => {
      // Two events at the same ts; their ordering must come from
      // (source_event_index, local_kind_rank, local_index).
      const ts = '2026-05-12T20:30:00.000Z';
      store.insertEvaluatorRun(
        baseRunRow({
          run_id: 'second',
          source_event_index: 7,
          local_index: 0,
          ts,
        })
      );
      store.insertEvaluatorRun(
        baseRunRow({
          run_id: 'first',
          source_event_index: 5,
          local_index: 0,
          ts,
        })
      );
      store.insertEvaluatorRun(
        baseRunRow({
          run_id: 'first-second-unfold',
          source_event_index: 5,
          local_index: 1,
          ts,
        })
      );
      const ordered = store.listEvaluatorRuns(ARTIFACT_ID).map((r) => r.run_id);
      expect(ordered).toEqual(['first', 'first-second-unfold', 'second']);
    });

    it('CHECK constraint rejects local_kind_rank != 0 on a run', () => {
      expect(() => store.insertEvaluatorRun(baseRunRow({ local_kind_rank: 1 as 0 }))).toThrow(
        /local_kind_rank/
      );
    });

    it('CHECK constraint rejects an invalid disposition value', () => {
      expect(() =>
        store.insertEvaluatorRun(baseRunRow({ disposition: 'forgotten' as 'unresolved' }))
      ).toThrow(/disposition/);
    });

    it('insertEvaluatorDisposition writes the disposition row AND updates the run column atomically', () => {
      store.insertEvaluatorRun(baseRunRow());
      store.insertEvaluatorDisposition(baseDispositionRow());

      const runs = store.listEvaluatorRuns(ARTIFACT_ID);
      const dispositions = store.listEvaluatorDispositions(ARTIFACT_ID);
      expect(runs[0].disposition).toBe('acknowledged');
      expect(dispositions).toHaveLength(1);
      expect(dispositions[0].disposition).toBe('acknowledged');
    });

    it('insertEvaluatorDisposition FK-constraints against a missing run_id', () => {
      // No run inserted — the FK reference should fail.
      expect(() => store.insertEvaluatorDisposition(baseDispositionRow())).toThrow(/FOREIGN KEY/);
    });

    it('CHECK constraint rejects local_kind_rank != 1 on a disposition', () => {
      store.insertEvaluatorRun(baseRunRow());
      expect(() =>
        store.insertEvaluatorDisposition(baseDispositionRow({ local_kind_rank: 0 as 1 }))
      ).toThrow(/local_kind_rank/);
    });

    it('listEvaluatorDispositions returns rows in order_key order', () => {
      store.insertEvaluatorRun(baseRunRow());
      store.insertEvaluatorRun(
        baseRunRow({ run_id: 'r2', source_event_index: 10, local_index: 0 })
      );
      store.insertEvaluatorDisposition(
        baseDispositionRow({
          disposition_id: 'd-late',
          source_event_index: 12,
          local_index: 0,
        })
      );
      store.insertEvaluatorDisposition(
        baseDispositionRow({
          disposition_id: 'd-early',
          source_event_index: 6,
          local_index: 0,
        })
      );
      const ids = store.listEvaluatorDispositions(ARTIFACT_ID).map((d) => d.disposition_id);
      expect(ids).toEqual(['d-early', 'd-late']);
    });

    it('cascade delete: removing an artifact deletes its evaluator rows', () => {
      store.insertEvaluatorRun(baseRunRow());
      store.insertEvaluatorDisposition(baseDispositionRow());
      // SQLite needs PRAGMA foreign_keys=ON for cascade; the Store
      // class enables it on open.
      store.db.exec(`DELETE FROM artifacts WHERE id = '${ARTIFACT_ID}'`);
      expect(store.listEvaluatorRuns(ARTIFACT_ID)).toHaveLength(0);
      expect(store.listEvaluatorDispositions(ARTIFACT_ID)).toHaveLength(0);
    });
  });

  describe('migration 012 — cloud-sync failure state columns', () => {
    it('adds the four columns at CURRENT_VERSION', () => {
      const cols = store.db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('cloud_last_push_attempt_at');
      expect(names).toContain('cloud_last_push_error_kind');
      expect(names).toContain('cloud_last_push_error_message');
      expect(names).toContain('cloud_consecutive_failures');
      const failures = cols.find((c) => c.name === 'cloud_consecutive_failures');
      expect(failures?.notnull).toBe(1);
      expect(failures?.dflt_value).toBe('0');
    });

    it('refuses an existing cache whose version row is missing', () => {
      store.db.prepare("DELETE FROM schema_meta WHERE key = 'version'").run();
      const dbPath = store.dbPath;
      store.close();

      expect(() => new Store(dbPath, { rebuildExistingProjection: true })).toThrow(
        /version missing is unsupported/
      );
      const raw = new Database(dbPath);
      raw
        .prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)")
        .run(String(CURRENT_VERSION));
      raw.close();
      store = new Store(dbPath);
    });
  });
});
