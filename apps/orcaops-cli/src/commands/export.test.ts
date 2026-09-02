import { describe, expect, it } from 'vitest';

import { parseAddedLines, toRanges } from './export.js';

describe('parseAddedLines', () => {
  it('yields added lines with NEW-side positions across hunks and files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 0000001..0000002 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' context',
      '+added one',
      ' context2',
      '+added two',
      '@@ -10,2 +11,3 @@',
      ' ctx',
      '-removed',
      '+added three',
      ' tail',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+fresh one',
      '+fresh two',
      '',
    ].join('\n');
    expect(parseAddedLines(diff)).toEqual([
      { file: 'src/a.ts', line: 2, text: 'added one' },
      { file: 'src/a.ts', line: 4, text: 'added two' },
      { file: 'src/a.ts', line: 12, text: 'added three' },
      { file: 'new.ts', line: 1, text: 'fresh one' },
      { file: 'new.ts', line: 2, text: 'fresh two' },
    ]);
  });

  it('skips deletions-only files and binary sections', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-old one',
      '-old two',
      'diff --git a/img.bin b/img.bin',
      'Binary files a/img.bin and b/img.bin differ',
      '',
    ].join('\n');
    expect(parseAddedLines(diff)).toEqual([]);
  });
});

describe('toRanges', () => {
  it('merges contiguous lines and keeps gaps separate', () => {
    expect(toRanges([1, 2, 3, 7, 9, 10])).toEqual([
      { start_line: 1, end_line: 3 },
      { start_line: 7, end_line: 7 },
      { start_line: 9, end_line: 10 },
    ]);
  });

  it('dedupes and sorts', () => {
    expect(toRanges([5, 4, 5, 4])).toEqual([{ start_line: 4, end_line: 5 }]);
  });
});
