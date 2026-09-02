// Pins the moved-line ordinal convention end to end: buildPatchIndex attaches
// detection output to the parsed DiffFile, and the vendored row builders must
// read it back onto exactly the moved cells. The fixture interleaves context
// between the deletion and addition runs so a wrong convention (nth-add/nth-del
// ordinals instead of metadata line-stream indexes) would tint nothing.

import { describe, expect, it } from 'vitest';

import {
  buildSplitRows,
  buildStackRows,
  DEFAULT_DARK_THEME_ID,
  resolveTheme,
} from '@orcaops/diff-render';

import {
  binaryNoteText,
  buildPatchIndex,
  DEFERRED_MOVE_DETECTION_MIN_BYTES,
  shouldDeferMovedLineDetection,
} from './walkDiff';

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

const NO_MOVE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-const before = oldImplementation();',
  '+const after = newImplementation();',
  ' keep',
  '',
].join('\n');

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);

describe('deferred move-analysis UTF-8 boundary', () => {
  it('uses encoded bytes while avoiding a mandatory full scan for ordinary sizes', () => {
    expect(shouldDeferMovedLineDetection('a'.repeat(DEFERRED_MOVE_DETECTION_MIN_BYTES - 1))).toBe(
      false
    );
    expect(shouldDeferMovedLineDetection('a'.repeat(DEFERRED_MOVE_DETECTION_MIN_BYTES))).toBe(true);

    const multibyte = '界'.repeat(Math.ceil(DEFERRED_MOVE_DETECTION_MIN_BYTES / 3));
    expect(multibyte.length).toBeLessThan(DEFERRED_MOVE_DETECTION_MIN_BYTES);
    expect(shouldDeferMovedLineDetection(multibyte)).toBe(true);
  });

  it('automatically defers a patch that crosses the threshold only after UTF-8 encoding', () => {
    const multibyteBody = '界'.repeat(Math.ceil(DEFERRED_MOVE_DETECTION_MIN_BYTES / 3));
    const raw = [
      'diff --git a/src/multibyte.ts b/src/multibyte.ts',
      '--- a/src/multibyte.ts',
      '+++ b/src/multibyte.ts',
      '@@ -0,0 +1 @@',
      `+${multibyteBody}`,
      '',
    ].join('\n');

    expect(raw.length).toBeLessThan(DEFERRED_MOVE_DETECTION_MIN_BYTES);
    expect(buildPatchIndex(raw).movedLinesPending).toBe(true);
  });
});

describe('buildPatchIndex moved-line attachment', () => {
  it('carries moveKind onto exactly the moved stack cells', () => {
    const file = buildPatchIndex(WITHIN_FILE_MOVE).fileDiff('src/a.ts');
    expect(file).not.toBeNull();
    const cells = buildStackRows(file!, null, theme)
      .filter((row) => row.type === 'stack-line')
      .map((row) => row.cell);

    const movedDeletions = cells
      .filter((c) => c.kind === 'deletion' && c.moveKind === 'moved')
      .map((c) => c.oldLineNumber);
    const movedAdditions = cells
      .filter((c) => c.kind === 'addition' && c.moveKind === 'moved')
      .map((c) => c.newLineNumber);
    expect(movedDeletions).toEqual([2, 3, 4, 5]);
    expect(movedAdditions).toEqual([5, 6, 7, 8]);
    // Every changed cell in this fixture moved; context never tints.
    expect(cells.filter((c) => c.kind !== 'context')).toHaveLength(8);
    expect(cells.filter((c) => c.kind === 'context' && c.moveKind !== undefined)).toHaveLength(0);
  });

  it('carries moveKind onto exactly the moved split cells', () => {
    const file = buildPatchIndex(WITHIN_FILE_MOVE).fileDiff('src/a.ts');
    const rows = buildSplitRows(file!, null, theme).filter((row) => row.type === 'split-line');

    const movedLeft = rows
      .map((row) => row.left)
      .filter((c) => c.kind === 'deletion' && c.moveKind === 'moved')
      .map((c) => c.lineNumber);
    const movedRight = rows
      .map((row) => row.right)
      .filter((c) => c.kind === 'addition' && c.moveKind === 'moved')
      .map((c) => c.lineNumber);
    expect(movedLeft).toEqual([2, 3, 4, 5]);
    expect(movedRight).toEqual([5, 6, 7, 8]);
  });

  it('leaves lineMoveKinds unset when the diff carries no move', () => {
    const file = buildPatchIndex(NO_MOVE).fileDiff('src/a.ts');
    expect(file).not.toBeNull();
    expect(file!.lineMoveKinds).toBeUndefined();
  });

  it('defers large-review move analysis and replaces parsed files immutably on enrichment', () => {
    const scheduled: (() => void)[] = [];
    const index = buildPatchIndex(WITHIN_FILE_MOVE, undefined, {
      movedLineDetection: 'deferred',
      scheduleDeferred: (work) => {
        scheduled.push(work);
      },
    });
    const revisions: number[] = [];
    const unsubscribe = index.subscribeEnrichment((revision) => revisions.push(revision));

    const before = index.fileDiff('src/a.ts');
    expect(before).not.toBeNull();
    expect(before!.lineMoveKinds).toBeUndefined();
    expect(index.movedLinesPending).toBe(true);
    expect(index.enrichmentRevision).toBe(0);
    expect(scheduled).toHaveLength(1);

    while (scheduled.length > 0) scheduled.shift()!();

    const after = index.fileDiff('src/a.ts');
    expect(after).not.toBe(before);
    expect(before!.lineMoveKinds).toBeUndefined();
    expect(after!.lineMoveKinds?.deletionLines.filter(Boolean)).toHaveLength(4);
    expect(after!.lineMoveKinds?.additionLines.filter(Boolean)).toHaveLength(4);
    expect(index.movedLinesPending).toBe(false);
    expect(index.enrichmentRevision).toBe(1);
    expect(revisions).toEqual([1]);
    unsubscribe();
  });

  it('preserves a parsed file identity when deferred analysis finds no moves', () => {
    const scheduled: (() => void)[] = [];
    const index = buildPatchIndex(NO_MOVE, undefined, {
      movedLineDetection: 'deferred',
      scheduleDeferred: (work) => {
        scheduled.push(work);
      },
    });
    const before = index.fileDiff('src/a.ts');
    const unsubscribe = index.subscribeEnrichment(() => undefined);

    while (scheduled.length > 0) scheduled.shift()!();

    expect(index.fileDiff('src/a.ts')).toBe(before);
    expect(index.movedLinesPending).toBe(false);
    expect(index.enrichmentRevision).toBe(0);
    unsubscribe();
  });

  it('cancels obsolete scheduled enrichment when its final observer leaves', () => {
    let scheduled: (() => void) | null = null;
    let cancelled = false;
    const index = buildPatchIndex(WITHIN_FILE_MOVE, undefined, {
      movedLineDetection: 'deferred',
      scheduleDeferred: (work) => {
        scheduled = work;
        return () => {
          cancelled = true;
        };
      },
    });
    const unsubscribe = index.subscribeEnrichment(() => undefined);
    unsubscribe();

    expect(cancelled).toBe(true);
    scheduled!();
    expect(index.movedLinesPending).toBe(true);
    expect(index.enrichmentRevision).toBe(0);
  });
});

const BINARY_AND_TEXT = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1111111..2222222 100644',
  'GIT binary patch',
  'literal 2048',
  'zcmV?<x…',
  '',
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' keep',
  '+const added = 1;',
  '',
].join('\n');

describe('PatchIndex.binaryInfo + binaryNoteText', () => {
  it('flags the binary chunk with its literal size and leaves text files negative', () => {
    const index = buildPatchIndex(BINARY_AND_TEXT);
    expect(index.binaryInfo('assets/logo.png')).toEqual({ binary: true, bytes: 2048 });
    expect(index.binaryInfo('src/a.ts')).toEqual({ binary: false, bytes: null });
    expect(index.binaryInfo('not/in/diff.ts')).toBeNull();
  });

  it('renders the one-row placeholder with and without a byte size', () => {
    expect(binaryNoteText({ binary: true, bytes: 2048 })).toBe(
      'binary file — 2,048 bytes, content not shown'
    );
    expect(binaryNoteText({ binary: true, bytes: null })).toBe('binary file — content not shown');
  });
});

// A complete, LF-terminated review diff: two text files, three hunks in one and
// two in the other, plus a binary chunk. The floor's coverage items are stamped
// from the same patch, so on a healthy generation they must land on every parsed
// hunk exactly once.
const COMPLETE_MULTI_HUNK = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,3 +20,3 @@',
  ' twenty',
  '-twentyone',
  '+TWENTYONE',
  ' twentytwo',
  '@@ -40,3 +40,4 @@',
  ' forty',
  ' fortyone',
  '+INSERTED',
  ' fortytwo',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -5,3 +5,3 @@',
  ' five',
  '-six',
  '+SIX',
  ' seven',
  '@@ -30,3 +30,3 @@',
  ' thirty',
  '-thirtyone',
  '+THIRTYONE',
  ' thirtytwo',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

describe('floor -> parsed-hunk correspondence on a complete diff', () => {
  // EVERY floor item resolves to exactly one parsed hunk. On a complete,
  // LF-terminated diff the floor and the TUI parse the SAME hunk set, so coverage
  // is total and no raw hunk can go unreachable. A failure here means a raw hunk
  // can hide behind the floor, and the display plan would have to be reconciled
  // patch-first.
  //
  // Truncated diffs are in scope too. The parsers diverge at a raw truncation
  // boundary — the fingerprint drops an unterminated final line while
  // diffFileFromPatch appends a newline, and Pierre throws on the resulting count
  // mismatch, taking the whole FILE down with it — so the producer normalizes a
  // truncated review diff back to a complete-hunk boundary before persisting it.
  // That parity is proven at every byte offset of the fixture corpus in
  // truncationParity.test.ts. Between the two files, no raw hunk can hide whether
  // the diff was cut or not.
  it('resolves every floor item to one hunk, covering 0..n-1 exactly once per file', () => {
    const index = buildPatchIndex(COMPLETE_MULTI_HUNK);

    for (const [file, starts] of [
      [
        'src/a.ts',
        [
          { oldStart: 1, newStart: 1 },
          { oldStart: 20, newStart: 20 },
          { oldStart: 40, newStart: 40 },
        ],
      ],
      [
        'src/b.ts',
        [
          { oldStart: 5, newStart: 5 },
          { oldStart: 30, newStart: 30 },
        ],
      ],
    ] as const) {
      const diff = index.fileDiff(file)!;
      expect(diff).not.toBeNull();

      const resolved = starts.map((at) =>
        index.hunkIndex({
          hunkKey: `${file}:${at.oldStart}`,
          file,
          newStart: at.newStart,
          oldStart: at.oldStart,
          added: 1,
          removed: 1,
        })
      );

      // Every floor item resolves...
      expect(resolved.every((idx) => idx !== null)).toBe(true);
      // ...and together they are exactly 0..n-1, once each: no parsed hunk is
      // left without a display node, and none is claimed twice.
      expect([...resolved].sort((a, b) => a! - b!)).toEqual(diff.metadata.hunks.map((_, i) => i));
    }
  });

  it('leaves binary and absent files on their existing placeholder path', () => {
    const index = buildPatchIndex(COMPLETE_MULTI_HUNK);
    // A binary chunk PARSES, into a DiffFile carrying zero hunks — it is
    // binaryInfo, not a parse failure, that routes it to the placeholder. So it
    // satisfies the correspondence invariant trivially rather than being exempt.
    expect(index.fileDiff('assets/logo.png')?.metadata.hunks).toEqual([]);
    expect(index.binaryInfo('assets/logo.png')).toEqual({ binary: true, bytes: null });
    // A file the diff never mentions has no display node at all — the existing
    // 'diff unavailable — truncated or unparseable' path.
    expect(index.fileDiff('never/mentioned.ts')).toBeNull();
    expect(index.binaryInfo('never/mentioned.ts')).toBeNull();
  });
});
