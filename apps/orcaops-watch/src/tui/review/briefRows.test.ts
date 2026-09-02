import { describe, expect, it } from 'vitest';

import {
  BRIEF_PROSE_LINE_CAP,
  briefStatTileCells,
  briefStepDots,
  fitBriefProseRow,
  fitBriefStatBand,
  wrapProse,
} from './briefRows';

describe('briefStatTileCells', () => {
  it('reserves a floor under every tile so a short value cannot crowd its neighbour', () => {
    // A four-cell label and a four-cell value still occupy the floor plus gap.
    expect(briefStatTileCells({ label: 'PLAN', valueText: '9/10' })).toBe(14);
    // A tile wider than the floor is measured by its widest line.
    expect(briefStatTileCells({ label: 'SCOPE', valueText: '12f +300 −40' })).toBe(16);
  });

  it('charges every tile after the first for the rule drawn before it', () => {
    const two = [
      { key: 'a', label: 'PLAN', valueText: '9/10' },
      { key: 'b', label: 'PLAN', valueText: '9/10' },
    ];
    // 14 for the first, 14 + 1 rule for the second.
    expect(fitBriefStatBand(two, 29)).toHaveLength(2);
    expect(fitBriefStatBand(two, 28)).toHaveLength(1);
  });
});

describe('briefStepDots', () => {
  it('splits the run into done and remaining', () => {
    expect(briefStepDots(3, 6, 12)).toEqual({ done: '●●●', remaining: '○○○', overflow: '' });
  });

  it('sheds everything past the cap into a +N overflow', () => {
    const dots = briefStepDots(2, 20, 5);
    expect(dots.done + dots.remaining).toHaveLength(5);
    expect(dots.overflow).toBe(' +15');
  });

  it('draws a thirteen-step run in full when the cap allows it', () => {
    // The Brief's cap is 24, so a 13-checkpoint branch shows its real shape
    // rather than truncating to twelve dots and a `+1`.
    const dots = briefStepDots(0, 13, 24);
    expect(dots.remaining).toHaveLength(13);
    expect(dots.overflow).toBe('');
    // A genuinely narrow row still sheds, and says so.
    expect(briefStepDots(0, 13, 8).overflow).toBe(' +5');
  });

  it('clamps a done count above the total, and renders nothing at zero width', () => {
    expect(briefStepDots(9, 4, 12)).toEqual({ done: '●●●●', remaining: '', overflow: '' });
    expect(briefStepDots(1, 4, 0)).toEqual({ done: '', remaining: '', overflow: ' +4' });
  });
});

describe('fitBriefStatBand', () => {
  const tiles = [
    { key: 'a', label: 'SCOPE', valueText: '12f +300 −40' },
    { key: 'b', label: 'COVERAGE', valueText: '97%' },
    { key: 'c', label: 'PROGRESS', valueText: '0/9 cp' },
    { key: 'd', label: 'ATTENTION', valueText: '11' },
  ];

  it('keeps every tile when they all fit', () => {
    expect(fitBriefStatBand(tiles, 200).map((tile) => tile.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops the lowest-priority tiles rather than wrapping when space runs out', () => {
    const kept = fitBriefStatBand(tiles, 20).map((tile) => tile.key);
    // A highest-priority prefix only; the tail is shed.
    expect(kept[0]).toBe('a');
    expect(kept.length).toBeLessThan(tiles.length);
  });

  it('always shows at least one tile, even on a terminal too narrow for it', () => {
    expect(fitBriefStatBand(tiles, 1).map((tile) => tile.key)).toEqual(['a']);
  });
});

describe('fitBriefProseRow', () => {
  it('keeps short prose on a single line with the label prefix', () => {
    const row = fitBriefProseRow({ width: 54, label: 'What', value: 'One coherent change.' });
    expect(row.label).toBe('What · ');
    expect(row.lines).toEqual(['One coherent change.']);
  });

  it('wraps a paragraph at word boundaries and indents continuations to the value column', () => {
    const value =
      'The branch advances one coherent change from captured intent through implementation and validation.';
    const row = fitBriefProseRow({ width: 54, label: 'What', value });
    expect(row.lines.length).toBeGreaterThan(1);
    expect(row.indent).toBe('What · '.length);
    // No physical line may exceed the pane: first line shares with the label,
    // continuations get the indent.
    for (const [at, line] of row.lines.entries()) {
      const chrome = at === 0 ? row.label.length : row.indent;
      expect(chrome + line.length).toBeLessThanOrEqual(54);
    }
    // Nothing was lost to a clamp.
    expect(row.lines.join(' ')).toBe(value);
  });

  it('hard-breaks a token wider than the whole line instead of overflowing', () => {
    const row = fitBriefProseRow({ width: 20, label: 'What', value: 'a'.repeat(64) });
    for (const [at, line] of row.lines.entries()) {
      const chrome = at === 0 ? row.label.length : row.indent;
      expect(chrome + line.length).toBeLessThanOrEqual(20);
    }
    expect(row.lines.join('')).toContain('aaaa');
  });

  it('hard-breaks an astral token on code points, never mid-surrogate', () => {
    // `budget` is a displayLen measure and displayLen counts CODE POINTS, so a
    // break that sliced code units cut this token in half: the emitted line
    // ended on a lone high surrogate and the remainder began on its orphaned
    // low half, both rendering as `�`.
    const token = '🙂'.repeat(40);
    const row = fitBriefProseRow({ width: 30, label: 'What', value: token });
    // width 30 − 'What · ' (7) − WRAP_MARGIN (2) on every line.
    const budget = 21;

    const isSurrogate = (point: number): boolean => point >= 0xd800 && point <= 0xdfff;
    for (const line of row.lines) {
      const points = [...line];
      expect(points.every((char) => !isSurrogate(char.codePointAt(0)!))).toBe(true);
      expect(points.length).toBeLessThanOrEqual(budget);
    }
    // Full chunks, measured the way the budget is measured.
    expect([...row.lines[0]!].length).toBe(budget);
    expect([...row.lines[1]!].length).toBe(40 - budget);
    // And nothing was invented or lost in the round trip.
    expect(row.lines.join('')).toBe(token);
  });

  it('caps pathological paragraphs and ellipsizes the tail line', () => {
    const row = fitBriefProseRow({
      width: 24,
      label: 'What',
      value: 'word '.repeat(200).trim(),
    });
    expect(row.lines.length).toBe(BRIEF_PROSE_LINE_CAP);
    expect(row.lines.at(-1)).toContain('…');
  });

  it('survives extremely narrow widths without zero-height output', () => {
    const row = fitBriefProseRow({ width: 3, label: 'What', value: 'text here' });
    expect(row.lines.length).toBeGreaterThanOrEqual(1);
  });
});

describe('wrapProse bounds', () => {
  // The Story banner these rows wrap is an unbounded string, so the cap has to bound
  // the WORK, not just the output: applied only after every line is built, a token
  // long enough to fill a thousand lines builds a thousand so the caller can keep six.
  it('stops one line past the cap instead of wrapping the whole token', () => {
    const token = 'x'.repeat(10_000);
    const lines = wrapProse(token, 20, 20);
    // 10k / 20 is 500 physical lines of real wrapping; emission stops at 7.
    expect(lines.length).toBe(BRIEF_PROSE_LINE_CAP + 1);
    // One PAST the cap, not at it — that is what tells fitBriefProseRow it must
    // ellipsize. Stopping at exactly the cap would silently drop the ellipsis.
    expect(lines.length).toBeGreaterThan(BRIEF_PROSE_LINE_CAP);
    for (const line of lines) expect([...line].length).toBe(20);
  });

  it('bounds a paragraph of many short words the same way', () => {
    // The other line producer: flush() on word boundaries, not the hard break.
    const lines = wrapProse('word '.repeat(2_000).trim(), 20, 20);
    expect(lines.length).toBe(BRIEF_PROSE_LINE_CAP + 1);
  });

  it('bounds a flush that reaches the cap followed by a hard break', () => {
    // The mixed path, which neither bound case above exercises: seven short
    // words each flush a line, and the eighth word is too wide to fit, so it
    // flushes AND hard-breaks in one word iteration — so the cap must be checked
    // after the flush as well as at the top of the word loop and after the
    // hard-break push.
    const lines = wrapProse('aaaa bbbb cccc dddd eeee ffff gggg xxxxxxxxxx', 4, 4);
    expect(lines.length).toBe(BRIEF_PROSE_LINE_CAP + 1);
  });

  it('leaves output at or under the cap untouched', () => {
    // The stop must not perturb the normal case: three lines in, three lines out,
    // with no truncation signalled to the caller.
    const lines = wrapProse('alpha bravo charlie delta echo foxtrot', 12, 12);
    expect(lines.length).toBeLessThanOrEqual(BRIEF_PROSE_LINE_CAP);
    expect(lines.join(' ')).toBe('alpha bravo charlie delta echo foxtrot');
  });

  it('wraps a pathological token in linear time', () => {
    // A complexity guard, not a benchmark. Each word is converted to code points
    // ONCE and consumed by offset; rescanning the remaining token on every chunk is
    // O(n²), which at 80k code points costs ~2s against ~2ms here. The threshold
    // therefore has ~100x headroom while still failing loudly on a rescan.
    const token = '\u{1F642}'.repeat(80_000);
    const started = performance.now();
    const lines = wrapProse(token, 44, 44);
    const elapsedMs = performance.now() - started;
    expect(lines.length).toBe(BRIEF_PROSE_LINE_CAP + 1);
    expect(elapsedMs).toBeLessThan(200);
  });
});
