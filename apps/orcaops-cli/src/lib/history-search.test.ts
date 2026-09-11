import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readDatabaseHistoryContext } from '@orcaops/core/history/database-read';
import type { HistoryScopeInput } from '@orcaops/project-scope/history';
import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import {
  type CanonicalSearchOptions,
  formatCanonicalSearch,
  readCanonicalSearch,
} from './history-search.js';
import { fixture, git, inventory } from '../../tests/helpers/database-history.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

afterEach(() => {
  vi.mocked(fs.open).mockClear();
  vi.mocked(fs.readFile).mockClear();
});
async function read(
  f: Awaited<ReturnType<typeof fixture>>,
  options: CanonicalSearchOptions = {},
  location: Partial<HistoryScopeInput> = {}
) {
  const scope = await resolveDatabaseHistoryScope({
    root: f.root,
    cwd: f.main,
    profile: 'collection',
    selector: { scope: options.scope, projectId: options.project, branch: options.branch },
    ...location,
  });
  try {
    return await readCanonicalSearch({ scope, config: getDefaultConfig() }, 'project narrative', {
      type: 'plan',
      ...options,
    });
  } finally {
    scope.close();
  }
}
function openedArtifactBodies() {
  return [...vi.mocked(fs.open).mock.calls, ...vi.mocked(fs.readFile).mock.calls]
    .map((args) => String(args[0]))
    .filter((file) => /\/artifacts\/[^/]+\/(?:events\.ndjson|operations\/)/u.test(file));
}

describe('canonical search command reads', { timeout: 30_000 }, () => {
  it('defaults to project history across branches and reads warm SQL search rows without opening source prose', async () => {
    const f = await fixture();
    const main = await f.capture();
    await git(f.main, ['checkout', '-qb', 'feature']);
    const feature = await f.capture();
    const before = await inventory(f.temporary);
    const first = await read(f);
    expect(first.scope).toMatchObject({
      kind: 'project',
      selection: 'default',
      branch: { source: 'all', value: null },
    });
    expect(new Set(first.results.map((row) => row.artifact_id))).toEqual(new Set([main, feature]));
    expect(first.origin_counts).toEqual({
      returned: { captured: 2, imported: 0 },
      matching: { captured: 2, imported: 0 },
    });
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.readFile).mockClear();
    const warm = await read(f);
    expect(warm.results).toEqual(first.results);
    expect(openedArtifactBodies()).toEqual([]);
    expect(warm.integrity).toEqual({ source_observation: 'read-transaction' });
    expect((await read(f, { branch: 'main' })).results.map((row) => row.artifact_id)).toEqual([
      main,
    ]);
    expect(await inventory(f.temporary)).toEqual(before);
    expect(formatCanonicalSearch(first)).toContain('Matching: 2 captured, 0 imported.');
  });

  it('filters by literal branch and actual changed paths before limiting and ignores evaluator tags', async () => {
    const f = await fixture();
    const tagged = await f.capture(undefined, {
      touchedScope: ['src/auth.ts'],
      ts: '2026-09-06T00:00:00.000Z',
    });
    const touched = await f.capture(undefined, { ts: '2026-09-04T00:00:00.000Z' });
    await f.recordFiles(touched, ['src/auth.ts']);
    const result = await read(f, { touching: 'src/*.ts', limit: 1 });
    expect(result.results.map((row) => row.artifact_id)).toEqual([touched]);
    expect(result.origin_counts.matching.captured).toBe(1);
    expect(result.results.some((row) => row.artifact_id === tagged)).toBe(false);
    expect((await read(f, { branch: 'ma*' })).results).toEqual([]);
  });

  it('retains project narrative with missing worktree identity and discloses unknown worktree associations', async () => {
    const f = await fixture();
    const captured = await f.capture();
    const unknown = await f.capture(undefined, { reason: 'legacy_unknown' });
    await f.recordFiles(captured, ['src/known.ts']);
    const worktree = await read(f, { scope: 'worktree' });
    expect(worktree.results.map((row) => row.artifact_id)).toEqual([captured]);
    expect(worktree.completeness.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNKNOWN_WORKTREE_ASSOCIATION', count: 1 }),
      ])
    );
    expect(worktree.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(
      (await read(f, { scope: 'worktree', touching: 'src/known.ts' })).completeness.complete
    ).toBe(true);
    const { git: gitContext } = await readDatabaseHistoryContext({ cwd: f.main });
    await fs.rm(path.join(gitContext.gitDir, 'orcaops', 'worktree.json'));
    const before = await inventory(f.temporary);
    const project = await read(f);
    expect(project.scope.worktree_id).toBeNull();
    expect(new Set(project.results.map((row) => row.artifact_id))).toEqual(
      new Set([captured, unknown])
    );
    await expect(read(f, { scope: 'worktree' })).rejects.toMatchObject({
      code: 'WORKTREE_SCOPE_UNAVAILABLE',
    });
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('searches all selected projects and reads an exact project outside any checkout', async () => {
    const f = await fixture();
    const captured = await f.capture(undefined, { ts: '2020-01-01T00:00:00.000Z' });
    const other = await fixture(f.root);
    const imported = await other.capture(undefined, { reason: 'imported' });
    const combined = await read(f, { scope: 'all-projects' });
    expect(combined.results.map((row) => row.artifact_id)).toEqual([captured, imported]);
    expect(combined.results[1]).toMatchObject({
      origin: 'imported',
      evidence_time: null,
      evidence_time_basis: 'unknown',
    });
    expect(
      (await read(f, { scope: 'all-projects', origin: 'imported' })).results.map(
        (row) => row.artifact_id
      )
    ).toEqual([imported]);
    const exact = await read(
      f,
      { project: other.authority.projectId },
      { cwd: f.temporary, gitContext: null }
    );
    expect(exact.results.map((row) => row.artifact_id)).toEqual([imported]);
    expect(exact.code_revision).toBeNull();
    expect(formatCanonicalSearch(exact)).toContain('time unknown');
    expect(formatCanonicalSearch(exact)).not.toMatch(/seed|backfill/u);
    expect(combined.page.ranking_complete).toBe(true);
  });

  it('uses offset pages as fresh queries after source and catalog changes', async () => {
    const f = await fixture();
    await f.capture();
    await f.capture();
    const first = await read(f, { limit: 1 });
    expect(first.page.next_offset).toBe(1);
    expect(formatCanonicalSearch(first)).toContain('Next page: --offset 1');
    const second = await read(f, { limit: 1, offset: first.page.next_offset! });
    expect(second.results[0]!.source_id).not.toBe(first.results[0]!.source_id);
    await f.capture();
    const changed = await read(f, { limit: 1, offset: first.page.next_offset! });
    expect(changed.origin_counts.matching.captured).toBe(3);
    await fixture(f.root);
    const across = await read(f, { scope: 'all-projects', limit: 1, offset: 1 });
    expect(across.page.ranking_complete).toBe(true);
    expect(first.origin_counts.matching.captured).toBe(2);
  });

  it('keeps selected filters stable and requests only the required SQL prefix per project', async () => {
    const f = await fixture();
    const first = await f.capture();
    const other = await fixture(f.root);
    const second = await other.capture();
    const scope = await resolveDatabaseHistoryScope({
      root: f.root,
      cwd: f.main,
      selector: { scope: 'all-projects' },
    });
    const calls: number[] = [];
    const prepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      const statement = prepare.call(this, sql);
      if (sql.includes('source_id COLLATE BINARY ASC LIMIT ?')) {
        const all = statement.all.bind(statement);
        statement.all = (...args: unknown[]) => {
          calls.push(args.at(-1) as number);
          return Reflect.apply(all, statement, args);
        };
      }
      return statement;
    });
    try {
      const input: CanonicalSearchOptions = {
        scope: 'all-projects',
        type: 'plan',
        limit: 1,
        offset: 1,
      };
      const pending = readCanonicalSearch(
        { scope, config: getDefaultConfig() },
        'project narrative',
        input
      );
      input.type = 'summary';
      scope.branch.value = 'unrelated';
      const result = await pending;
      expect(calls).toEqual([3, 3]);
      expect(result.filters.type).toBe('plan');
      expect(result.scope.branch.value).toBeNull();
      expect(result.origin_counts.matching.captured).toBe(2);
      expect(result.results).toHaveLength(1);
      expect([first, second]).toContain(result.results[0].artifact_id);
      expect(result.results[0].source_kind).toBe('plan');
    } finally {
      spy.mockRestore();
      scope.close();
    }
  });

  it('returns explicit incomplete history after corruption without repairing canonical bytes', async () => {
    const f = await fixture();
    const id = await f.capture();
    await read(f);
    const raw = new Database(projectDatabasePath(f.authority));
    raw.prepare('DELETE FROM artifact_search_sources WHERE artifact_id=?').run(id);
    raw.close();
    const before = await inventory(f.temporary);
    const result = await read(f);
    expect(result.results).toEqual([]);
    expect(result.page).toMatchObject({
      ranking_complete: false,
      source_complete: false,
      candidate_complete: true,
    });
    expect(result.completeness.complete).toBe(false);
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    const human = formatCanonicalSearch(result);
    expect(human).toContain('Matching totals unavailable.');
    expect(human).toContain('results are incomplete');
    expect(human).not.toMatch(/seed|backfill/u);
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
