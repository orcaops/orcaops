import Database from 'better-sqlite3';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import type { readDatabaseList } from '../../src/lib/database-list.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

async function list(f: { main: string; root: string }, flags: string[] = []) {
  const agent = makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  });
  const raw = await agent.runRaw(['list', '--json', ...flags]);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return JSON.parse(raw.stdout) as Awaited<ReturnType<typeof readDatabaseList>>;
}
describe('registered database artifact list', { timeout: 30_000 }, () => {
  it('retains every normal field and filters literal branch and start time before paging', async () => {
    const f = await fixture();
    const first = await f.capture(undefined, {
      task: 'First retained\nmultiline task',
      ts: '2026-09-01T00:00:00.000Z',
    });
    await git(f.main, ['checkout', '-qb', 'feature']);
    const second = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    const before = await inventory(f.temporary);
    const all = await list(f);
    expect(all.results.map((row) => row.id)).toEqual([second, first]);
    expect(all.scope).toMatchObject({ kind: 'project', branch: { source: 'all', value: null } });
    expect(all.results[1]).toMatchObject({
      id: first,
      artifact_id: first,
      task: 'First retained\nmultiline task',
      branch: 'main',
      state: 'planned',
      started_at: '2026-09-01T00:00:00.000Z',
      completed_at: null,
      checkpoint_count: 0,
      origin: 'captured',
      project_id: f.authority.projectId,
    });
    expect(
      (await list(f, ['--branch', 'main', '--limit', '1'])).results.map((row) => row.id)
    ).toEqual([first]);
    expect((await list(f, ['--branch', 'ma*'])).results).toEqual([]);
    expect(
      (await list(f, ['--until', '2026-09-01', '--limit', '1'])).results.map((row) => row.id)
    ).toEqual([first]);
    expect((await list(f, ['--offset', '1', '--limit', '1'])).results).toEqual(
      all.results.slice(1)
    );
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('applies common touching before LIMIT without treating task scope tags as file facts', async () => {
    const f = await fixture();
    await f.capture(undefined, { touchedScope: ['src/auth.ts'], ts: '2026-09-07T00:00:00.000Z' });
    const id = await f.capture();
    await f.recordFiles(id, ['src/auth.ts']);
    const before = await inventory(f.temporary);
    const result = await list(f, ['--touching', 'src/**', '--limit', '1']);
    expect(result.results.map((row) => row.id)).toEqual([id]);
    expect(result.origin_counts.matching).toEqual({ captured: 1, imported: 0 });
    expect(result).toHaveProperty('note', expect.stringContaining('closed checkpoints only'));
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('reports missing registered history without recreating its database', async () => {
    const f = await fixture();
    await f.capture();
    f.writer.close();
    await rm(projectDatabasePath(f.authority));
    const before = await inventory(f.temporary);
    const result = await list(f);
    expect(result.results).toEqual([]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_MISSING' })],
    });
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(result.page.ranking_complete).toBe(false);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('discloses damaged derived rows before filtering and never repairs them', async () => {
    const f = await fixture();
    await f.capture();
    const raw = new Database(projectDatabasePath(f.authority));
    raw.exec('DELETE FROM artifact_query_metadata');
    raw.close();
    const before = await inventory(f.temporary);
    const result = await list(f, ['--branch', 'unmatched', '--limit', '1']);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ code: 'HISTORY_INTEGRITY_REQUIRED' })],
    });
    expect(result.results).toEqual([]);
    expect(result.page.truncated).toBe(true);
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
