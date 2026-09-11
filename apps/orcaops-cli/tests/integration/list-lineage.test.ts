import { describe, expect, it } from 'vitest';

import { fixture, git } from '../helpers/database-history.js';
import { listAgent, readList } from '../helpers/database-list.js';

describe('literal list branch membership', { timeout: 30_000 }, () => {
  it('defaults to all branches and retains explicit lineage plus lifecycle and limit filters', async () => {
    const f = await fixture();
    const main = await f.capture();
    await git(f.main, ['checkout', '-qb', 'feature']);
    const feature = await f.capture();
    expect(new Set((await readList(f)).results.map((row) => row.id))).toEqual(
      new Set([main, feature])
    );
    expect(
      (await readList(f, ['--branch', 'main', '--state', 'planned'])).results.map((row) => row.id)
    ).toEqual([main]);
    expect((await readList(f, ['--branch', 'feature', '--state', 'summarized'])).results).toEqual(
      []
    );
    await f.mutate(feature, 'Retain branch history', (draft) =>
      draft.appendBranchLineage(feature, {
        branch: 'retained',
        ts: '2026-09-06T00:00:00.000Z',
        head_sha: f.context.headOid!,
        event: 'rebased',
      })
    );
    expect((await readList(f, ['--branch', 'retained'])).results.map((row) => row.id)).toEqual([
      feature,
    ]);
    expect((await readList(f, ['--branch', 'feature'])).results.map((row) => row.id)).toEqual([
      feature,
    ]);
    expect((await readList(f, ['--limit', '1'])).results).toHaveLength(1);
    expect((await listAgent(f).runRaw(['list', '--limit', '0', '--json'])).exitCode).toBe(1);
  });
});
