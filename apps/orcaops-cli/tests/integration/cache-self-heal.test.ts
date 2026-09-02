import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempRepo, inputFile, type TempRepo } from '@orcaops/test-harness';

import { makeAgent } from '../support/test-agent.js';

describe('SQLite disposable cache boundary', () => {
  let repo: TempRepo;
  let agent: ReturnType<typeof makeAgent>;

  beforeEach(async () => {
    repo = await createTempRepo({ initialBranch: 'main' });
    agent = makeAgent({ cwd: repo.path, env: { ORCAOPS_DISABLE_DRAIN: '1' } });
    await agent.init({ noLlm: true });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const cachePath = (): string => path.join(repo.path, '.orcaops', 'cache', 'orcaops.db');

  const capturePlan = async (key: string): Promise<string> => {
    const result = await agent.runRaw([
      'capture',
      'plan',
      '--no-llm',
      '--input',
      inputFile(
        JSON.stringify({
          idempotency_key: key,
          task: 'disposable cache integration',
          label: 'disposable-cache',
          plan_steps: [{ text: 'step one', label: 'one' }],
          touched_scope: [],
        })
      ),
    ]);
    expect(result.exitCode).toBe(0);
    return (JSON.parse(result.stdout) as { artifact_id: string }).artifact_id;
  };

  const withDb = async <T>(fn: (db: import('better-sqlite3').Database) => T): Promise<T> => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(cachePath());
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  it('ordinary commands refuse an older cache without mutating it', async () => {
    const artifactId = await capturePlan('strict-old-cache');
    await withDb((db) => {
      db.prepare(
        `UPDATE artifacts SET cloud_synced_at = '2026-08-01T00:00:00.000Z',
           cloud_sync_hash = 'cache-only', cloud_external_id = 'old-external'
         WHERE id = ?`
      ).run(artifactId);
      db.prepare("UPDATE schema_meta SET value = '7' WHERE key = 'version'").run();
    });

    const list = await agent.runRaw(['list', '--json']);
    expect(list.exitCode).toBe(1);
    expect(list.stdout).toContain('SQLite cache schema version');

    const state = await withDb((db) => ({
      version: (
        db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
          value: string;
        }
      ).value,
      cloud: db
        .prepare('SELECT cloud_sync_hash, cloud_external_id FROM artifacts WHERE id = ?')
        .get(artifactId),
    }));
    expect(state.version).toBe('7');
    expect(state.cloud).toEqual({
      cloud_sync_hash: 'cache-only',
      cloud_external_id: 'old-external',
    });
  });

  it('explicit rebuild replaces an older cache and retains only event-backed identity', async () => {
    const artifactId = await capturePlan('published-plan-key');
    await withDb((db) => {
      db.prepare(
        `UPDATE artifacts SET cloud_synced_at = '2026-08-01T00:00:00.000Z',
           cloud_sync_hash = 'cache-only', cloud_external_id = 'old-external'
         WHERE id = ?`
      ).run(artifactId);
      db.prepare(
        `INSERT INTO cli_session_branch_state
           (repo_url, working_dir, current_branch, branch_history)
         VALUES ('repo', 'worktree', 'main', '[]')`
      ).run();
      db.prepare(
        `INSERT OR REPLACE INTO evaluator_lifecycles
           (artifact_id, fires_at, cp_n, triggered_at)
         VALUES (?, 'post-plan', 0, '2026-08-01T00:00:00.000Z')`
      ).run(artifactId);
      db.prepare(
        `INSERT INTO plan_idempotency (idempotency_key, artifact_id, created_at)
         VALUES ('planless-key', '01999999-9999-7000-8000-000000000099',
                 '2026-08-01T00:00:00.000Z')`
      ).run();
      db.prepare("UPDATE schema_meta SET value = '7' WHERE key = 'version'").run();
    });

    const rebuild = await agent.runRaw(['rebuild', '--json']);
    expect(rebuild.exitCode).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toMatchObject({
      ok: true,
      artifacts: 1,
      healed_on_open: true,
    });

    const state = await withDb((db) => ({
      version: (
        db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
          value: string;
        }
      ).value,
      artifact: db
        .prepare('SELECT id, cloud_synced_at, cloud_sync_hash, cloud_external_id FROM artifacts')
        .get(),
      published: db
        .prepare('SELECT artifact_id FROM plan_idempotency WHERE idempotency_key = ?')
        .get('published-plan-key'),
      planless: db
        .prepare('SELECT artifact_id FROM plan_idempotency WHERE idempotency_key = ?')
        .get('planless-key'),
      sessions: (
        db.prepare('SELECT COUNT(*) AS count FROM cli_session_branch_state').get() as {
          count: number;
        }
      ).count,
      postPlanLifecycle: db
        .prepare(
          "SELECT 1 FROM evaluator_lifecycles WHERE artifact_id = ? AND fires_at = 'post-plan'"
        )
        .get(artifactId),
      health: db.prepare("SELECT value FROM schema_meta WHERE key = 'projection_health'").get(),
    }));
    expect(state.version).toBe('25');
    expect(state.artifact).toEqual({
      id: artifactId,
      cloud_synced_at: null,
      cloud_sync_hash: null,
      cloud_external_id: null,
    });
    expect(state.published).toEqual({ artifact_id: artifactId });
    expect(state.planless).toBeUndefined();
    expect(state.sessions).toBe(0);
    expect(state.postPlanLifecycle).toBeUndefined();
    expect(state.health).toEqual({ value: 'healthy' });

    const list = await agent.runRaw(['list', '--json']);
    expect(list.exitCode).toBe(0);
    expect(
      (JSON.parse(list.stdout) as { artifacts: Array<{ id: string }> }).artifacts.map(
        (row) => row.id
      )
    ).toContain(artifactId);
  });

  it('replays durable events after the cache file is deleted', async () => {
    const artifactId = await capturePlan('deleted-cache-plan');
    const dbPath = cachePath();
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });

    const list = await agent.runRaw(['list', '--json']);
    expect(list.exitCode).toBe(0);
    expect(
      (JSON.parse(list.stdout) as { artifacts: Array<{ id: string }> }).artifacts.map(
        (row) => row.id
      )
    ).toContain(artifactId);
    expect(
      await withDb((db) =>
        db.prepare("SELECT value FROM schema_meta WHERE key = 'projection_health'").get()
      )
    ).toEqual({ value: 'healthy' });
  });

  it('explicit rebuild still refuses a future cache version', async () => {
    await capturePlan('future-cache-version');
    await withDb((db) => {
      db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'version'").run();
    });

    const rebuild = await agent.runRaw(['rebuild', '--json']);
    expect(rebuild.exitCode).toBe(1);
    expect(rebuild.stdout).toContain('SCHEMA_AHEAD');
  });
});
