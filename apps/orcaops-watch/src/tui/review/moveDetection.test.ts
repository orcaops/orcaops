import { describe, expect, it } from 'vitest';

import { createMovedLineDetectionTask, detectMovedLines } from './moveDetection';
import { splitPatchByFile } from './patchSplit';

/** Run detection straight off a raw diff, the way buildPatchIndex feeds it. */
function detect(rawDiff: string) {
  return detectMovedLines(splitPatchByFile(rawDiff));
}

/** The indexes marked 'moved' in one side array (holes and undefined skipped). */
function movedIndexes(side: readonly ('moved' | undefined)[] | undefined): number[] {
  if (side === undefined) return [];
  const out: number[] = [];
  side.forEach((kind, i) => {
    if (kind === 'moved') out.push(i);
  });
  return out;
}

const WITHIN_FILE_MOVE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,9 +1,9 @@',
  ' context1',
  '-function moveMe() {',
  '-  const value = compute();',
  '-  return value + 1;',
  '-}',
  ' context2',
  ' context3',
  ' context4',
  '+function moveMe() {',
  '+  const value = compute();',
  '+  return value + 1;',
  '+}',
  ' context5',
  '',
].join('\n');

describe('detectMovedLines', () => {
  it('tints both sides of a 4-line within-file move at metadata indexes', () => {
    const kinds = detect(WITHIN_FILE_MOVE).get('src/a.ts');
    expect(kinds).toBeDefined();
    // Deletion-side stream: context1(0), the four deleted lines (1-4), then
    // trailing context; addition-side: four context lines (0-3), adds (4-7).
    // Context lines occupying indexes on both sides is the convention the
    // vendored row builders read — nth-add/nth-del ordinals would be 0-3.
    expect(movedIndexes(kinds?.deletionLines)).toEqual([1, 2, 3, 4]);
    expect(movedIndexes(kinds?.additionLines)).toEqual([4, 5, 6, 7]);
  });

  it('matches a block moved ACROSS files, tinting each file on its side', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,1 @@',
      ' keep',
      '-const alpha = makeAlpha();',
      '-const beta = makeBeta();',
      '-const gamma = makeGamma();',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,4 @@',
      ' head',
      '+const alpha = makeAlpha();',
      '+const beta = makeBeta();',
      '+const gamma = makeGamma();',
      '',
    ].join('\n');
    const moves = detect(raw);
    expect(movedIndexes(moves.get('src/a.ts')?.deletionLines)).toEqual([1, 2, 3]);
    expect(movedIndexes(moves.get('src/a.ts')?.additionLines)).toEqual([]);
    expect(movedIndexes(moves.get('src/b.ts')?.additionLines)).toEqual([1, 2, 3]);
    expect(movedIndexes(moves.get('src/b.ts')?.deletionLines)).toEqual([]);
  });

  it('does NOT tint a 2-line match (length guard), however significant', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      '-const first = somethingSubstantial();',
      '-const second = alsoSubstantial();',
      ' keep',
      '+const first = somethingSubstantial();',
      '+const second = alsoSubstantial();',
      '',
    ].join('\n');
    expect(detect(raw).size).toBe(0);
  });

  it('does NOT tint a 3-line brace/blank pile (significance guard)', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,4 @@',
      '-}',
      '-',
      '-};',
      ' keep',
      '+}',
      '+',
      '+};',
      '',
    ].join('\n');
    expect(detect(raw).size).toBe(0);
  });

  it('tints exactly at both bars: 3 lines and 20 significant chars', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,4 @@',
      '-aaaaaaa',
      '-bbbbbbb',
      '-cccccc',
      ' keep',
      '+aaaaaaa',
      '+bbbbbbb',
      '+cccccc',
      '',
    ].join('\n');
    const kinds = detect(raw).get('src/a.ts');
    expect(movedIndexes(kinds?.deletionLines)).toEqual([0, 1, 2]);
    // Addition stream: keep(0) — a context line indexes both sides — adds(1-3).
    expect(movedIndexes(kinds?.additionLines)).toEqual([1, 2, 3]);
  });

  it('consumes only the FIRST of two identical added blocks (order-consistent)', () => {
    const raw = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,5 +1,8 @@',
      '-const one = buildOne();',
      '-const two = buildTwo();',
      '-const three = buildThree();',
      ' top',
      '+const one = buildOne();',
      '+const two = buildTwo();',
      '+const three = buildThree();',
      ' middle',
      '+const one = buildOne();',
      '+const two = buildTwo();',
      '+const three = buildThree();',
      '',
    ].join('\n');
    const kinds = detect(raw).get('src/x.ts');
    expect(movedIndexes(kinds?.deletionLines)).toEqual([0, 1, 2]);
    // Addition stream: top(0), first block(1-3), middle(4), second block(5-7).
    expect(movedIndexes(kinds?.additionLines)).toEqual([1, 2, 3]);
  });

  it('ignores trailing whitespace but keeps leading whitespace significant', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,7 +1,7 @@',
      '-const alpha = makeAlpha();',
      '-const beta = makeBeta();',
      '-const gamma = makeGamma();',
      ' keep1',
      '+const alpha = makeAlpha();  ',
      '+const beta = makeBeta();\t',
      '+const gamma = makeGamma();',
      ' keep2',
      '-const delta = makeDelta();',
      '-const epsilon = makeEpsilon();',
      '-const zeta = makeZeta();',
      ' keep3',
      '+  const delta = makeDelta();',
      '+  const epsilon = makeEpsilon();',
      '+  const zeta = makeZeta();',
      '',
    ].join('\n');
    const kinds = detect(raw).get('src/a.ts');
    // First block matches despite destination trailing whitespace; the second
    // (re-indented) does not — leading whitespace makes it a rewrite.
    expect(movedIndexes(kinds?.deletionLines)).toEqual([0, 1, 2]);
    expect(movedIndexes(kinds?.additionLines)).toEqual([1, 2, 3]);
  });

  it('keys a rename chunk under both names with the same kinds object', () => {
    const raw = [
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 90%',
      'rename from old/name.ts',
      'rename to new/name.ts',
      '--- a/old/name.ts',
      '+++ b/new/name.ts',
      '@@ -1,5 +1,5 @@',
      ' keep1',
      '-const alpha = makeAlpha();',
      '-const beta = makeBeta();',
      '-const gamma = makeGamma();',
      ' keep2',
      '+const alpha = makeAlpha();',
      '+const beta = makeBeta();',
      '+const gamma = makeGamma();',
      '',
    ].join('\n');
    const moves = detect(raw);
    expect(moves.get('old/name.ts')).toBeDefined();
    expect(moves.get('new/name.ts')).toBe(moves.get('old/name.ts'));
  });

  it('returns nothing for a diff without moves and for an empty diff', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-const before = oldImplementation();',
      '+const after = newImplementation();',
      ' keep',
      '',
    ].join('\n');
    expect(detect(raw).size).toBe(0);
    expect(detect('').size).toBe(0);
  });

  it('cooperatively converges to the exact synchronous result across bounded slices', () => {
    const patches = splitPatchByFile(WITHIN_FILE_MOVE);
    const expected = detectMovedLines(patches);
    const task = createMovedLineDetectionTask(patches, {
      maxSliceMs: Number.POSITIVE_INFINITY,
      maxOperationsPerSlice: 5,
    });
    let actual: ReturnType<typeof detectMovedLines> | null = null;
    let slices = 0;
    while (actual === null) {
      actual = task.runSlice();
      slices += 1;
    }

    expect(slices).toBeGreaterThan(3);
    expect(actual).toEqual(expected);
  });

  it('yields through partitioning, exact-key matching, and marking of one long short-line run', () => {
    const lineCount = 180;
    const bodies = Array.from(
      { length: lineCount },
      (_, index) => `const moved_${index} = source_${index};`
    );
    const raw = [
      'diff --git a/src/large.ts b/src/large.ts',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      `@@ -1,${lineCount + 1} +1,${lineCount + 1} @@`,
      ...bodies.map((body) => `-${body}`),
      ' anchor',
      ...bodies.map((body) => `+${body}`),
      '',
    ].join('\n');
    const task = createMovedLineDetectionTask(splitPatchByFile(raw), {
      maxSliceMs: Number.POSITIVE_INFINITY,
      maxOperationsPerSlice: 1,
    });
    let actual: ReturnType<typeof detectMovedLines> | null = null;
    let slices = 0;
    while (actual === null) {
      actual = task.runSlice();
      slices += 1;
    }

    // Collection alone accounts for roughly two operations per body. Requiring
    // substantially more proves the partition/key/match/mark operations are
    // traversed cooperatively too, without a timing oracle.
    expect(slices).toBeGreaterThan(lineCount * 6);
    expect(movedIndexes(actual.get('src/large.ts')?.deletionLines)).toHaveLength(lineCount);
    expect(movedIndexes(actual.get('src/large.ts')?.additionLines)).toHaveLength(lineCount);
  });
});
