import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expect } from 'vitest';

import { Store } from './sqlite.js';

describe('Store — migration 013 + session branch state', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'orcaops-session-state-'));
    store = new Store(path.join(tmpDir, 'cache', 'orcaops.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('migration 013', () => {
    it('creates the table at CURRENT_VERSION with the documented columns', () => {
      const cols = store.db.prepare(`PRAGMA table_info(cli_session_branch_state)`).all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

      expect(byName.repo_url).toBeDefined();
      expect(byName.repo_url.notnull).toBe(1);
      expect(byName.working_dir).toBeDefined();
      expect(byName.working_dir.notnull).toBe(1);
      expect(byName.current_branch).toBeDefined();
      expect(byName.current_branch.notnull).toBe(1);
      expect(byName.branch_history).toBeDefined();
      expect(byName.branch_history.notnull).toBe(1);
      expect(byName.branch_history.dflt_value).toBe(`'[]'`);
      expect(byName.base_commit_sha).toBeDefined();
      expect(byName.base_commit_sha.notnull).toBe(0);
      expect(byName.last_acked_at).toBeDefined();
      expect(byName.last_acked_at.notnull).toBe(0);
    });

    it('uses (repo_url, working_dir) as the primary key (composite autoindex)', () => {
      const idxRows = store.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cli_session_branch_state'`
        )
        .all() as Array<{ name: string }>;
      expect(
        idxRows.some((r) => r.name.startsWith('sqlite_autoindex_cli_session_branch_state'))
      ).toBe(true);
    });

    it('refuses an older schema instead of recreating the missing table', () => {
      store.db.prepare(`DROP TABLE cli_session_branch_state`).run();
      store.db.prepare(`UPDATE schema_meta SET value = '12' WHERE key = 'version'`).run();
      const dbPath = store.dbPath;
      store.close();

      expect(() => new Store(dbPath)).toThrow(/unsupported; expected 25/);
      store = new Store(dbPath, { rebuildExistingProjection: true });
    });
  });

  describe('Store accessors', () => {
    it('getSessionBranchState returns null when no row exists', () => {
      expect(store.getSessionBranchState('repo', '/tmp/wd')).toBeNull();
    });

    it('upsertSessionBranchState round-trips an empty branchHistory + null baseCommitSha', () => {
      store.upsertSessionBranchState({
        repoUrl: 'repo',
        workingDir: '/tmp/wd',
        currentBranch: 'main',
        branchHistory: [],
        baseCommitSha: null,
      });
      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state).toEqual({
        repoUrl: 'repo',
        workingDir: '/tmp/wd',
        currentBranch: 'main',
        branchHistory: [],
        baseCommitSha: null,
        lastAckedAt: null,
      });
    });

    it('upsertSessionBranchState round-trips a multi-entry branchHistory', () => {
      store.upsertSessionBranchState({
        repoUrl: 'repo',
        workingDir: '/tmp/wd',
        currentBranch: 'feat-c',
        branchHistory: ['feat-a', 'feat-b'],
        baseCommitSha: 'sha-1',
      });
      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state?.branchHistory).toEqual(['feat-a', 'feat-b']);
      expect(state?.baseCommitSha).toBe('sha-1');
    });

    it('upsertSessionBranchState updates an existing row in place (ON CONFLICT)', () => {
      store.upsertSessionBranchState({
        repoUrl: 'repo',
        workingDir: '/tmp/wd',
        currentBranch: 'feat-a',
        branchHistory: [],
        baseCommitSha: 'sha-1',
      });
      store.upsertSessionBranchState({
        repoUrl: 'repo',
        workingDir: '/tmp/wd',
        currentBranch: 'feat-b',
        branchHistory: ['feat-a'],
        baseCommitSha: 'sha-1',
      });
      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state?.currentBranch).toBe('feat-b');
      expect(state?.branchHistory).toEqual(['feat-a']);
    });

    it('getSessionBranchState falls back to [] when branch_history JSON is corrupt', () => {
      store.db
        .prepare(
          `INSERT INTO cli_session_branch_state (repo_url, working_dir, current_branch, branch_history) VALUES (?, ?, ?, ?)`
        )
        .run('repo', '/tmp/wd', 'main', '{not valid json');
      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state?.branchHistory).toEqual([]);
    });

    it('getSessionBranchState falls back to [] for non-array JSON', () => {
      store.db
        .prepare(
          `INSERT INTO cli_session_branch_state (repo_url, working_dir, current_branch, branch_history) VALUES (?, ?, ?, ?)`
        )
        .run('repo', '/tmp/wd', 'main', '{"not": "an array"}');
      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state?.branchHistory).toEqual([]);
    });

    it('getSessionBranchState filters non-string entries out of branch_history', () => {
      store.db
        .prepare(
          `INSERT INTO cli_session_branch_state (repo_url, working_dir, current_branch, branch_history) VALUES (?, ?, ?, ?)`
        )
        .run('repo', '/tmp/wd', 'main', '["feat-a", 42, null, "feat-b"]');
      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state?.branchHistory).toEqual(['feat-a', 'feat-b']);
    });

    it('markSessionAcked clears branch_history and stamps last_acked_at', () => {
      store.upsertSessionBranchState({
        repoUrl: 'repo',
        workingDir: '/tmp/wd',
        currentBranch: 'feat-c',
        branchHistory: ['feat-a', 'feat-b'],
        baseCommitSha: 'sha-1',
      });
      store.markSessionAcked('repo', '/tmp/wd', '2026-05-08T12:00:00.000Z');

      const state = store.getSessionBranchState('repo', '/tmp/wd');
      expect(state?.branchHistory).toEqual([]);
      expect(state?.lastAckedAt).toBe('2026-05-08T12:00:00.000Z');
      expect(state?.currentBranch).toBe('feat-c');
      expect(state?.baseCommitSha).toBe('sha-1');
    });

    it('markSessionAcked is a no-op when no row exists (no throw, no row created)', () => {
      expect(() =>
        store.markSessionAcked('absent', '/tmp/none', '2026-05-08T12:00:00.000Z')
      ).not.toThrow();
      expect(store.getSessionBranchState('absent', '/tmp/none')).toBeNull();
    });

    it('keeps state independent across (repo_url, working_dir) pairs', () => {
      store.upsertSessionBranchState({
        repoUrl: 'repo-a',
        workingDir: '/tmp/wd-a',
        currentBranch: 'main',
        branchHistory: [],
        baseCommitSha: 'sha-a',
      });
      store.upsertSessionBranchState({
        repoUrl: 'repo-b',
        workingDir: '/tmp/wd-b',
        currentBranch: 'feat',
        branchHistory: ['old'],
        baseCommitSha: 'sha-b',
      });
      expect(store.getSessionBranchState('repo-a', '/tmp/wd-a')?.currentBranch).toBe('main');
      expect(store.getSessionBranchState('repo-b', '/tmp/wd-b')?.currentBranch).toBe('feat');
      expect(store.getSessionBranchState('repo-a', '/tmp/wd-b')).toBeNull();
    });
  });
});
