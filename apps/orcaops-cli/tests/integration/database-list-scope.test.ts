import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '@orcaops/storage';

import { fixture, inventory } from '../helpers/database-history.js';
import { listAgent, readList } from '../helpers/database-list.js';

afterEach(() => vi.restoreAllMocks());
describe('registered list scope selection', { timeout: 30_000 }, () => {
  it('merges unequal projects before paging and supports explicit project reads outside Git', async () => {
    const first = await fixture();
    const second = await fixture(first.root);
    const oldest = await first.capture(undefined, { ts: '2026-01-01T00:00:00.000Z' });
    const middle = await first.capture(undefined, { ts: '2026-01-03T00:00:00.000Z' });
    const newest = await first.capture(undefined, { ts: '2026-01-04T00:00:00.000Z' });
    await second.capture(oldest, { ts: '2026-01-02T00:00:00.000Z', reason: 'imported' });
    const before = [await inventory(first.temporary), await inventory(second.temporary)];
    const statements: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      statements.push(sql);
      return prepare.call(this, sql);
    });
    const all = await readList(first, ['--scope', 'all-projects'], first.temporary);
    expect(all.results.map((row) => [row.project_id, row.id])).toEqual([
      [first.authority.projectId, newest],
      [first.authority.projectId, middle],
      [second.authority.projectId, oldest],
      [first.authority.projectId, oldest],
    ]);
    const page = await readList(first, [
      '--scope',
      'all-projects',
      '--offset',
      '1',
      '--limit',
      '2',
    ]);
    expect(page.results).toEqual(all.results.slice(1, 3));
    expect(page.page).toMatchObject({ next_offset: 3, truncated: true, ranking_complete: true });
    expect(page.origin_counts.matching).toEqual({ captured: 3, imported: 1 });
    const selected = await readList(
      first,
      ['--project', second.authority.projectId],
      first.temporary
    );
    expect(selected.results.map((row) => row.project_id)).toEqual([second.authority.projectId]);
    expect(selected.results[0].origin).toBe('git-import');
    expect(
      (await readList(first, ['--scope', 'all-projects', '--origin', 'captured'])).results
    ).toHaveLength(3);
    expect(
      (await readList(first, ['--scope', 'all-projects', '--origin', 'imported'])).results
    ).toHaveLength(1);
    vi.restoreAllMocks();
    // The completeness check may read one finite scalar from details_json; the
    // list read must never hydrate or filter on the bodies themselves.
    const bodies = statements
      .join('\n')
      .replaceAll("json_extract(q.details_json,'$.historicalStepCount')", '');
    expect(bodies).not.toMatch(
      /SELECT[^;]*(?:record_bytes|sidecar_payload_bytes|state_json|details_json)/iu
    );
    expect([await inventory(first.temporary), await inventory(second.temporary)]).toEqual(before);
  });
  it('preserves known worktree matches and discloses unknown associations as incomplete', async () => {
    const f = await fixture();
    const main = await f.capture();
    const linked = await f.capture(undefined, { cwd: f.linked });
    const unknown = await f.capture(undefined, { reason: 'legacy_unknown' });
    const before = await inventory(f.temporary);
    expect(new Set((await readList(f)).results.map((row) => row.id))).toEqual(
      new Set([main, linked, unknown])
    );
    const selected = await readList(f, ['--scope', 'worktree']);
    expect(selected.results.map((row) => row.id)).toEqual([main]);
    expect(selected.completeness.complete).toBe(false);
    expect(selected.completeness.issues).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_WORKTREE_ASSOCIATION', count: 1 })
    );
    expect(selected.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(selected.page.ranking_complete).toBe(false);
    expect(
      (await readList(f, ['--scope', 'worktree'], f.linked)).results.map((row) => row.id)
    ).toEqual([linked]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('reports exact blocked and summarized lifecycle states before filters and paging', async () => {
    const f = await fixture();
    const blocked = await f.capture(undefined, { ts: '2026-01-03T00:00:00.000Z' });
    const complete = await f.capture(undefined, {
      ts: '2026-01-02T00:00:00.000Z',
      reason: 'completed',
    });
    await f.mutate(blocked, 'Retain blocking evaluator', (draft) =>
      draft.writeEvaluatorRunPayload(blocked, {
        schema: 'orcaops.evaluator_run/v1',
        run_id: uuidv7(),
        artifact_id: blocked,
        evaluator_ref: 'test/retained',
        package_id: 'test',
        evaluator_id: 'retained',
        phase: 'pre-pr',
        severity: 'block',
        run_status: 'completed',
        verdict: 'violation',
        body: 'VIOLATION\n\nRetained blocking evidence',
        ts: '2026-01-04T00:00:00.000Z',
      })
    );
    const before = await inventory(f.temporary);
    const all = await readList(f);
    expect(all.results.map((row) => [row.id, row.state])).toEqual([
      [blocked, 'blocked'],
      [complete, 'summarized'],
    ]);
    expect(
      (await readList(f, ['--state', 'summarized', '--limit', '1'])).results.map((row) => row.id)
    ).toEqual([complete]);
    expect(
      (await readList(f, ['--state', 'blocked', '--limit', '1'])).results.map((row) => row.id)
    ).toEqual([blocked]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('refuses malformed selectors without initializing an absent history root', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'database-list-absent-'));
    try {
      const f = { main: temporary, root: path.join(temporary, 'absent') };
      const before = await inventory(temporary);
      for (const flags of [
        ['--since', 'garbage'],
        ['--project', 'not-a-uuid'],
        ['--limit', '0'],
        ['--scope', 'all-projects', '--between', 'main..feature'],
      ]) {
        const result = await listAgent(f).runRaw(['list', '--json', ...flags]);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: expect.stringMatching(/INVALID_INPUT|SCOPE_CONFLICT/u) },
        });
      }
      expect(await inventory(temporary)).toEqual(before);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
