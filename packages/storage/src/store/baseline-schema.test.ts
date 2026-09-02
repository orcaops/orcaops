import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { BASELINE_SCHEMA, BASELINE_VERSION, CURRENT_VERSION } from './migrations/index.js';

/**
 * Pins the current whole-schema baseline: a fresh database initialized from
 * BASELINE_SCHEMA stamps version 25 and carries exactly the expected
 * object set, with the artifacts CHECK narrowed to the current vocabulary.
 */
describe('v25 baseline schema', () => {
  const fresh = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec(BASELINE_SCHEMA);
    return db;
  };

  it('stamps version 25 (and CURRENT_VERSION agrees)', () => {
    expect(BASELINE_VERSION).toBe(25);
    expect(CURRENT_VERSION).toBe(25);
    const db = fresh();
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
      value: string;
    };
    expect(row.value).toBe('25');
    expect(
      db.prepare("SELECT value FROM schema_meta WHERE key = 'projection_health'").get()
    ).toEqual({ value: 'healthy' });
  });

  it('creates exactly the expected tables, view, and FTS index', () => {
    const db = fresh();
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') " +
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_idx_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toEqual([
      'artifacts',
      'checkpoints',
      'cli_session_branch_state',
      'coding_sessions',
      'evaluator_dispositions',
      'evaluator_lifecycles',
      'evaluator_runs',
      'idempotency_blocks',
      'lineage_branches',
      'lineage_by_latest_sha',
      'plan_idempotency',
      'plan_steps',
      'plans',
      'schema_meta',
      'search_idx',
      'source_plan_links',
      'summaries',
      'usage_snapshots',
    ]);
  });

  it('narrows the artifacts status CHECK to the current vocabulary', () => {
    const db = fresh();
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifacts'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("CHECK (status IN ('active', 'complete'))");
    expect(sql).not.toContain('abandoned');
    // Checkpoint-level abandon is untouched.
    const cpSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'checkpoints'").get() as {
        sql: string;
      }
    ).sql;
    expect(cpSql).toContain("'abandoned'");
  });

  it('constrains artifact origin to the git-import storage class', () => {
    const db = fresh();
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifacts'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain("origin_kind IS NULL OR origin_kind = 'git-import'");
  });

  it('rejects an artifact-level abandoned row at the SQL layer', () => {
    const db = fresh();
    expect(() =>
      db
        .prepare(
          `INSERT INTO artifacts (id, branch, task, agent, base_sha, started_at, status)
           VALUES ('x', 'main', 't', 'claude-code', 'sha', '2026-01-01T00:00:00.000Z', 'abandoned')`
        )
        .run()
    ).toThrow(/CHECK/);
  });
});
