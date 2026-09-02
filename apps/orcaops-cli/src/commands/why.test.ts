import { describe, expect, it } from 'vitest';

import type { WhyMatch } from '@orcaops/core';

import {
  parseTarget,
  renderWholeFileCompactHistory,
  renderWholeFileCompactRecord,
  wholeFileMarkers,
} from './why.js';

function whyMatch(overrides: Partial<WhyMatch> = {}): WhyMatch {
  return {
    artifact_id: '01a05b1a-52b1-79f4-8937-b22021aa5ce6',
    branch: 'main',
    task: 'fixture task',
    checkpoint_n: 1,
    checkpoint_summary: 'fixture summary',
    checkpoint_head_sha: '0123456789abcdef0123456789abcdef01234567',
    ts: '2026-09-01T03:54:06.887Z',
    confidence: 'weak',
    reason: 'whole-file fixture',
    cross_file: false,
    open_plan_revision_event_id: '01a05b1a-54e8-7dbc-afc8-93c9146345bb',
    plan_decisions: [],
    checkpoint_decisions: [],
    ...overrides,
  };
}

describe('parseTarget', () => {
  it('missing colon is whole-file mode: line null', () => {
    expect(parseTarget('src/foo.ts')).toEqual({ file: 'src/foo.ts', line: null });
  });

  it('empty target throws INVALID_INPUT (path: file)', () => {
    expect(() => parseTarget('')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'file' })
    );
  });

  it('empty file (:1) throws INVALID_INPUT (path: file)', () => {
    expect(() => parseTarget(':1')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'file' })
    );
  });

  it('non-integer line throws INVALID_INPUT (path: line)', () => {
    expect(() => parseTarget('src/foo.ts:abc')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'line' })
    );
  });

  it('zero or negative line throws INVALID_INPUT (path: line)', () => {
    expect(() => parseTarget('src/foo.ts:0')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'line' })
    );
    expect(() => parseTarget('src/foo.ts:-3')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', inputPath: 'line' })
    );
  });

  it('splits on the LAST colon so filenames containing colons round-trip', () => {
    // Filename like "weird:name.ts:5" — split on the LAST colon, parsed
    // file is "weird:name.ts" and line is 5.
    expect(parseTarget('weird:name.ts:5')).toEqual({ file: 'weird:name.ts', line: 5 });
  });
});

describe('whole-file compact history', () => {
  it.each([
    [{ origin: { kind: 'git-import' as const } }, '[origin:git-import]'],
    [{ overlap: 'ambiguous' as const }, '[overlap:ambiguous]'],
    [{ overlap: 'mixed_segment' as const }, '[overlap:mixed_segment]'],
    [{ overlap: 'own_claim_pending' as const }, '[overlap:own_claim_pending]'],
    [{ degraded: 'unmerged_paths' as const }, '[degraded:unmerged_paths]'],
    [{ degraded: 'probe_failed' as const }, '[degraded:probe_failed]'],
  ])('maps %o to %s', (state, marker) => {
    expect(wholeFileMarkers(whyMatch(state))).toContain(marker);
  });

  it('co-renders independent qualification classes with the full artifact id', () => {
    const match = whyMatch({
      origin: { kind: 'git-import' },
      overlap: 'ambiguous',
      degraded: 'probe_failed',
    });
    const record = renderWholeFileCompactRecord(match);
    expect(record).toContain('[origin:git-import]');
    expect(record).toContain('[overlap:ambiguous]');
    expect(record).toContain('[degraded:probe_failed]');
    expect(record).toContain(`artifact=${match.artifact_id}`);
    expect(record).toMatch(/^2026-09-01T03:54:06Z /u);
  });

  it('keeps high-volume history ordered, one-line, and summary-bounded', () => {
    const matches = Array.from({ length: 25 }, (_, index) =>
      whyMatch({
        artifact_id: `artifact-${String(index).padStart(2, '0')}-full-identity`,
        checkpoint_n: 25 - index,
        checkpoint_summary: `checkpoint ${25 - index}\n${'x'.repeat(300)}`,
      })
    );
    const records = renderWholeFileCompactHistory(matches).split('\n');

    expect(records).toHaveLength(matches.length);
    expect(records.map((record) => Number(/ #(\d+) /u.exec(record)?.[1]))).toEqual(
      matches.map((match) => match.checkpoint_n)
    );
    for (const [index, record] of records.entries()) {
      const summary = /\[main\] (.+) artifact=/u.exec(record)?.[1];
      expect(summary?.length).toBeLessThanOrEqual(120);
      expect(record).toContain(`artifact=${matches[index].artifact_id}`);
      expect(record).not.toContain('\r');
    }
  });
});
