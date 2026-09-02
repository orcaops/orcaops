import { describe, expect, it } from 'vitest';

import { parseNameStatusZ } from './git.js';

describe('parseNameStatusZ', () => {
  it('parses A/M/D entries', () => {
    const r = parseNameStatusZ('A\0new.ts\0M\0kept.ts\0D\0gone.ts\0');
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([
      { status: 'A', score: null, path: 'new.ts', oldPath: null },
      { status: 'M', score: null, path: 'kept.ts', oldPath: null },
      { status: 'D', score: null, path: 'gone.ts', oldPath: null },
    ]);
  });

  it('parses scored rename/copy with both paths', () => {
    const r = parseNameStatusZ('R100\0from.ts\0to.ts\0C075\0orig.ts\0copy.ts\0');
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([
      { status: 'R', score: 100, path: 'to.ts', oldPath: 'from.ts' },
      { status: 'C', score: 75, path: 'copy.ts', oldPath: 'orig.ts' },
    ]);
  });

  it('preserves a path containing tab/newline bytes (raw -z, never Git-quoted)', () => {
    const weird = 'we\tird\nname.ts';
    const r = parseNameStatusZ(`M\0${weird}\0`);
    expect(r.ok).toBe(true);
    expect(r.entries[0]?.path).toBe(weird);
  });

  it('empty output → ok with no entries', () => {
    expect(parseNameStatusZ('')).toEqual({ ok: true, entries: [] });
  });

  it('output not ending in NUL is truncated → ok:false', () => {
    expect(parseNameStatusZ('M\0path.ts')).toEqual({ ok: false, entries: [] });
  });

  it('a rename truncated after the old path → ok:false (no bogus empty-path rename)', () => {
    expect(parseNameStatusZ('R100\0old.ts\0')).toEqual({ ok: false, entries: [] });
  });

  it('a status truncated before its path → ok:false', () => {
    expect(parseNameStatusZ('M\0')).toEqual({ ok: false, entries: [] });
  });
});
