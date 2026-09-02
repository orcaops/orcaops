import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_VERSION } from './migrations/index.js';
import { rebuildPlanIdempotency } from './rebuild-plan-idempotency.js';
import { Store } from './sqlite.js';
import { appendEvent } from '../events/event-log.js';
import { type Config, getDefaultConfig } from '../schema/config.js';

describe('plan_idempotency table (migration 003)', () => {
  let tmpRoot: string;
  let dbPath: string;
  let store: Store;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-pi-'));
    dbPath = path.join(tmpRoot, '.orcaops', 'cache', 'orcaops.db');
    store = new Store(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('migration', () => {
    it('CURRENT_VERSION is at least 3 (plan_idempotency landed at schema 003)', () => {
      expect(CURRENT_VERSION).toBe(25);
    });

    it('a fresh DB is at the latest schema version', () => {
      const row = store.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
        value: string;
      };
      expect(parseInt(row.value, 10)).toBe(CURRENT_VERSION);
    });

    it('a fresh DB has the plan_idempotency table', () => {
      const row = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_idempotency'")
        .get();
      expect(row).toBeDefined();
    });

    it('an older cache is refused instead of carrying reservations forward', () => {
      store.close();

      const v2Store = new Store(dbPath);
      v2Store.db.exec(`UPDATE schema_meta SET value = '2' WHERE key = 'version'`);
      v2Store.upsertArtifact({
        label: 'test-label',
        non_goals: '[]',
        id: '01999999-9999-7000-8000-000000000001',
        branch: 'feat/x',
        task: 't',
        agent: 'claude-code',
        base_sha: 'abc',
        started_at: '2026-04-26T12:00:00.000Z',
        completed_at: null,
        status: 'active',
      });
      v2Store.close();

      expect(() => new Store(dbPath)).toThrow(/unsupported; expected 25/);
      const raw = new Store(dbPath, { rebuildExistingProjection: true });
      expect(raw.lookupPlanIdempotency('never-seen')).toBeNull();
      raw.db
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'")
        .run(String(CURRENT_VERSION));
      raw.close();
      store = new Store(dbPath);
    });
  });

  describe('lookup + insert', () => {
    it('lookupPlanIdempotency returns null for an unknown key', () => {
      expect(store.lookupPlanIdempotency('never-seen')).toBeNull();
    });

    it('insertPlanIdempotency persists a row that lookup returns', () => {
      store.insertPlanIdempotency({
        idempotency_key: 'plan-init-1',
        artifact_id: '01999999-9999-7000-8000-000000000001',
        created_at: '2026-04-26T12:00:00.000Z',
      });
      expect(store.lookupPlanIdempotency('plan-init-1')).toEqual({
        idempotency_key: 'plan-init-1',
        artifact_id: '01999999-9999-7000-8000-000000000001',
        created_at: '2026-04-26T12:00:00.000Z',
      });
    });

    it('finds a reservation only in the current cache table', () => {
      const artifactId = '01999999-9999-7000-8000-000000000001';
      store.insertPlanIdempotency({
        idempotency_key: 'current-plan',
        artifact_id: artifactId,
        created_at: '2026-04-26T12:00:00.000Z',
      });
      expect(store.hasPlanIdempotencyReservation('current-plan', artifactId)).toBe(true);
      expect(store.hasPlanIdempotencyReservation('missing-plan', artifactId)).toBe(false);
    });

    it('insertPlanIdempotency throws on PRIMARY KEY violation (race coordination)', () => {
      store.insertPlanIdempotency({
        idempotency_key: 'plan-race-1',
        artifact_id: '01999999-9999-7000-8000-000000000001',
        created_at: '2026-04-26T12:00:00.000Z',
      });
      // A concurrent capture-plan with the same key MUST throw — the caller's
      // catch path looks up the winner and returns IDEMPOTENT_REPLAY.
      expect(() =>
        store.insertPlanIdempotency({
          idempotency_key: 'plan-race-1',
          artifact_id: '01999999-9999-7000-8000-000000000002',
          created_at: '2026-04-26T12:00:00.001Z',
        })
      ).toThrow(/UNIQUE|PRIMARY/);
    });

    it('truncatePlanIdempotency drops every row', () => {
      store.insertPlanIdempotency({
        idempotency_key: 'k1',
        artifact_id: 'a1',
        created_at: '2026-04-26T12:00:00.000Z',
      });
      store.insertPlanIdempotency({
        idempotency_key: 'k2',
        artifact_id: 'a2',
        created_at: '2026-04-26T12:00:01.000Z',
      });
      store.truncatePlanIdempotency();
      expect(store.lookupPlanIdempotency('k1')).toBeNull();
      expect(store.lookupPlanIdempotency('k2')).toBeNull();
    });
  });
});

describe('rebuildPlanIdempotency', () => {
  let tmpRoot: string;
  let dbPath: string;
  let store: Store;
  let config: Config;

  /**
   * Plant a single artifact directory at the flat layout
   * (`<artifactsRoot>/<artifactId>/`) containing one plan_captured
   * event in events.ndjson.
   */
  async function plantArtifactWithPlanEvent(opts: {
    artifactId: string;
    idempotencyKey: string;
    ts: string;
  }): Promise<void> {
    const artifactDir = path.join(tmpRoot, config.artifacts.path, opts.artifactId);
    await mkdir(artifactDir, { recursive: true });
    await appendEvent(
      {
        type: 'plan_captured',
        ts: opts.ts,
        idempotency_key: opts.idempotencyKey,
        payload: { artifact_id: opts.artifactId, task: 't' },
      },
      {
        eventLogPath: path.join(artifactDir, 'events.ndjson'),
        sidecarsDir: path.join(artifactDir, 'sidecars'),
      }
    );
  }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'orcaops-pi-rebuild-'));
    config = getDefaultConfig();
    dbPath = path.join(tmpRoot, config.cache.path);
    store = new Store(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns zero-counts when there are no artifacts on disk', async () => {
    const result = await rebuildPlanIdempotency({ repoRoot: tmpRoot, config, store });
    expect(result).toEqual({ artifactsScanned: 0, plansIndexed: 0, conflicts: [] });
  });

  it('indexes a single plan_captured event and reverses the lookup', async () => {
    await plantArtifactWithPlanEvent({
      artifactId: '01999999-9999-7000-8000-000000000001',
      idempotencyKey: 'plan-init-1',
      ts: '2026-04-26T12:00:00.000Z',
    });
    const result = await rebuildPlanIdempotency({ repoRoot: tmpRoot, config, store });
    expect(result.artifactsScanned).toBe(1);
    expect(result.plansIndexed).toBe(1);
    expect(result.conflicts).toEqual([]);

    const row = store.lookupPlanIdempotency('plan-init-1');
    expect(row?.artifact_id).toBe('01999999-9999-7000-8000-000000000001');
    expect(row?.created_at).toBe('2026-04-26T12:00:00.000Z');
  });

  it('walks multiple branches and indexes every plan it finds', async () => {
    await plantArtifactWithPlanEvent({
      artifactId: '01999999-9999-7000-8000-000000000001',
      idempotencyKey: 'plan-a',
      ts: '2026-04-26T12:00:00.000Z',
    });
    await plantArtifactWithPlanEvent({
      artifactId: '01999999-9999-7000-8000-000000000002',
      idempotencyKey: 'plan-b',
      ts: '2026-04-26T12:01:00.000Z',
    });

    const result = await rebuildPlanIdempotency({ repoRoot: tmpRoot, config, store });
    expect(result.artifactsScanned).toBe(2);
    expect(result.plansIndexed).toBe(2);
    expect(store.lookupPlanIdempotency('plan-a')?.artifact_id).toBe(
      '01999999-9999-7000-8000-000000000001'
    );
    expect(store.lookupPlanIdempotency('plan-b')?.artifact_id).toBe(
      '01999999-9999-7000-8000-000000000002'
    );
  });

  it('truncates pre-existing rows before reindexing (idempotent rebuild)', async () => {
    // Plant a stale row that does NOT correspond to any on-disk artifact.
    store.insertPlanIdempotency({
      idempotency_key: 'plan-stale',
      artifact_id: 'gone',
      created_at: '2026-04-25T12:00:00.000Z',
    });
    await plantArtifactWithPlanEvent({
      artifactId: '01999999-9999-7000-8000-000000000001',
      idempotencyKey: 'plan-current',
      ts: '2026-04-26T12:00:00.000Z',
    });

    const result = await rebuildPlanIdempotency({ repoRoot: tmpRoot, config, store });
    expect(result.plansIndexed).toBe(1);
    expect(store.lookupPlanIdempotency('plan-stale')).toBeNull();
    expect(store.lookupPlanIdempotency('plan-current')?.artifact_id).toBe(
      '01999999-9999-7000-8000-000000000001'
    );
  });

  it('skips non-plan event types (only plan_captured contributes to the index)', async () => {
    const artifactDir = path.join(tmpRoot, config.artifacts.path, 'a1');
    await mkdir(artifactDir, { recursive: true });
    await appendEvent(
      {
        type: 'checkpoint_opened',
        ts: '2026-04-26T12:30:00.000Z',
        idempotency_key: 'cp-1',
        payload: { x: 1 },
      },
      {
        eventLogPath: path.join(artifactDir, 'events.ndjson'),
        sidecarsDir: path.join(artifactDir, 'sidecars'),
      }
    );
    const result = await rebuildPlanIdempotency({ repoRoot: tmpRoot, config, store });
    expect(result.artifactsScanned).toBe(1);
    expect(result.plansIndexed).toBe(0);
    expect(store.lookupPlanIdempotency('cp-1')).toBeNull();
  });

  it('reports a conflict when the same idempotency_key appears in multiple artifacts', async () => {
    await plantArtifactWithPlanEvent({
      artifactId: '01999999-9999-7000-8000-000000000001',
      idempotencyKey: 'plan-dupe',
      ts: '2026-04-26T12:00:00.000Z',
    });
    await plantArtifactWithPlanEvent({
      artifactId: '01999999-9999-7000-8000-000000000002',
      idempotencyKey: 'plan-dupe',
      ts: '2026-04-26T12:01:00.000Z',
    });
    const result = await rebuildPlanIdempotency({ repoRoot: tmpRoot, config, store });
    expect(result.plansIndexed).toBe(1); // only the first inserts
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].idempotency_key).toBe('plan-dupe');
    expect(result.conflicts[0].artifact_ids.sort()).toEqual([
      '01999999-9999-7000-8000-000000000001',
      '01999999-9999-7000-8000-000000000002',
    ]);
  });
});
