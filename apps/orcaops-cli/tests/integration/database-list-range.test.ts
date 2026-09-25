import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDatabasePath } from '@orcaops/storage/history/database';

import type { readDatabaseRangeList } from '../../src/lib/database-list-range.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

afterEach(() => vi.restoreAllMocks());
async function list(f: { main: string; root: string }, range: string, flags: string[] = []) {
  const raw = await makeAgent({
    cwd: f.main,
    env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
  }).runRaw(['list', '--between', range, '--json', ...flags]);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return JSON.parse(raw.stdout) as Awaited<ReturnType<typeof readDatabaseRangeList>>;
}
describe('recorded Git range listing', { timeout: 30_000 }, () => {
  it('filters recorded anchors before paging and preserves unmatched lineage candidates without artifact hydration', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Next retained commit']);
    const head = (await git(f.main, ['rev-parse', 'HEAD'])).stdout.trim();
    const matched = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    await f.recordFiles(matched, ['src/main.ts'], head);
    const unmatched = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    const before = await inventory(f.temporary);
    const statements: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      statements.push(sql);
      return prepare.call(this, sql);
    });
    const result = await list(f, `${base}..main`, ['--limit', '1']);
    vi.restoreAllMocks();
    expect(result.results.map((row) => row.id)).toEqual([matched]);
    expect(result.results[0].matched_shas).toEqual([
      { source: 'checkpoint', n: 1, head_sha: head },
    ]);
    expect(result.unmatched_candidates).toEqual([
      expect.objectContaining({ id: unmatched, reason: 'no_head_sha_in_range' }),
    ]);
    expect(result.origin_counts.matching).toEqual({ captured: 1, imported: 0 });
    expect(result.page.truncated).toBe(false);
    expect(result.between).toMatchObject({
      from_sha: base,
      to_sha: head,
      ref2_local_branch: 'main',
      rev_list_count: 1,
    });
    expect(statements.join('\n')).not.toMatch(
      /SELECT[^;]*(?:record_bytes|sidecar_payload_bytes)/iu
    );
    expect((await list(f, `${base}..main`, ['--offset', '1', '--limit', '1'])).results).toEqual([]);
    expect((await list(f, `${base}..${head}`)).unmatched_candidates).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('keeps exact origin filters and reports invalid metadata as incomplete rather than absence', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Historical endpoint']);
    const head = (await git(f.main, ['rev-parse', 'HEAD'])).stdout.trim();
    const imported = await f.capture(undefined, { reason: 'imported' });
    await f.recordFiles(imported, ['readme.md'], head);
    const captured = await f.capture();
    await f.recordFiles(captured, ['src/main.ts'], head);
    const selected = await list(f, `${base}..main`, ['--origin', 'imported']);
    expect(selected.results.map((row) => row.id)).toEqual([imported]);
    const raw = new Database(projectDatabasePath(f.authority));
    raw
      .prepare(
        "UPDATE artifact_query_metadata SET details_json=json_set(details_json,'$.anchors',NULL) WHERE artifact_id=?"
      )
      .run(captured);
    raw.close();
    const before = await inventory(f.temporary);
    const result = await list(f, `${base}..main`);
    expect(result.results.map((row) => row.id)).toEqual([imported]);
    expect(result.completeness).toMatchObject({
      complete: false,
      issues: [
        expect.objectContaining({ artifact_id: captured, code: 'HISTORY_INTEGRITY_REQUIRED' }),
      ],
    });
    expect(result.origin_counts.matching).toEqual({ captured: null, imported: null });
    expect(result.page.ranking_complete).toBe(false);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('lists only artifacts whose anchors ref2 cannot reach as possibly rebased away', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const landed = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    await f.recordFiles(landed, ['src/main.ts'], base);
    const tree = (await git(f.main, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const rewritten = (
      await git(f.main, ['commit-tree', tree, '-p', base, '-m', 'Commit replaced by a rebase'])
    ).stdout.trim();
    const rebased = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    await f.recordFiles(rebased, ['src/main.ts'], rewritten);
    const missing = await f.capture(undefined, { ts: '2026-09-03T00:00:00.000Z' });
    await f.recordFiles(missing, ['src/main.ts'], 'f'.repeat(40));
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Range start']);
    await git(f.main, ['tag', 'range-start']);
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Range end']);
    const candidates = async (range: string) =>
      (await list(f, range)).unmatched_candidates.map((row) => row.id).sort();
    const expected = [rebased, missing].sort();
    expect(await candidates('range-start..main')).toEqual(expected);
    expect(await candidates('HEAD..main')).toEqual(expected);
  });
  it('decides a multi-anchor artifact by its latest anchor', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Work that landed before the range']);
    const landed = (await git(f.main, ['rev-parse', 'HEAD'])).stdout.trim();
    const tree = (await git(f.main, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const rewritten = (
      await git(f.main, ['commit-tree', tree, '-p', landed, '-m', 'Commit replaced by a rebase'])
    ).stdout.trim();
    const straddling = await f.capture(undefined, { ts: '2026-09-01T00:00:00.000Z' });
    await f.recordFiles(straddling, ['src/main.ts'], landed);
    await f.recordFiles(straddling, ['src/main.ts'], rewritten);
    const allBefore = await f.capture(undefined, { ts: '2026-09-02T00:00:00.000Z' });
    await f.recordFiles(allBefore, ['src/main.ts'], base);
    await f.recordFiles(allBefore, ['src/main.ts'], landed);
    const latestLanded = await f.capture(undefined, { ts: '2026-09-03T00:00:00.000Z' });
    await f.recordFiles(latestLanded, ['src/main.ts'], rewritten);
    await f.recordFiles(latestLanded, ['src/main.ts'], landed);
    const summarized = await f.capture(undefined, { ts: '2026-09-04T00:00:00.000Z' });
    await f.recordFiles(summarized, ['src/main.ts'], rewritten);
    await f.mutate(summarized, { outcome: 'Landed' }, (semantics) =>
      semantics.writeSummary({
        schema_version: 1,
        artifact_id: summarized,
        outcome: 'Landed',
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        head_sha: landed,
        ts: '2026-09-04T00:00:00.000Z',
      })
    );
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Range start']);
    await git(f.main, ['tag', 'range-start']);
    await git(f.main, ['commit', '--allow-empty', '-qm', 'Range end']);
    const result = await list(f, 'range-start..main');
    expect(result.results).toEqual([]);
    expect(result.unmatched_candidates.map((row) => row.id)).toEqual([straddling]);
  });
});
