import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_VERSION } from './migrations/index.js';
import { rebuildLineageIndex } from './rebuild-lineage-index.js';
import { Store } from './sqlite.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

describe('lineage_by_latest_sha (migration 004)', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-lineage-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('migration', () => {
    it('CURRENT_VERSION is the current whole-schema baseline', () => {
      expect(CURRENT_VERSION).toBe(25);
    });

    it('a fresh DB has the lineage_by_latest_sha table at the current version', () => {
      const versionRow = store.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
        .get() as { value: string };
      expect(parseInt(versionRow.value, 10)).toBe(CURRENT_VERSION);
      const tableRow = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='lineage_by_latest_sha'"
        )
        .get();
      expect(tableRow).toBeDefined();
    });

    it('the index on latest_lineage_sha exists (sync perf depends on it)', () => {
      const indexRow = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_lineage_by_latest_sha_sha'"
        )
        .get();
      expect(indexRow).toBeDefined();
    });
  });

  describe('upsert + lookup', () => {
    it('upsertLineageByLatestSha + artifactsAtLatestLineageSha round-trip', () => {
      store.upsertLineageByLatestSha({
        artifact_id: 'a-1',
        latest_lineage_sha: 'sha-x',
        branch_name: 'main',
      });
      const matches = store.artifactsAtLatestLineageSha('sha-x');
      expect(matches).toEqual([
        { artifact_id: 'a-1', latest_lineage_sha: 'sha-x', branch_name: 'main' },
      ]);
    });

    it('upsert replaces the prior row for the same artifact_id', () => {
      store.upsertLineageByLatestSha({
        artifact_id: 'a-1',
        latest_lineage_sha: 'sha-old',
        branch_name: 'feat/x',
      });
      store.upsertLineageByLatestSha({
        artifact_id: 'a-1',
        latest_lineage_sha: 'sha-new',
        branch_name: 'main',
      });
      // Old SHA finds nothing; new SHA finds the artifact.
      expect(store.artifactsAtLatestLineageSha('sha-old')).toEqual([]);
      expect(store.artifactsAtLatestLineageSha('sha-new')).toHaveLength(1);
    });

    it('returns every artifact whose latest SHA matches (sync match-set)', () => {
      store.upsertLineageByLatestSha({
        artifact_id: 'a-1',
        latest_lineage_sha: 'sha-x',
        branch_name: 'main',
      });
      store.upsertLineageByLatestSha({
        artifact_id: 'a-2',
        latest_lineage_sha: 'sha-x',
        branch_name: 'feat/x',
      });
      store.upsertLineageByLatestSha({
        artifact_id: 'a-3',
        latest_lineage_sha: 'sha-y',
        branch_name: 'main',
      });
      expect(
        store
          .artifactsAtLatestLineageSha('sha-x')
          .map((r) => r.artifact_id)
          .sort()
      ).toEqual(['a-1', 'a-2']);
    });

    it('truncate drops every row', () => {
      store.upsertLineageByLatestSha({
        artifact_id: 'a-1',
        latest_lineage_sha: 'sha-x',
        branch_name: 'main',
      });
      store.truncateLineageByLatestSha();
      expect(store.artifactsAtLatestLineageSha('sha-x')).toEqual([]);
    });
  });
});

describe('lineage_branches (migration 005)', () => {
  let tmpRoot: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-lineage-branches-'));
    store = new Store(path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('the lineage_branches table exists', () => {
    const tableRow = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lineage_branches'")
      .get();
    expect(tableRow).toBeDefined();
  });

  it('the index on branch_name exists (filter perf depends on it)', () => {
    const indexRow = store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_lineage_branches_branch'"
      )
      .get();
    expect(indexRow).toBeDefined();
  });

  it('upsertLineageBranch is idempotent on (artifact_id, branch_name)', () => {
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'main' });
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'main' });
    const rows = store.db
      .prepare(`SELECT * FROM lineage_branches WHERE artifact_id = ?`)
      .all('a-1');
    expect(rows).toHaveLength(1);
  });

  function plantArtifact(id: string, branch: string): void {
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id,
      branch,
      task: 't',
      agent: 'claude-code',
      base_sha: 'sha-base',
      started_at: '2026-04-27T10:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
  }

  it('listArtifactsByLineageBranch returns matching artifacts via JOIN', () => {
    plantArtifact('a-1', 'feat/x');
    plantArtifact('a-2', 'feat/x');
    plantArtifact('a-3', 'main');
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'feat/x' });
    store.upsertLineageBranch({ artifact_id: 'a-2', branch_name: 'feat/x' });
    store.upsertLineageBranch({ artifact_id: 'a-3', branch_name: 'main' });

    const onFeat = store.listArtifactsByLineageBranch({ branch: 'feat/x' });
    expect(onFeat.map((a) => a.id).sort()).toEqual(['a-1', 'a-2']);
    const onMain = store.listArtifactsByLineageBranch({ branch: 'main' });
    expect(onMain.map((a) => a.id)).toEqual(['a-3']);
  });

  it('an artifact with multiple lineage branches is found from each', () => {
    plantArtifact('a-1', 'feat/x');
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'feat/x' });
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'main' });

    expect(store.listArtifactsByLineageBranch({ branch: 'feat/x' }).map((a) => a.id)).toEqual([
      'a-1',
    ]);
    expect(store.listArtifactsByLineageBranch({ branch: 'main' }).map((a) => a.id)).toEqual([
      'a-1',
    ]);
  });

  it('the status filter narrows the join result', () => {
    plantArtifact('a-1', 'feat/x');
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-2',
      branch: 'feat/x',
      task: 't',
      agent: 'claude-code',
      base_sha: 'sha-base',
      started_at: '2026-04-27T10:00:00.000Z',
      completed_at: '2026-04-27T11:00:00.000Z',
      status: 'complete',
    });
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'feat/x' });
    store.upsertLineageBranch({ artifact_id: 'a-2', branch_name: 'feat/x' });

    const active = store.listArtifactsByLineageBranch({ branch: 'feat/x', status: 'active' });
    expect(active.map((a) => a.id)).toEqual(['a-1']);
    const complete = store.listArtifactsByLineageBranch({ branch: 'feat/x', status: 'complete' });
    expect(complete.map((a) => a.id)).toEqual(['a-2']);
  });

  it('truncateLineageBranches drops every row', () => {
    store.upsertLineageBranch({ artifact_id: 'a-1', branch_name: 'main' });
    store.truncateLineageBranches();
    const rows = store.db.prepare(`SELECT * FROM lineage_branches`).all();
    expect(rows).toEqual([]);
  });
});

describe('rebuildLineageIndex', () => {
  let tmpRoot: string;
  let store: Store;
  let config: Config;

  async function plantArtifactJson(opts: {
    artifactId: string;
    lineage: Array<{
      branch: string;
      head_sha: string;
      ts: string;
      event: 'created' | 'rebased' | 'merged';
    }>;
  }): Promise<void> {
    const dir = path.join(tmpRoot, config.artifacts.path, opts.artifactId);
    await mkdir(dir, { recursive: true });
    const artifactJson = {
      schema_version: 1,
      id: opts.artifactId,
      state: 'planned',
      branch_lineage: opts.lineage,
      created_by_session_id: null,
      created_at: opts.lineage[0].ts,
      updated_at: opts.lineage[opts.lineage.length - 1].ts,
      checkpoint_count: 0,
      plan_revision_count: 0,
      plan_last_revised_at: null,
      source_event_id: 'evt-stub',
      source_plan: null,
      pre_pr_checked_head_sha: null,
      pre_pr_checked_source_event_id: null,
      baseline_seed_tree_sha: null,
      superseded_artifact_id: null,
    };
    await writeFile(path.join(dir, 'artifact.json'), JSON.stringify(artifactJson) + '\n');
  }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-lineage-rebuild-'));
    config = getDefaultConfig();
    store = new Store(path.join(tmpRoot, config.cache.path));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns zero counts when no artifacts exist on disk', async () => {
    const result = await rebuildLineageIndex({ repoRoot: tmpRoot, config, store });
    expect(result).toEqual({
      artifactsScanned: 0,
      rowsIndexed: 0,
      branchRowsIndexed: 0,
      skipped: [],
    });
  });

  it('indexes the latest lineage entry per artifact', async () => {
    await plantArtifactJson({
      artifactId: 'a-1',
      lineage: [
        {
          branch: 'feat/x',
          head_sha: 'sha-base',
          ts: '2026-04-26T12:00:00.000Z',
          event: 'created',
        },
        {
          branch: 'feat/x',
          head_sha: 'sha-rebased',
          ts: '2026-04-26T13:00:00.000Z',
          event: 'rebased',
        },
      ],
    });
    const result = await rebuildLineageIndex({ repoRoot: tmpRoot, config, store });
    expect(result).toEqual({
      artifactsScanned: 1,
      rowsIndexed: 1,
      // Same branch in both lineage entries → one row in lineage_branches,
      // but the rebuild loop counts every entry (idempotent OR IGNORE).
      branchRowsIndexed: 2,
      skipped: [],
    });

    const matches = store.artifactsAtLatestLineageSha('sha-rebased');
    expect(matches).toEqual([
      { artifact_id: 'a-1', latest_lineage_sha: 'sha-rebased', branch_name: 'feat/x' },
    ]);
    // The pre-rebase SHA is no longer indexed (only the latest matters).
    expect(store.artifactsAtLatestLineageSha('sha-base')).toEqual([]);
  });

  it('skips artifact dirs without an artifact.json (transitional state)', async () => {
    const dir = path.join(tmpRoot, config.artifacts.path, 'a-incomplete');
    await mkdir(dir, { recursive: true });
    const result = await rebuildLineageIndex({ repoRoot: tmpRoot, config, store });
    expect(result.artifactsScanned).toBe(1);
    expect(result.rowsIndexed).toBe(0);
    expect(result.skipped).toEqual(['a-incomplete']);
  });

  it('skips a directory name that is not a portable artifact-id segment', async () => {
    if (process.platform === 'win32') return;
    const unsafeId = 'nested\\child';
    await mkdir(path.join(tmpRoot, config.artifacts.path, unsafeId), { recursive: true });

    const result = await rebuildLineageIndex({ repoRoot: tmpRoot, config, store });

    expect(result.artifactsScanned).toBe(1);
    expect(result.rowsIndexed).toBe(0);
    expect(result.skipped).toEqual([unsafeId]);
  });

  it('truncates pre-existing rows before reindexing (idempotent rebuild)', async () => {
    store.upsertLineageByLatestSha({
      artifact_id: 'stale-row',
      latest_lineage_sha: 'sha-gone',
      branch_name: 'main',
    });
    store.upsertLineageBranch({ artifact_id: 'stale-row', branch_name: 'main' });
    await plantArtifactJson({
      artifactId: 'a-1',
      lineage: [
        {
          branch: 'main',
          head_sha: 'sha-current',
          ts: '2026-04-26T12:00:00.000Z',
          event: 'created',
        },
      ],
    });
    await rebuildLineageIndex({ repoRoot: tmpRoot, config, store });
    expect(store.artifactsAtLatestLineageSha('sha-gone')).toEqual([]);
    expect(store.artifactsAtLatestLineageSha('sha-current')).toHaveLength(1);
    // The stale row's branch membership is also gone — both indexes get truncated.
    expect(store.listArtifactsByLineageBranch({ branch: 'main' }).map((a) => a.id)).not.toContain(
      'stale-row'
    );
  });

  it('repopulates lineage_branches from every entry in branch_lineage', async () => {
    await plantArtifactJson({
      artifactId: 'a-1',
      lineage: [
        {
          branch: 'feat/x',
          head_sha: 'sha-base',
          ts: '2026-04-26T12:00:00.000Z',
          event: 'created',
        },
        {
          branch: 'feat/x',
          head_sha: 'sha-rebased',
          ts: '2026-04-26T13:00:00.000Z',
          event: 'rebased',
        },
        {
          branch: 'main',
          head_sha: 'sha-merged',
          ts: '2026-04-26T14:00:00.000Z',
          event: 'merged',
        },
      ],
    });
    // The artifacts table needs a stub row for the join to find anything.
    store.upsertArtifact({
      label: 'test-label',
      non_goals: '[]',
      id: 'a-1',
      branch: 'feat/x',
      task: 't',
      agent: 'claude-code',
      base_sha: 'sha-base',
      started_at: '2026-04-26T12:00:00.000Z',
      completed_at: null,
      status: 'active',
    });
    await rebuildLineageIndex({ repoRoot: tmpRoot, config, store });
    expect(store.listArtifactsByLineageBranch({ branch: 'feat/x' }).map((a) => a.id)).toEqual([
      'a-1',
    ]);
    expect(store.listArtifactsByLineageBranch({ branch: 'main' }).map((a) => a.id)).toEqual([
      'a-1',
    ]);
    expect(store.listArtifactsByLineageBranch({ branch: 'never' })).toEqual([]);
  });
});
