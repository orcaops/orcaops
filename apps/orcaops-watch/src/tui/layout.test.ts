import { describe, expect, it } from 'vitest';

import { cell, displayLen, progressBar, sparkCells, truncate } from './layout.js';

describe('fit / pad', () => {
  it('truncates with a single-cell ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(displayLen(truncate('hello world', 5))).toBe(5);
    expect(truncate('hi', 5)).toBe('hi');
  });

  it('pads to exactly the column width, both alignments', () => {
    expect(cell('hi', 6)).toBe('hi    ');
    expect(cell('hi', 6, 'right')).toBe('    hi');
    expect(displayLen(cell('a-very-long-value', 6))).toBe(6);
  });

  it('measures a width-1 glyph as one cell', () => {
    expect(displayLen('●ab')).toBe(3);
    expect(displayLen(cell('●ready', 4))).toBe(4);
  });
});

describe('progressBar', () => {
  it('fills done+todo to exactly the bar width with a label', () => {
    const p = progressBar(2, 5, 12);
    expect(p.label).toBe('2/5');
    expect(displayLen(p.done + p.todo)).toBe(12 - '2/5'.length - 1);
    expect(p.done).toContain('▓');
    expect(p.todo).toContain('░');
  });

  it('fills completely when complete and shows an em-dash with no steps', () => {
    const full = progressBar(6, 6, 12);
    expect(full.todo).toBe('');
    expect(progressBar(0, 0, 12).label).toBe('—');
  });
});

describe('sparkCells', () => {
  it('always returns width cells, right-aligned with a visible baseline', () => {
    const cells = sparkCells([0, 0, 3], 8);
    expect(cells).toHaveLength(8);
    // Left-padded zeros render the faint baseline, never a blank.
    expect(cells.slice(0, 5).every((c) => c.state === 'off' && c.char === '▁')).toBe(true);
  });

  it('glows the most recent non-empty bucket only', () => {
    const cells = sparkCells([1, 4, 2, 0], 4);
    const glow = cells.filter((c) => c.state === 'glow');
    expect(glow).toHaveLength(1);
    expect(cells[2]?.state).toBe('glow');
    expect(cells[3]?.state).toBe('off');
  });

  it('renders an all-idle agent as a flat off track', () => {
    const cells = sparkCells([], 6);
    expect(cells.every((c) => c.state === 'off')).toBe(true);
  });
});
