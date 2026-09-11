import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig } from '@orcaops/storage';

import { DIFF_ATTRIBUTION_NOT_MEASURED } from './database-diff.js';
import {
  type DatabaseStatsOptions,
  formatDatabaseStats,
  readDatabaseStats,
  validateDatabaseStats,
} from './database-stats.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';
import { tokens, usageObservation } from '../../tests/helpers/database-usage.js';
import { createDatabaseStatsAction } from '../commands/stats.js';
import { CliExit } from '../io/exit.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
  vi.restoreAllMocks();
});
async function context(
  f: Awaited<ReturnType<typeof fixture>>,
  options: ReturnType<typeof validateDatabaseStats>
) {
  const scope = await resolveDatabaseHistoryScope({
    root: f.root,
    cwd: f.main,
    profile: options.profile,
    selector: options.selector,
  });
  readers.add(scope);
  return { scope, config: getDefaultConfig() };
}

describe('database stats options', () => {
  it('rejects retired flags and invalid selectors before opening history', async () => {
    const openContext = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const action = createDatabaseStatsAction({ openContext });
    for (const options of [
      null,
      [],
      { allProjects: true },
      { allBranches: true },
      { scope: 'archive' },
      { project: 'bad' },
      { branch: 2 },
      { origin: 'archive' },
      { state: 'done' },
      { touching: '../secret' },
      { limit: 1 },
      { json: 'yes' },
    ])
      await expect(action(options as DatabaseStatsOptions)).rejects.toBeInstanceOf(CliExit);
    expect(openContext).not.toHaveBeenCalled();
  });

  it('serves the selection copied before its context resolved, not later caller mutations', async () => {
    const f = await fixture();
    const captured = await f.capture();
    await f.capture(undefined, { reason: 'imported' });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let resolve!: (value: Awaited<ReturnType<typeof context>>) => void;
    const opened = new Promise<Awaited<ReturnType<typeof context>>>((done) => {
      resolve = done;
    });
    const openContext = vi.fn((options: ReturnType<typeof validateDatabaseStats>) => {
      void context(f, options).then(resolve);
      return opened;
    });
    const options: DatabaseStatsOptions = { origin: 'captured', json: true };
    const pending = createDatabaseStatsAction({ openContext })(options);
    options.origin = 'imported';
    options.json = false;
    await pending;
    expect(openContext.mock.calls[0][0].filters.origin).toBe('captured');
    const result = JSON.parse(String(stdout.mock.calls[0][0])) as ReturnType<
      typeof readDatabaseStats
    >;
    expect(result.filters.origin).toBe('captured');
    expect(result.artifacts.total).toBe(1);
    expect(result.projects[0].artifacts.by_state).toEqual({ planned: 1 });
    expect(result.imported_artifacts).toBe(0);
    expect(f.writer.read((view) => view.get('SELECT 1 AS one')).value).toEqual({ one: 1 });
    expect(JSON.stringify(result)).not.toContain(captured.slice(0, 8) + '"');
  });

  it('refuses a context that differs from the validated selection', async () => {
    const f = await fixture();
    const ctx = await context(f, validateDatabaseStats({}));
    expect(() =>
      readDatabaseStats(ctx, { scope: 'all-projects' }, DIFF_ATTRIBUTION_NOT_MEASURED)
    ).toThrow(expect.objectContaining({ code: 'SCOPE_CONFLICT' }));
    expect(() =>
      readDatabaseStats(ctx, { branch: 'other' }, DIFF_ATTRIBUTION_NOT_MEASURED)
    ).toThrow(expect.objectContaining({ code: 'SCOPE_CONFLICT' }));
  });
});

describe('database stats composition', { timeout: 30_000 }, () => {
  it('keeps session accounting exact only when every selected project is readable', async () => {
    const a = await fixture();
    const b = await fixture(a.root);
    const first = await a.capture();
    const second = await b.capture();
    await usageObservation(a.writer, first, 10);
    await usageObservation(b.writer, second, 20);
    await usageObservation(b.writer, second, 40, { agent: 'cursor' });
    const options = validateDatabaseStats({ scope: 'all-projects' });
    const ctx = await context(a, options);
    const before = [await inventory(a.temporary), await inventory(b.temporary)];
    const result = readDatabaseStats(ctx, { scope: 'all-projects' }, DIFF_ATTRIBUTION_NOT_MEASURED);
    expect(result.completeness.complete).toBe(true);
    expect(result.coverage).toEqual({
      counted_projects: [a.authority.projectId, b.authority.projectId].sort(),
      unknown_projects: [],
    });
    expect(result.artifacts).toEqual({
      total: 2,
      by_status: { active: 2 },
      by_state: { planned: 2 },
    });
    // The codex tuple observed in both projects counts once at its high water (20), never 10 + 20.
    expect(result.coding_sessions).toEqual({ total: 2, tokens: tokens(60) });
    expect(result.usage.accounting.status).toBe('exact');
    expect(result.usage.projects.map((project) => project.accounting_write_sequence)).toEqual(
      result.usage.projects.map((project) => project.write_sequence)
    );
    expect(result.projects.map((project) => project.coding_sessions.total).sort()).toEqual([1, 2]);
    expect(formatDatabaseStats(result)).toContain('Store stats (all projects)');
    expect(formatDatabaseStats(result)).toContain('coding sessions: 2 (in 60 / out 0');
    expect([await inventory(a.temporary), await inventory(b.temporary)]).toEqual(before);
  });

  it('marks every base section as known contributions when a project is unavailable', async () => {
    const a = await fixture();
    const b = await fixture(a.root);
    await a.capture();
    await b.capture();
    await usageObservation(a.writer, null, 5);
    b.writer.close();
    await a.writer.read(() => null);
    const { rm } = await import('node:fs/promises');
    const { projectDatabasePath } = await import('@orcaops/storage/history/database');
    await rm(projectDatabasePath(b.authority));
    const ctx = await context(a, validateDatabaseStats({ scope: 'all-projects' }));
    const result = readDatabaseStats(ctx, { scope: 'all-projects' }, DIFF_ATTRIBUTION_NOT_MEASURED);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [
        expect.objectContaining({ code: 'HISTORY_MISSING', project_id: b.authority.projectId }),
      ],
    });
    expect(result.coverage).toEqual({
      counted_projects: [a.authority.projectId],
      unknown_projects: [b.authority.projectId],
    });
    expect(result.artifacts.total).toBe(1);
    expect(result.coding_sessions).toEqual({ total: 1, tokens: null });
    expect(result.usage.accounting.status).toBe('partial');
    expect(result.usage.accounting.known_exact_totals).toEqual(tokens(5));
    expect(
      result.projects.find((project) => project.project_id === b.authority.projectId)
    ).toMatchObject({
      state: 'unknown',
      artifacts: { total: 0 },
    });
    const human = formatDatabaseStats(result);
    expect(human).toContain('Unknown contributions: 1 project(s) unavailable');
    expect(human).toContain('known complete sessions only: in 5');
    expect(human).toContain(`${b.authority.projectId}: HISTORY_MISSING`);
  });
});
