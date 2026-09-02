import { describe, expect, it } from 'vitest';

import { diffFileFromPatch } from '../../fromPatch';
import { DEFAULT_DARK_THEME_ID, resolveTheme } from '../themes';
import { buildRowFocusMap } from './focusMask';
import { buildSplitRows, buildStackRows, type DiffRow } from './pierre';

const PATCH = [
  'diff --git a/f.ts b/f.ts',
  'index 0000001..0000002 100644',
  '--- a/f.ts',
  '+++ b/f.ts',
  '@@ -1,8 +1,8 @@',
  ' ctx one',
  '-old two',
  '-old three',
  '+new two',
  '+new three',
  ' ctx four',
  ' ctx five',
  ' ctx six',
  '-old seven',
  '+new seven',
  ' ctx eight',
].join('\n');

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const file = () => diffFileFromPatch(PATCH, { sourceId: 'focus-mask-test' });
const splitRows = () => buildSplitRows(file(), null, theme).filter((row) => row.hunkIndex === 0);
const stackRows = () => buildStackRows(file(), null, theme).filter((row) => row.hunkIndex === 0);

function splitPair(rows: readonly DiffRow[], oldLine: number, newLine: number) {
  return rows.find(
    (row) =>
      row.type === 'split-line' &&
      row.left.lineNumber === oldLine &&
      row.right.lineNumber === newLine
  );
}

describe('buildRowFocusMap', () => {
  it('keeps the union of primary ranges and subdues changed cells between them', () => {
    const rows = splitRows();
    const focus = buildRowFocusMap(rows, [
      { delRange: { start: 2, end: 2 }, addRange: { start: 2, end: 2 } },
      { delRange: { start: 7, end: 7 }, addRange: { start: 7, end: 7 } },
    ]);
    const first = splitPair(rows, 2, 2);
    const middle = splitPair(rows, 3, 3);
    const last = splitPair(rows, 7, 7);

    expect(first).toBeDefined();
    expect(middle).toBeDefined();
    expect(last).toBeDefined();
    expect(focus.get(first!.key)).toBeUndefined();
    expect(focus.get(middle!.key)).toEqual({
      kind: 'split',
      left: 'subdued',
      right: 'subdued',
    });
    expect(focus.get(last!.key)).toBeUndefined();
  });

  it('classifies the two sides of a modified split pair independently', () => {
    const rows = splitRows();
    const row = splitPair(rows, 2, 2);
    expect(row).toBeDefined();

    const focus = buildRowFocusMap(rows, [{ delRange: null, addRange: { start: 2, end: 2 } }]);
    expect(focus.get(row!.key)).toEqual({
      kind: 'split',
      left: 'subdued',
      right: 'primary',
    });
  });

  it('never rewrites canonical kind, move metadata, signs, or syntax spans', () => {
    const deletionSpans = [{ text: 'old', fg: '#123456', bg: '#654321' }];
    const additionSpans = [{ text: 'new', fg: '#abcdef', bg: '#fedcba' }];
    const row: DiffRow = {
      type: 'split-line',
      key: 'syntax-pair',
      fileId: 'f.ts',
      hunkIndex: 0,
      left: {
        kind: 'deletion',
        sign: '-',
        lineNumber: 10,
        moveKind: 'moved',
        spans: deletionSpans,
      },
      right: {
        kind: 'addition',
        sign: '+',
        lineNumber: 11,
        moveKind: 'moved',
        spans: additionSpans,
      },
    };
    const left = row.left;
    const right = row.right;

    const focus = buildRowFocusMap([row], []);

    expect(focus.get(row.key)).toEqual({
      kind: 'split',
      left: 'subdued',
      right: 'subdued',
    });
    expect(row.left).toBe(left);
    expect(row.right).toBe(right);
    expect(row.left).toMatchObject({ kind: 'deletion', sign: '-', moveKind: 'moved' });
    expect(row.right).toMatchObject({ kind: 'addition', sign: '+', moveKind: 'moved' });
    expect(row.left.spans).toBe(deletionSpans);
    expect(row.right.spans).toBe(additionSpans);
    expect(row.left.spans[0]).toEqual({ text: 'old', fg: '#123456', bg: '#654321' });
    expect(row.right.spans[0]).toEqual({ text: 'new', fg: '#abcdef', bg: '#fedcba' });
  });

  it('classifies foreign stack changes without emitting entries for owned changes', () => {
    const rows = stackRows();
    const focus = buildRowFocusMap(rows, [{ delRange: null, addRange: { start: 2, end: 3 } }]);

    for (const row of rows) {
      if (row.type !== 'stack-line' || row.cell.kind === 'context') continue;
      const owned =
        row.cell.kind === 'addition' &&
        row.cell.newLineNumber !== undefined &&
        row.cell.newLineNumber >= 2 &&
        row.cell.newLineNumber <= 3;
      expect(focus.get(row.key)).toEqual(owned ? undefined : { kind: 'stack', cell: 'subdued' });
    }
  });

  it('does not classify synthesized expansion rows as foreign changes', () => {
    const expansion: DiffRow = {
      type: 'stack-line',
      key: 'expanded',
      fileId: 'f.ts',
      hunkIndex: 0,
      isExpansionRow: true,
      cell: {
        kind: 'addition',
        sign: '+',
        newLineNumber: 99,
        spans: [{ text: 'expanded context', fg: '#ffffff' }],
      },
    };

    expect(buildRowFocusMap([expansion], [])).toEqual(new Map());
  });
});
