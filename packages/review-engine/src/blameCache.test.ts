import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type BlameCache,
  blameKey,
  loadBlameCache,
  renameInvolvedPaths,
  saveBlameCache,
  type SegmentNameStatus,
  touchingSegShas,
} from './blameCache.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('blameKey', () => {
  it('is deterministic for identical inputs', async () => {
    const a = await blameKey('add', SHA_A, 'src/x.ts', SHA_B, ['c'.repeat(40)]);
    const b = await blameKey('add', SHA_A, 'src/x.ts', SHA_B, ['c'.repeat(40)]);
    expect(a).toBe(b);
  });

  it('changes when ANY component changes', async () => {
    const base = await blameKey('add', SHA_A, 'src/x.ts', SHA_B, ['c'.repeat(40)]);
    const keys = await Promise.all([
      blameKey('delete', SHA_A, 'src/x.ts', SHA_B, ['c'.repeat(40)]), // side
      blameKey('add', SHA_B, 'src/x.ts', SHA_B, ['c'.repeat(40)]), // base commit
      blameKey('add', SHA_A, 'src/y.ts', SHA_B, ['c'.repeat(40)]), // path
      blameKey('add', SHA_A, 'src/x.ts', SHA_A, ['c'.repeat(40)]), // blob
      blameKey('add', SHA_A, 'src/x.ts', SHA_B, ['d'.repeat(40)]), // touching seg
      blameKey('add', SHA_A, 'src/x.ts', SHA_B, []), // no segs
    ]);
    for (const k of keys) expect(k).not.toBe(base);
    expect(new Set(keys).size).toBe(keys.length); // all distinct
  });

  it('is order-sensitive in the touching-segment list', async () => {
    const c = 'c'.repeat(40);
    const d = 'd'.repeat(40);
    const ab = await blameKey('add', SHA_A, 'p', SHA_B, [c, d]);
    const ba = await blameKey('add', SHA_A, 'p', SHA_B, [d, c]);
    expect(ab).not.toBe(ba);
  });
});

describe('renameInvolvedPaths', () => {
  const seg = (commitSha: string, entries: SegmentNameStatus['entries']): SegmentNameStatus => ({
    commitSha,
    entries,
  });

  it('collects both sides of renames/copies and ignores plain edits', () => {
    const segs: SegmentNameStatus[] = [
      seg('1'.repeat(40), [
        { status: 'A', score: null, path: 'new.ts', oldPath: null },
        { status: 'M', score: null, path: 'kept.ts', oldPath: null },
        { status: 'R', score: 100, path: 'to.ts', oldPath: 'from.ts' },
      ]),
      seg('2'.repeat(40), [{ status: 'C', score: 75, path: 'copy.ts', oldPath: 'orig.ts' }]),
    ];
    const involved = renameInvolvedPaths(segs);
    expect(involved).toEqual(new Set(['to.ts', 'from.ts', 'copy.ts', 'orig.ts']));
    expect(involved.has('new.ts')).toBe(false);
    expect(involved.has('kept.ts')).toBe(false);
  });
});

describe('touchingSegShas', () => {
  const c1 = '1'.repeat(40);
  const c2 = '2'.repeat(40);
  const c3 = '3'.repeat(40);
  const segs: SegmentNameStatus[] = [
    { commitSha: c1, entries: [{ status: 'A', score: null, path: 'a.ts', oldPath: null }] },
    { commitSha: c2, entries: [{ status: 'M', score: null, path: 'b.ts', oldPath: null }] },
    {
      commitSha: c3,
      entries: [{ status: 'R', score: 100, path: 'a2.ts', oldPath: 'a.ts' }],
    },
  ];

  it('returns touching segments in chain order, matching new OR old path', () => {
    // a.ts is added by c1 and is the rename SOURCE in c3.
    expect(touchingSegShas('a.ts', segs)).toEqual([c1, c3]);
    expect(touchingSegShas('b.ts', segs)).toEqual([c2]);
    // a2.ts is only the rename TARGET in c3.
    expect(touchingSegShas('a2.ts', segs)).toEqual([c3]);
    expect(touchingSegShas('none.ts', segs)).toEqual([]);
  });
});

describe('loadBlameCache / saveBlameCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'orcaops-blamecache-'));
  });

  it('absent file → empty cache', async () => {
    const c = await loadBlameCache(dir);
    expect(c.size).toBe(0);
  });

  it('round-trips a valid cache', async () => {
    const cache: BlameCache = new Map([
      [
        'k1',
        new Map([
          [1, SHA_A],
          [5, SHA_B],
        ]),
      ],
      ['k2', new Map([[2, SHA_B]])],
    ]);
    await saveBlameCache(dir, cache, dir);
    const loaded = await loadBlameCache(dir);
    expect(loaded.get('k1')).toEqual(
      new Map([
        [1, SHA_A],
        [5, SHA_B],
      ])
    );
    expect(loaded.get('k2')).toEqual(new Map([[2, SHA_B]]));
  });

  it('corrupt JSON → empty cache (no throw)', async () => {
    await writeFile(path.join(dir, 'blame-cache.json'), '{ not json', 'utf8');
    await expect(loadBlameCache(dir)).resolves.toEqual(new Map());
  });

  it('wrong version → empty cache', async () => {
    await writeFile(
      path.join(dir, 'blame-cache.json'),
      JSON.stringify({ version: 'blame.v0', blame: { k: [[1, SHA_A]] } }),
      'utf8'
    );
    expect((await loadBlameCache(dir)).size).toBe(0);
  });

  it('a single structurally-invalid tuple discards the whole file', async () => {
    await writeFile(
      path.join(dir, 'blame-cache.json'),
      JSON.stringify({
        version: 'blame.v1',
        blame: { good: [[1, SHA_A]], bad: [[2, 'not-a-sha']] },
      }),
      'utf8'
    );
    expect((await loadBlameCache(dir)).size).toBe(0);
  });

  it('rejects a non-integer line number', async () => {
    await writeFile(
      path.join(dir, 'blame-cache.json'),
      JSON.stringify({ version: 'blame.v1', blame: { k: [[1.5, SHA_A]] } }),
      'utf8'
    );
    expect((await loadBlameCache(dir)).size).toBe(0);
  });
});
