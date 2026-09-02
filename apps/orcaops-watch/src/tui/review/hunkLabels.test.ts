import { describe, expect, it } from 'vitest';

import { displayLen } from '../layout';
import { hiddenHunkLabel, hideHunkLabel, subduedContextLabel } from './hunkLabels';

const MANY_OWNERS = ['cp1', 'cp2', 'cp3', 'cp4', 'cp5', 'cp6', 'cp7', 'cp8', 'cp9', 'cp10'];

describe('hunk labels', () => {
  it('advertises the key on the collapsed row', () => {
    expect(
      hiddenHunkLabel({ collapsedBefore: 1, added: 3, removed: 0, owners: [], width: 80 })
    ).toBe('▾ z · 1 unchanged + hunk hidden · +3 −0');
  });

  it('drops the context clause when the hunk hides nothing above it', () => {
    expect(
      hiddenHunkLabel({ collapsedBefore: 0, added: 3, removed: 1, owners: [], width: 80 })
    ).toBe('▾ z · hunk hidden · +3 −1');
  });

  it('keeps every label to the ONE row checkpointLayout priced it at', () => {
    // An owner list is unbounded; checkpointLayout prices each of these at exactly
    // one row. A label that wraps drifts the measured geometry, and Walk's
    // rowWindow reads that geometry — so this is a correctness bound, not polish.
    for (const width of [20, 40, 80]) {
      const labels = [
        hiddenHunkLabel({
          collapsedBefore: 120,
          added: 33,
          removed: 44,
          owners: MANY_OWNERS,
          width,
        }),
        hideHunkLabel(width),
        subduedContextLabel(MANY_OWNERS, width),
      ];
      for (const label of labels) expect(displayLen(label)).toBeLessThanOrEqual(width);
    }
  });

  it('still fits when the terminal is narrower than the label itself', () => {
    expect(displayLen(hideHunkLabel(6))).toBeLessThanOrEqual(6);
    expect(
      displayLen(
        hiddenHunkLabel({ collapsedBefore: 9, added: 1, removed: 1, owners: [], width: 8 })
      )
    ).toBeLessThanOrEqual(8);
  });
});
