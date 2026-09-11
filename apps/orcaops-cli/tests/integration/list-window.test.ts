import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { fixture, inventory } from '../helpers/database-history.js';
import { listAgent, readList } from '../helpers/database-list.js';

afterEach(() => vi.useRealTimers());
const day = (n: number) => `2026-01-${String(n).padStart(2, '0')}T12:00:00.000Z`;
describe('artifact creation and checkpoint activity windows', { timeout: 30_000 }, () => {
  it('retains original plan/summary points, terminal intervals, dormant gaps and later open work', async () => {
    const f = await fixture();
    const id = await f.capture(undefined, { ts: day(1) });
    vi.useFakeTimers({ toFake: ['Date'] });
    const open = async (n: number) => {
      vi.setSystemTime(new Date(day(n)));
      return f.mutate(id, { day: n }, async (draft) => {
        const plan = await draft.readPlan(id);
        const result = await draft.writeCheckpointOpened(
          { artifact_id: id, declared_step_ids: [plan!.plan_steps[0].step_id] },
          { idempotencyKey: uuidv7(), headSha: f.context.headOid! }
        );
        if (!('checkpoint' in result)) throw new Error('Fixture checkpoint did not open');
        return result.checkpoint.n;
      });
    };
    const first = await open(2);
    vi.setSystemTime(new Date(day(3)));
    await f.mutate(id, 'Close first interval', (draft) =>
      draft.writeCheckpointClosed(
        {
          artifact_id: id,
          n: first,
          head_sha: f.context.headOid!,
          summary: 'Closed interval',
          files_changed: [],
          completed_step_ids: [],
          decisions: [],
          uncertainty: [],
          done_criteria: [],
        },
        { idempotencyKey: uuidv7() }
      )
    );
    const second = await open(5);
    vi.setSystemTime(new Date(day(6)));
    await f.mutate(id, 'Abandon interval', (draft) =>
      draft.writeCheckpointAbandoned(
        { artifact_id: id, n: second, reason: 'Stop this work' },
        { idempotencyKey: uuidv7() }
      )
    );
    await open(9);
    vi.useRealTimers();
    const summary = await f.capture(undefined, { ts: day(1) });
    await f.mutate(summary, 'Final result', (draft) =>
      draft.writeSummary({
        schema_version: 1,
        artifact_id: summary,
        outcome: 'Retained summary point',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: f.context.headOid!,
        ts: day(12),
      })
    );
    const before = await inventory(f.temporary);
    const active = async (n: number) =>
      (await readList(f, ['--active-since', day(n), '--active-until', day(n)])).results.map(
        (row) => row.id
      );
    expect(await active(1)).toEqual(expect.arrayContaining([id, summary]));
    expect(await active(2)).toEqual([id]);
    expect(await active(5)).toEqual([id]);
    expect(await active(4)).toEqual([]);
    expect(await active(7)).toEqual([]);
    expect(await active(10)).toEqual([id]);
    expect(await active(12)).toEqual(expect.arrayContaining([id, summary]));
    expect((await readList(f, ['--until', '2026-01-01'])).results).toHaveLength(2);
    expect((await readList(f, ['--since', '2026-01-02'])).results).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('refuses inverted or invalid windows without changing history', async () => {
    const f = await fixture();
    const before = await inventory(f.temporary);
    for (const flags of [
      ['--since', '2026-07-02', '--until', '2026-07-01'],
      ['--active-since', '2026-07-02', '--active-until', '2026-07-01'],
      ['--active-since', 'yesterday'],
    ]) {
      const result = await listAgent(f).runRaw(['list', '--json', ...flags]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
    }
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
