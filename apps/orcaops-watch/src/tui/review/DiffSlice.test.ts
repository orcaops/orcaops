import { describe, expect, it } from 'vitest';

import type { DiffRow, DiffRowFocus } from '@orcaops/diff-render';

import { rowMatchesLine } from './DiffSlice';

const base = { key: 'k', fileId: 'f.ts', hunkIndex: 0 } as const;
const cell = (kind: string, extra: Record<string, unknown>) =>
  ({ kind, sign: '', spans: [], ...extra }) as never;

describe('rowMatchesLine focus gating', () => {
  it('matches only the primary side of a mixed-focus split pair', () => {
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

    expect(rowMatchesLine(row, 'delete', 5, focus)).toBe(true);
    expect(rowMatchesLine(row, 'add', 6, focus)).toBe(false);
  });

  it('does not match a subdued stack change', () => {
    const row = {
      ...base,
      type: 'stack-line',
      cell: cell('addition', { newLineNumber: 9 }),
    } as DiffRow;

    expect(rowMatchesLine(row, 'add', 9, { kind: 'stack', cell: 'subdued' })).toBe(false);
  });
});
