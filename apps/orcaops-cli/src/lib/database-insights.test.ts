import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDatabaseHistoryScope } from '@orcaops/project-scope/history/database';
import { getDefaultConfig, uuidv7 } from '@orcaops/storage';
import { ProjectDatabaseError } from '@orcaops/storage/history/database';

import {
  type DatabaseInsightOptions,
  readDatabaseDecisions,
  readDatabaseLooseEnds,
  validateDatabaseInsight,
} from './database-insights.js';
import { fixture, inventory } from '../../tests/helpers/database-history.js';
import { createDecisionsAction } from '../commands/decisions.js';
import { createLooseEndsAction } from '../commands/loose-ends.js';
import { CliExit } from '../io/exit.js';

const readers = new Set<{ close(): void }>();
afterEach(() => {
  for (const reader of readers) reader.close();
  readers.clear();
  vi.restoreAllMocks();
});
async function context(
  f: Awaited<ReturnType<typeof fixture>>,
  options: ReturnType<typeof validateDatabaseInsight>
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
const decision = (text: string) => [
  { decision: text, reason: 'Retain the original reason', revision_n: 0 },
];
describe('database history insights', { timeout: 30_000 }, () => {
  it('rejects retired flags, invalid selectors and ineffective exact filters before context', async () => {
    const openContext = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    for (const create of [createDecisionsAction, createLooseEndsAction]) {
      const action = create({ openContext });
      for (const options of [
        { allProjects: true },
        { allBranches: true },
        { state: 'planned' },
        { project: 'bad' },
        { branch: 2 },
        { scope: 'archive' },
        { origin: 'archive' },
        { artifact: 'bad' },
        { artifact: ['bad!'] },
        { artifact: [uuidv7()], branch: 'main' },
        { artifact: [uuidv7()], limit: 1 },
        { artifact: [uuidv7()], touching: '*.ts' },
        { artifact: [uuidv7()], origin: 'all' },
        { limit: 0 },
        { offset: -1 },
        { touching: '../secret' },
        { since: 'bad' },
        { since: 42 },
        { since: '2026-09-02', until: '2026-09-01' },
      ])
        await expect(action(options as DatabaseInsightOptions)).rejects.toBeInstanceOf(CliExit);
    }
    await expect(
      createLooseEndsAction({ openContext })({ artifact: [uuidv7()], since: '2026-09-01' })
    ).rejects.toBeInstanceOf(CliExit);
    expect(openContext).not.toHaveBeenCalled();
  });

  it('reads captured and imported decisions on every branch without changing application history', async () => {
    const f = await fixture();
    const captured = await f.capture(uuidv7(), { decisions: decision('Main decision') });
    const linked = await f.capture(uuidv7(), {
      cwd: f.linked,
      decisions: decision('Linked decision'),
    });
    const imported = await f.capture(uuidv7(), {
      reason: 'imported',
      decisions: decision('Imported decision'),
    });
    const opts = validateDatabaseInsight('decisions', {});
    const ctx = await context(f, opts);
    const before = await inventory(f.root);
    const result = readDatabaseDecisions(ctx, opts);
    expect(result.results.map((row) => row.artifact_id).sort()).toEqual(
      [captured, linked, imported].sort()
    );
    expect(result).toMatchObject({
      schema_version: 3,
      scope: { kind: 'project', branch: { source: 'all' } },
      completeness: { complete: true },
      page: { inspected: 3, returned: 3, next_offset: null },
      origin_counts: { matching: { captured: 2, imported: 1 } },
    });
    expect(
      result.results.every(
        (row) =>
          row.project_id === f.authority.projectId &&
          row.store_instance_id === f.authority.storeInstanceId
      )
    ).toBe(true);
    expect(await inventory(f.root)).toEqual(before);
  });

  it('filters recorded paths, origin and branch before inspecting narratives', async () => {
    const f = await fixture();
    const main = await f.capture(uuidv7(), {
      decisions: decision('Main'),
      ts: '2026-09-01T00:00:00Z',
    });
    await f.recordFiles(main, ['src/preserved.ts']);
    await f.capture(uuidv7(), {
      cwd: f.linked,
      reason: 'imported',
      decisions: decision('Other'),
      ts: '2026-09-02T00:00:00Z',
    });
    const opts = validateDatabaseInsight('decisions', {
      branch: 'main',
      touching: 'src/*.ts',
      origin: 'captured',
      limit: 1,
    });
    const ctx = await context(f, opts);
    const result = readDatabaseDecisions(ctx, opts);
    expect(result.results.map((row) => row.artifact_id)).toEqual([main]);
    expect(result.page.inspected).toBe(1);
    expect(result.origin_counts.matching).toEqual({ captured: 1, imported: 0 });
  });

  it('advances the page by inspected artifacts when no decision survives', async () => {
    const f = await fixture();
    const older = await f.capture(uuidv7(), {
      decisions: decision('Older'),
      ts: '2026-09-01T00:00:00Z',
    });
    await f.capture(uuidv7(), { ts: '2026-09-02T00:00:00Z' });
    const opts = validateDatabaseInsight('decisions', { limit: 1 });
    const ctx = await context(f, opts);
    const first = readDatabaseDecisions(ctx, opts);
    expect(first.results).toEqual([]);
    expect(first.page).toMatchObject({
      inspected: 1,
      returned: 0,
      next_offset: 1,
      truncated: true,
    });
    const second = readDatabaseDecisions(
      ctx,
      validateDatabaseInsight('decisions', { limit: 1, offset: 1 })
    );
    expect(second.results.map((row) => row.artifact_id)).toEqual([older]);
    expect(second.page.next_offset).toBeNull();
  });

  it('filters exact decisions by their original revision dates while loose ends remain current', async () => {
    const f = await fixture();
    const id = await f.capture(uuidv7(), {
      decisions: decision('Old decision'),
      ts: '2026-01-01T00:00:00Z',
    });
    await f.mutate(id, { outcome: 'Retained result' }, (semantics) =>
      semantics.writeSummary({
        schema_version: 1,
        artifact_id: id,
        outcome: 'Retained result',
        tests_written: [],
        tests_run: [],
        open_items: ['Still owed'],
        deferred_decisions: ['Recent deferred decision'],
        head_sha: f.registeredContext.binding.git_context.head_sha!,
        ts: '2026-09-01T00:00:00Z',
      })
    );
    const opts = validateDatabaseInsight('decisions', {
      artifact: [id, id.slice(0, 20)],
      since: '2026-09-01',
    });
    const ctx = await context(f, opts);
    const result = readDatabaseDecisions(ctx, opts);
    expect(result.results[0].records).toEqual([
      expect.objectContaining({
        source: 'summary_deferred',
        decision: 'Recent deferred decision',
        ts: '2026-09-01T00:00:00Z',
      }),
    ]);
    expect(result.page.inspected).toBe(1);
    const loose = readDatabaseLooseEnds(
      ctx,
      validateDatabaseInsight('loose-ends', { artifact: [id] })
    );
    expect(loose.results[0].open_items).toEqual([expect.objectContaining({ text: 'Still owed' })]);
    expect(loose.results[0].deferred_decisions).toEqual([
      expect.objectContaining({ text: 'Recent deferred decision' }),
    ]);
  });

  it('merges independent project selections and discloses an unavailable project', async () => {
    const f = await fixture();
    const other = await fixture(f.root);
    const first = await f.capture(uuidv7(), { decisions: decision('First') });
    const second = await other.capture(uuidv7(), { decisions: decision('Second') });
    const opts = validateDatabaseInsight('decisions', { scope: 'all-projects' });
    const ctx = await context(f, opts);
    const complete = readDatabaseDecisions(ctx, opts);
    expect(complete.results.map((row) => row.artifact_id).sort()).toEqual([first, second].sort());
    const project = ctx.scope.projects.find((p) => p.projectId === other.authority.projectId)!;
    project.database!.close();
    project.database = null;
    const result = readDatabaseDecisions(ctx, opts);
    expect(result.results.map((row) => row.artifact_id)).toEqual([first]);
    expect(result.completeness.complete).toBe(false);
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(result.page).toMatchObject({
      ranking_complete: false,
      truncated: true,
      next_offset: null,
    });
  });

  it('copies options before asynchronous context resolution and closes before emitting', async () => {
    const f = await fixture();
    const id = await f.capture(uuidv7(), { decisions: decision('Original') });
    const options = { artifact: [id], json: true };
    const output: string[] = [];
    let closed = false;
    const action = createDecisionsAction({
      async openContext(prepared) {
        options.artifact[0] = uuidv7();
        const ctx = await context(f, prepared);
        const close = ctx.scope.close;
        ctx.scope.close = () => {
          close();
          closed = true;
        };
        return ctx;
      },
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      expect(closed).toBe(true);
      output.push(String(chunk));
      return true;
    });
    await action(options);
    expect(JSON.parse(output.join('')).results[0].artifact_id).toBe(id);
  });

  it('preserves database error codes and the original failure when cleanup also fails', async () => {
    const f = await fixture();
    const id = await f.capture();
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const action = createLooseEndsAction({
      async openContext(prepared) {
        const ctx = await context(f, prepared);
        ctx.scope.projects[0].database!.close();
        ctx.scope.close = () => {
          throw new Error('Secondary cleanup failure');
        };
        readers.delete(ctx.scope);
        return ctx;
      },
    });
    await expect(action({ artifact: [id], json: true })).rejects.toBeInstanceOf(CliExit);
    const result = JSON.parse(output.join(''));
    expect(result.error.code).not.toBe('INTERNAL');
    expect(result.error.message).not.toContain('Secondary cleanup failure');
    output.length = 0;
    await expect(
      createDecisionsAction({
        openContext: async () => {
          throw new ProjectDatabaseError(
            'HISTORY_INACCESSIBLE',
            'Existing history is inaccessible'
          );
        },
      })({ json: true })
    ).rejects.toBeInstanceOf(CliExit);
    expect(JSON.parse(output.join('')).error.code).toBe('HISTORY_INACCESSIBLE');
  });
});
