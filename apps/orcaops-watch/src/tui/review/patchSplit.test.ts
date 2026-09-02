import { describe, expect, it } from 'vitest';

import {
  binaryPatchInfo,
  indexPatchRanges,
  matchHunkOrdinal,
  splitPatchByFile,
} from './patchSplit';

const TWO_FILE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 import x from 'x';
+const y = 1;
 export const a = 1;
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +11,3 @@ function f() {
   const z = 2;
+  const w = 3;
`;

describe('splitPatchByFile', () => {
  it('splits a multi-file diff, keyed by each file, each chunk its own patch', () => {
    const map = splitPatchByFile(TWO_FILE);
    expect([...map.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(map.get('src/a.ts')!.startsWith('diff --git a/src/a.ts')).toBe(true);
    expect(map.get('src/a.ts')).toContain('const y = 1;');
    expect(map.get('src/a.ts')).not.toContain('src/b.ts'); // chunks don't bleed
    expect(map.get('src/b.ts')).toContain('const w = 3;');
  });

  it('indexes exact source ranges without retaining the separator newline', () => {
    const ranges = indexPatchRanges(TWO_FILE);
    const secondStart = TWO_FILE.indexOf('\ndiff --git a/src/b.ts') + 1;
    expect(ranges.get('src/a.ts')).toEqual({ start: 0, end: secondStart - 1 });
    expect(ranges.get('src/b.ts')).toEqual({ start: secondStart, end: TWO_FILE.length });
    expect(TWO_FILE.slice(ranges.get('src/a.ts')!.start, ranges.get('src/a.ts')!.end)).toBe(
      splitPatchByFile(TWO_FILE).get('src/a.ts')
    );
  });

  it('is empty for an empty diff (degenerate scope)', () => {
    expect(splitPatchByFile('').size).toBe(0);
  });

  it('keys a rename under both the old and new path', () => {
    const rename = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;
    const map = splitPatchByFile(rename);
    expect(map.has('old/name.ts')).toBe(true);
    expect(map.has('new/name.ts')).toBe(true);
    const ranges = indexPatchRanges(rename);
    expect(ranges.get('old/name.ts')).toBe(ranges.get('new/name.ts'));
  });

  it('keys a deletion under the old path (new side is /dev/null)', () => {
    const del = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 555..000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;
`;
    const map = splitPatchByFile(del);
    expect([...map.keys()]).toEqual(['gone.ts']);
  });
});

describe('matchHunkOrdinal', () => {
  const hunks = [
    { additionStart: 1, deletionStart: 1 },
    { additionStart: 21, deletionStart: 20 },
    { additionStart: 60, deletionStart: 58 },
  ];

  it('matches a floor hunk to its ordinal by new-file start', () => {
    expect(matchHunkOrdinal(hunks, { newStart: 1, oldStart: 1 })).toBe(0);
    expect(matchHunkOrdinal(hunks, { newStart: 21, oldStart: 20 })).toBe(1);
    expect(matchHunkOrdinal(hunks, { newStart: 60, oldStart: 58 })).toBe(2);
  });

  it('falls back to the old-file start for a pure deletion (new start absent)', () => {
    expect(matchHunkOrdinal(hunks, { newStart: null, oldStart: 20 })).toBe(1);
  });

  it('returns -1 when no hunk matches', () => {
    expect(matchHunkOrdinal(hunks, { newStart: 99, oldStart: 99 })).toBe(-1);
  });
});

describe('binaryPatchInfo', () => {
  it('detects the plain `Binary files … differ` spelling (no size available)', () => {
    const patch = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/assets/logo.png and b/assets/logo.png differ',
      '',
    ].join('\n');
    expect(binaryPatchInfo(patch)).toEqual({ binary: true, bytes: null });
  });

  it('detects a `GIT binary patch` block and reads the literal new-side size', () => {
    const patch = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 5120',
      'zcmV?<x…',
      '',
    ].join('\n');
    expect(binaryPatchInfo(patch)).toEqual({ binary: true, bytes: 5120 });
  });

  it('is negative for a textual patch — even one whose CONTENT mentions the markers', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      " const s = 'Binary files a and b differ';",
      "+const t = 'GIT binary patch';",
      '',
    ].join('\n');
    // Anchoring alone can't reject these (diff body lines start at column 0
    // only for the markers themselves — content is prefixed by ` `/`+`/`-`).
    expect(binaryPatchInfo(patch)).toEqual({ binary: false, bytes: null });
  });
});
