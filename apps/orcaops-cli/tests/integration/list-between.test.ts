import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { readDatabaseRangeList } from '../../src/lib/database-list-range.js';
import { fixture, git, inventory } from '../helpers/database-history.js';
import { listAgent } from '../helpers/database-list.js';

async function range(f: Parameters<typeof listAgent>[0], value: string) {
  const raw = await listAgent(f).runRaw(['list', '--between', value, '--json']);
  expect(raw.exitCode, raw.stderr || raw.stdout).toBe(0);
  return JSON.parse(raw.stdout) as Awaited<ReturnType<typeof readDatabaseRangeList>>;
}
describe('Git range list compatibility', { timeout: 30_000 }, () => {
  it('retains summary anchors after a checkpoint close and sees linked-worktree records canonically', async () => {
    const f = await fixture();
    const base = f.context.headOid!;
    const id = await f.capture(undefined, { cwd: f.linked });
    await f.recordFiles(id, ['src/linked.ts'], base);
    await git(f.linked, ['commit', '--allow-empty', '-qm', 'Completed linked work']);
    const head = (await git(f.linked, ['rev-parse', 'HEAD'])).stdout.trim();
    await f.mutate(id, 'Linked summary', (draft) =>
      draft.writeSummary({
        schema_version: 1,
        artifact_id: id,
        outcome: 'Completed linked work',
        head_sha: head,
        tests_written: [],
        tests_run: [],
        open_items: [],
        deferred_decisions: [],
        ts: '2026-09-06T00:00:00.000Z',
      })
    );
    const before = await inventory(f.temporary);
    const result = await range(f, `${base}..linked`);
    expect(result.results.map((row) => row.id)).toEqual([id]);
    expect(result.results[0].matched_shas).toEqual([{ source: 'summary', head_sha: head }]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('accepts empty and tag-ended ranges without inventing candidates or reading legacy twins', async () => {
    const f = await fixture();
    const id = await f.capture();
    const base = f.context.headOid!;
    await git(f.main, ['tag', 'retained-endpoint', base]);
    const old = path.join(f.main, '.orcaops', 'artifacts', id);
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'events.ndjson'), 'invalid legacy payload');
    const before = await inventory(f.temporary);
    const empty = await range(f, 'main..main');
    expect(empty.results).toEqual([]);
    expect(empty.unmatched_candidates.map((row) => row.id)).toEqual([id]);
    expect(empty.completeness.complete).toBe(true);
    const tagged = await range(f, `${base}..retained-endpoint`);
    expect(tagged.results).toEqual([]);
    expect(tagged.unmatched_candidates).toEqual([]);
    expect(await inventory(f.temporary)).toEqual(before);
  });
  it('refuses malformed or unresolvable ranges and conflicts without changing history', async () => {
    const f = await fixture();
    const before = await inventory(f.temporary);
    for (const flags of [
      ['--between', 'a...b'],
      ['--between', 'HEAD..'],
      ['--between', 'absent..main'],
      ['--between', 'HEAD..HEAD', '--branch', 'main'],
      ['--between', 'HEAD..HEAD', '--touching', 'src/**'],
      ['--between', 'HEAD..HEAD', '--since', '2026-01-01'],
      ['--between', 'HEAD..HEAD', '--all-branches'],
    ]) {
      const result = await listAgent(f).runRaw(['list', '--json', ...flags]);
      expect(result.exitCode).not.toBe(0);
    }
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
