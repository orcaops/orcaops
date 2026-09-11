import { describe, expect, it } from 'vitest';

import type { readCanonicalSearch } from '../../src/lib/history-search.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';

describe('registered search collection and path scope', { timeout: 30_000 }, () => {
  it('filters actual paths before limiting and keeps task tags out of path facts', async () => {
    const f = await fixture();
    const tag = await f.capture(undefined, {
      touchedScope: ['src/auth.ts'],
      ts: '2026-09-06T00:00:00.000Z',
    });
    const auth = await f.capture();
    await f.recordFiles(auth, ['src/auth.ts']);
    const docs = await f.capture();
    await f.recordFiles(docs, ['docs/readme.md']);
    const agent = makeAgent({
      cwd: f.main,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const before = await inventory(f.temporary);
    const raw = await agent.runRaw([
      'search',
      'project narrative',
      '--touching',
      'src/**',
      '--type',
      'plan',
      '--limit',
      '1',
      '--json',
    ]);
    expect(raw.exitCode, raw.stderr).toBe(0);
    const result = JSON.parse(raw.stdout) as Awaited<ReturnType<typeof readCanonicalSearch>>;
    expect(result.results.map((row) => row.artifact_id)).toEqual([auth]);
    expect(result.origin_counts.matching).toEqual({ captured: 1, imported: 0 });
    expect(result.results.some((row) => [tag, docs].includes(row.artifact_id))).toBe(false);
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('merges project pages before offset and accepts project qualification outside Git', async () => {
    const f = await fixture();
    const a = await f.capture();
    const other = await fixture(f.root);
    const b = await other.capture();
    const agent = makeAgent({
      cwd: f.temporary,
      env: { ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
    });
    const read = async (flags: string[]) => {
      const raw = await agent.runRaw([
        'search',
        'project narrative',
        '--type',
        'plan',
        '--json',
        ...flags,
      ]);
      expect(raw.exitCode, raw.stderr).toBe(0);
      return JSON.parse(raw.stdout) as Awaited<ReturnType<typeof readCanonicalSearch>>;
    };
    const all = await read(['--scope', 'all-projects']);
    expect(new Set(all.results.map((row) => row.artifact_id))).toEqual(new Set([a, b]));
    const next = await read(['--scope', 'all-projects', '--offset', '1', '--limit', '1']);
    expect(next.results).toEqual(all.results.slice(1, 2));
    expect(next.page.ranking_complete).toBe(true);
    const selected = await read(['--project', other.authority.projectId]);
    expect(selected.results.map((row) => row.artifact_id)).toEqual([b]);
    expect(selected.code_revision).toBeNull();
  });
});
