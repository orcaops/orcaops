import { describe, expect, it } from 'vitest';

import { normalizeForDetection } from './normalize.js';

const ESC = String.fromCharCode(27);

// Written as escapes throughout: a literal zero-width character in this file
// is invisible to whoever edits it next, which is the whole point of the class.
describe('normalizeForDetection', () => {
  it('returns null when there is nothing to normalize', () => {
    expect(normalizeForDetection('')).toBeNull();
    expect(normalizeForDetection('api_key=plain-ascii-value')).toBeNull();
    // Tab and newline are visible whitespace, not formatting.
    expect(normalizeForDetection('one\ttwo\nthree')).toBeNull();
  });

  it('removes what renders as nothing', () => {
    const invisible = ['\u200B', '\u200C', '\u200D', '\u2060', '\u00AD', '\uFEFF', '\uFE0F'];
    for (const char of invisible) {
      expect(normalizeForDetection(`ab${char}cd`)?.text).toBe('abcd');
    }
    // A combining mark decorates the character before it rather than being
    // strictly invisible, but no credential format admits one.
    expect(normalizeForDetection('e\u0301clair')?.text).toBe('eclair');
  });

  it('folds what renders as a space', () => {
    for (const char of ['\u00A0', '\u2007', '\u202F']) {
      expect(normalizeForDetection(`a${char}b`)?.text).toBe('a b');
    }
  });

  it('removes terminal formatting along with the invisible characters', () => {
    expect(normalizeForDetection(`xoxb${ESC}[31m\u200B-token`)?.text).toBe('xoxb-token');
  });

  it('maps every kept code unit back to the bytes it came from', () => {
    const source = `a\u200Bb${ESC}[31mc\u00A0d`;
    const normalized = normalizeForDetection(source)!;
    expect(normalized.text).toBe('abc d');
    for (let at = 0; at < normalized.text.length; at += 1) {
      const from = normalized.start[at]!;
      expect(normalized.end[at]).toBe(from + 1);
      const original = source.slice(from, from + 1);
      const kept = normalized.text[at];
      // A kept unit is the same character; a folded one renders as the space.
      expect(original === kept || kept === ' ').toBe(true);
    }
  });

  it('anchors a run on the first character it kept, not the formatting before it', () => {
    const source = `${ESC}[31mAKIA${'0'.repeat(16)}`;
    const normalized = normalizeForDetection(source)!;
    expect(normalized.text).toBe(`AKIA${'0'.repeat(16)}`);
    expect(normalized.start[0]).toBe(5);
    expect(normalized.end[normalized.text.length - 1]).toBe(source.length);
  });

  it('holds its index map across the segment-flattening boundary', () => {
    // More kept runs than one internal block holds, so the map has to survive
    // the flush rather than being read off a single contiguous buffer.
    const source = 'x\u200B'.repeat(4096);
    const normalized = normalizeForDetection(source)!;
    expect(normalized.text).toBe('x'.repeat(4096));
    expect(normalized.start[0]).toBe(0);
    expect(normalized.start[4095]).toBe(8190);
    expect(normalized.end[4095]).toBe(8191);
  });
});
