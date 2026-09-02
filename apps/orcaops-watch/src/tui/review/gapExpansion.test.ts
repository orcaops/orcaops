import { describe, expect, it } from 'vitest';

import {
  allGapKeys,
  failedSourceStatus,
  fileHasGap,
  type PatchGapHunk,
  setFileGaps,
  settledSourceStatus,
  shouldFetchSource,
  toggleFileGap,
  withSourceStatus,
} from './gapExpansion';
import type { FloorDisplayHunk } from './navigation';
import { SourceTooLargeError } from '../../data/treeSource';

const patch = (...collapsedBefore: number[]): PatchGapHunk[] =>
  collapsedBefore.map((n) => ({ space: 'patch', collapsedBefore: n }));

/** Every patch index has a display host unless a test says otherwise. */
const hosted = (n: number): ReadonlySet<number> => new Set(Array.from({ length: n }, (_, i) => i));

describe('allGapKeys', () => {
  it('enumerates a leading gap per hiding hunk plus the trailing gap on the LAST patch hunk', () => {
    expect([...allGapKeys(patch(4, 0, 12), true, hosted(3))].sort()).toEqual([
      'before:0',
      'before:2',
      'trailing:2',
    ]);
  });

  it('omits the trailing gap when the file hides nothing after its last hunk', () => {
    expect([...allGapKeys(patch(4, 0), false, hosted(2))]).toEqual(['before:0']);
  });

  it('returns nothing for a file that hides no context at all', () => {
    expect([...allGapKeys(patch(0, 0), false, hosted(2))]).toEqual([]);
  });

  it('never emits a key for a patch index no display hunk hosts', () => {
    // The gap row only exists inside its hunk's rendered body — a key for a hunk
    // nothing resolves to would sit inert in the store, never able to settle.
    expect([...allGapKeys(patch(4, 30), true, new Set([0]))]).toEqual(['before:0']);
  });

  it('rejects a floor array at compile time — the two index spaces are not interchangeable', () => {
    const floorHunks: FloorDisplayHunk[] = [
      { space: 'floor', hunkKey: 'h0', status: 'matched', patchHunkIndex: 5, collapsedBefore: 4 },
    ];
    // Structurally a floor item ALSO has `collapsedBefore`, so without the space
    // discriminant this would typecheck and mint `before:0` from a floor ordinal
    // whose real patch index is 5 — a key matching no row, so `z` silently
    // no-ops. Keep it uncompilable.
    // @ts-expect-error floor space is not patch space
    allGapKeys(floorHunks, false, hosted(1));
  });
});

describe('setFileGaps', () => {
  it('replaces the whole set in one write and drops the entry when it empties', () => {
    const set = setFileGaps(new Map(), 'src/a.ts', new Set(['before:0', 'trailing:2']));
    expect([...set.get('src/a.ts')!].sort()).toEqual(['before:0', 'trailing:2']);
    const cleared = setFileGaps(set, 'src/a.ts', new Set());
    expect(cleared.has('src/a.ts')).toBe(false);
  });

  it('keeps untouched files referentially identical and never mutates the input', () => {
    const base = toggleFileGap(new Map(), 'src/a.ts', 'before:0');
    const aSet = base.get('src/a.ts');
    const next = setFileGaps(base, 'src/b.ts', new Set(['before:1']));
    expect(next.get('src/a.ts')).toBe(aSet);
    expect(base.has('src/b.ts')).toBe(false);
  });
});

describe('toggleFileGap', () => {
  it('adds, then removes, dropping the file entry when its set empties', () => {
    const empty = new Map<string, ReadonlySet<string>>();
    const on = toggleFileGap(empty, 'src/a.ts', 'before:0');
    expect(fileHasGap(on, 'src/a.ts', 'before:0')).toBe(true);
    const off = toggleFileGap(on, 'src/a.ts', 'before:0');
    expect(fileHasGap(off, 'src/a.ts', 'before:0')).toBe(false);
    expect(off.has('src/a.ts')).toBe(false);
  });

  it('keeps untouched files identity-stable and never mutates the input', () => {
    const base = toggleFileGap(new Map(), 'src/a.ts', 'before:0');
    const aSet = base.get('src/a.ts');
    const next = toggleFileGap(base, 'src/b.ts', 'trailing:2');
    expect(next.get('src/a.ts')).toBe(aSet); // untouched file: same Set object
    expect(base.has('src/b.ts')).toBe(false); // input map untouched
    expect(fileHasGap(next, 'src/b.ts', 'trailing:2')).toBe(true);
  });

  it('accumulates multiple gaps per file independently', () => {
    let m = toggleFileGap(new Map(), 'src/a.ts', 'before:0');
    m = toggleFileGap(m, 'src/a.ts', 'before:2');
    m = toggleFileGap(m, 'src/a.ts', 'before:0');
    expect(fileHasGap(m, 'src/a.ts', 'before:0')).toBe(false);
    expect(fileHasGap(m, 'src/a.ts', 'before:2')).toBe(true);
  });
});

describe('source status transitions', () => {
  it('fetches from cold and after errors, never over loading/loaded', () => {
    expect(shouldFetchSource(undefined)).toBe(true);
    expect(shouldFetchSource({ kind: 'error' })).toBe(true);
    expect(shouldFetchSource({ kind: 'error', reason: 'too-large' })).toBe(true);
    expect(shouldFetchSource({ kind: 'loading' })).toBe(false);
    expect(shouldFetchSource({ kind: 'loaded', text: 'x' })).toBe(false);
  });

  it('settles text to loaded and null (absent side) to a plain error row', () => {
    expect(settledSourceStatus('a\nb\n')).toEqual({ kind: 'loaded', text: 'a\nb\n' });
    expect(settledSourceStatus(null)).toEqual({ kind: 'error' });
  });

  it('maps the size-cap rejection to too-large, everything else to plain error', () => {
    expect(failedSourceStatus(new SourceTooLargeError(9, 4))).toEqual({
      kind: 'error',
      reason: 'too-large',
    });
    expect(failedSourceStatus(new Error('pinned tree pruned'))).toEqual({ kind: 'error' });
  });

  it('withSourceStatus replaces one file and leaves the rest identity-stable', () => {
    const loaded = { kind: 'loaded', text: 'x' } as const;
    const base = withSourceStatus(new Map(), 'src/a.ts', loaded);
    const next = withSourceStatus(base, 'src/b.ts', { kind: 'loading' });
    expect(next.get('src/a.ts')).toBe(loaded);
    expect(base.has('src/b.ts')).toBe(false);
    expect(next.get('src/b.ts')).toEqual({ kind: 'loading' });
  });
});
