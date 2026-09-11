import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { uuidv7 } from '@orcaops/storage';
import { projectDatabasePath } from '@orcaops/storage/history/database';

import { fixture, inventory } from '../helpers/database-history.js';
import { listAgent, readList } from '../helpers/database-list.js';

describe('common recorded-file list selection', { timeout: 30_000 }, () => {
  it('uses closed checkpoint paths, exact/glob matching and creation order before paging', async () => {
    const f = await fixture();
    const closed = await f.capture(undefined, { ts: '2026-01-01T00:00:00.000Z' });
    await f.recordFiles(closed, ['src/auth.ts']);
    const other = await f.capture(undefined, { ts: '2026-01-02T00:00:00.000Z' });
    await f.recordFiles(other, ['src/auth.tsx']);
    const open = await f.capture(undefined, { touchedScope: ['src/auth.ts'] });
    await f.mutate(open, 'Pending work', async (draft) => {
      const plan = await draft.readPlan(open);
      return draft.writeCheckpointOpened(
        { artifact_id: open, declared_step_ids: [plan!.plan_steps[0].step_id] },
        { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
      );
    });
    const before = await inventory(f.temporary);
    const exact = await readList(f, ['--touching', 'src/auth.ts']);
    expect(exact.results.map((row) => row.id)).toEqual([closed]);
    expect(exact).toHaveProperty('note', expect.stringContaining('closed checkpoints only'));
    const glob = await readList(f, ['--touching', 'src/*', '--limit', '1']);
    expect(glob.results.map((row) => row.id)).toEqual([other]);
    expect(glob.origin_counts.matching).toEqual({ captured: 2, imported: 0 });
    expect(glob.page.next_offset).toBe(1);
    expect(
      (await readList(f, ['--touching', 'src/*', '--since', '2026-01-02'])).results.map(
        (row) => row.id
      )
    ).toEqual([other]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('preserves literal branch filters and rejects obsolete widening flags', async () => {
    const f = await fixture();
    const main = await f.capture();
    await f.recordFiles(main, ['src/auth.ts']);
    const linked = await f.capture(undefined, { cwd: f.linked });
    await f.recordFiles(linked, ['src/auth.ts']);
    expect(
      new Set((await readList(f, ['--touching', 'src/**'])).results.map((row) => row.id))
    ).toEqual(new Set([main, linked]));
    expect(
      (await readList(f, ['--touching', 'src/**', '--branch', 'linked'])).results.map(
        (row) => row.id
      )
    ).toEqual([linked]);
    expect((await readList(f, ['--touching', 'src/**', '--branch', 'lin*'])).results).toEqual([]);
    expect((await listAgent(f).runRaw(['list', '--all-branches'])).exitCode).not.toBe(0);
  });
  it('discloses invalid path metadata before a state filter can turn it into a complete miss', async () => {
    const f = await fixture();
    const id = await f.capture();
    await f.recordFiles(id, ['src/auth.ts']);
    const raw = new Database(projectDatabasePath(f.authority));
    raw.exec('DELETE FROM artifact_touched_files');
    raw.close();
    const before = await inventory(f.temporary);
    const result = await readList(f, ['--touching', 'src/auth.ts', '--state', 'summarized']);
    expect(result.results).toEqual([]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
