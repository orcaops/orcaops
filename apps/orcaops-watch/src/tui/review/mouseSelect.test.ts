import { describe, expect, it } from 'vitest';

import type { DiffRow, DiffRowFocus } from '@orcaops/diff-render';

import {
  changedLineAtColumn,
  changedLineOfRow,
  normalizeSpan,
  splitPaneAtColumn,
} from './mouseSelect';

const base = { key: 'k', fileId: 'f.ts', hunkIndex: 0 } as const;
const cell = (kind: string, extra: Record<string, unknown>) =>
  ({ kind, sign: '', spans: [], ...extra }) as never;

describe('changedLineOfRow', () => {
  it('resolves a split addition to the new-side line', () => {
    const row = {
      ...base,
      type: 'split-line',
      left: cell('empty', {}),
      right: cell('addition', { lineNumber: 42 }),
    } as DiffRow;
    expect(changedLineOfRow(row)).toEqual({ side: 'add', line: 42 });
  });

  it('resolves a split deletion to the old-side line', () => {
    const row = {
      ...base,
      type: 'split-line',
      left: cell('deletion', { lineNumber: 17 }),
      right: cell('empty', {}),
    } as DiffRow;
    expect(changedLineOfRow(row)).toEqual({ side: 'delete', line: 17 });
  });

  it('prefers the addition on a modified split pair (adds before deletes)', () => {
    const row = {
      ...base,
      type: 'split-line',
      left: cell('deletion', { lineNumber: 5 }),
      right: cell('addition', { lineNumber: 6 }),
    } as DiffRow;
    expect(changedLineOfRow(row)).toEqual({ side: 'add', line: 6 });
  });

  it('falls back to an owned deletion when the paired addition is subdued', () => {
    const row = {
      ...base,
      type: 'split-line',
      left: cell('deletion', { lineNumber: 5 }),
      right: cell('addition', { lineNumber: 6 }),
    } as DiffRow;
    const focus: DiffRowFocus = {
      kind: 'split',
      left: 'primary',
      right: 'subdued',
    };
    expect(changedLineOfRow(row, focus)).toEqual({ side: 'delete', line: 5 });
  });

  it('does not target a modified split pair when both sides are subdued', () => {
    const row = {
      ...base,
      type: 'split-line',
      left: cell('deletion', { lineNumber: 5 }),
      right: cell('addition', { lineNumber: 6 }),
    } as DiffRow;
    const focus: DiffRowFocus = {
      kind: 'split',
      left: 'subdued',
      right: 'subdued',
    };
    expect(changedLineOfRow(row, focus)).toBeNull();
  });

  it('resolves stack rows by cell kind', () => {
    const add = {
      ...base,
      type: 'stack-line',
      cell: cell('addition', { newLineNumber: 9 }),
    } as DiffRow;
    const del = {
      ...base,
      type: 'stack-line',
      cell: cell('deletion', { oldLineNumber: 3 }),
    } as DiffRow;
    expect(changedLineOfRow(add)).toEqual({ side: 'add', line: 9 });
    expect(changedLineOfRow(del)).toEqual({ side: 'delete', line: 3 });
  });

  it('does not target a subdued stack change', () => {
    const row = {
      ...base,
      type: 'stack-line',
      cell: cell('addition', { newLineNumber: 9 }),
    } as DiffRow;
    expect(changedLineOfRow(row, { kind: 'stack', cell: 'subdued' })).toBeNull();
  });

  it('returns null for context / header / collapsed / empty rows', () => {
    const context = {
      ...base,
      type: 'split-line',
      left: cell('context', { lineNumber: 1 }),
      right: cell('context', { lineNumber: 1 }),
    } as DiffRow;
    const header = { ...base, type: 'hunk-header', text: '@@' } as DiffRow;
    const collapsed = {
      ...base,
      type: 'collapsed',
      text: '…',
      position: 'before',
      oldRange: [1, 2],
      newRange: [1, 2],
    } as DiffRow;
    expect(changedLineOfRow(context)).toBeNull();
    expect(changedLineOfRow(header)).toBeNull();
    expect(changedLineOfRow(collapsed)).toBeNull();
  });
});

describe('split-row pointer hit testing', () => {
  const modified = {
    ...base,
    type: 'split-line',
    left: cell('deletion', { lineNumber: 5 }),
    right: cell('addition', { lineNumber: 6 }),
  } as DiffRow;

  it('matches the rendered pane boundary at even and odd widths', () => {
    expect(splitPaneAtColumn(80, 39)).toBe('left');
    expect(splitPaneAtColumn(80, 40)).toBe('right');
    expect(splitPaneAtColumn(79, 38)).toBe('left');
    expect(splitPaneAtColumn(79, 39)).toBe('right');
  });

  it('selects the actual side clicked on a modified pair', () => {
    expect(changedLineAtColumn(modified, undefined, 80, 10)).toEqual({
      side: 'delete',
      line: 5,
    });
    expect(changedLineAtColumn(modified, undefined, 80, 70)).toEqual({
      side: 'add',
      line: 6,
    });
  });

  it('does not fall from a subdued right cell through to the owned left cell', () => {
    const focus: DiffRowFocus = {
      kind: 'split',
      left: 'primary',
      right: 'subdued',
    };
    expect(changedLineAtColumn(modified, focus, 80, 10)).toEqual({
      side: 'delete',
      line: 5,
    });
    expect(changedLineAtColumn(modified, focus, 80, 70)).toBeNull();
  });

  it('does not fall from a subdued left cell through to the owned right cell', () => {
    const focus: DiffRowFocus = {
      kind: 'split',
      left: 'subdued',
      right: 'primary',
    };
    expect(changedLineAtColumn(modified, focus, 80, 10)).toBeNull();
    expect(changedLineAtColumn(modified, focus, 80, 70)).toEqual({
      side: 'add',
      line: 6,
    });
  });

  it('keeps an empty split cell inert instead of selecting the opposite side', () => {
    const addition = {
      ...base,
      type: 'split-line',
      left: cell('empty', {}),
      right: cell('addition', { lineNumber: 42 }),
    } as DiffRow;
    expect(changedLineAtColumn(addition, undefined, 80, 10)).toBeNull();
    expect(changedLineAtColumn(addition, undefined, 80, 70)).toEqual({
      side: 'add',
      line: 42,
    });
  });

  it('leaves stack-row resolution independent of horizontal position', () => {
    const stack = {
      ...base,
      type: 'stack-line',
      cell: cell('deletion', { oldLineNumber: 3 }),
    } as DiffRow;
    expect(changedLineAtColumn(stack, undefined, 80, 0)).toEqual({ side: 'delete', line: 3 });
    expect(changedLineAtColumn(stack, undefined, 80, 79)).toEqual({ side: 'delete', line: 3 });
  });
});

describe('normalizeSpan', () => {
  it('orders anchor/head into an inclusive [lo, hi]', () => {
    expect(normalizeSpan(2, 5)).toEqual({ lo: 2, hi: 5 });
    expect(normalizeSpan(5, 2)).toEqual({ lo: 2, hi: 5 });
    expect(normalizeSpan(3, 3)).toEqual({ lo: 3, hi: 3 });
  });
});
