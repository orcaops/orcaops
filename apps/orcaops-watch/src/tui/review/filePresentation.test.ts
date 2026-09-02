import { describe, expect, it } from 'vitest';

import { changeTypeFromPatch, compactDiffPath, fileBadgeLetter } from './filePresentation';

describe('changeTypeFromPatch', () => {
  it.each([
    [
      'new file',
      [
        'diff --git a/src/new.ts b/src/new.ts',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1 @@',
        '+new',
      ].join('\n'),
      'new',
      'A',
    ],
    [
      'deleted file',
      [
        'diff --git a/src/gone.ts b/src/gone.ts',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
      ].join('\n'),
      'deleted',
      'D',
    ],
    [
      'changed file',
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
      'change',
      'M',
    ],
    [
      'pure rename',
      [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/new.ts',
      ].join('\n'),
      'rename-pure',
      'R',
    ],
    [
      'rename with edits',
      [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 90%',
        'rename from src/old.ts',
        'rename to src/new.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
      'rename-changed',
      'R',
    ],
  ] as const)(
    'classifies a %s without relying on a renderable text hunk',
    (_name, patch, type, badge) => {
      expect(changeTypeFromPatch(patch)).toBe(type);
      expect(fileBadgeLetter(type)).toBe(badge);
    }
  );
});

describe('compactDiffPath', () => {
  it('keeps the basename and the nearest useful parents before eliding the root', () => {
    expect(compactDiffPath('packages/review-engine/src/deep/ReviewExperience.tsx', 34)).toBe(
      '…/src/deep/ReviewExperience.tsx'
    );
    expect(compactDiffPath('packages/review-engine/src/deep/ReviewExperience.tsx', 25)).toBe(
      '…/ReviewExperience.tsx'
    );
  });

  it('middle-elides an overlong basename so both identity and extension survive', () => {
    const compact = compactDiffPath('src/ExtremelyLongReviewExperienceFilename.tsx', 24);
    expect(compact).toHaveLength(24);
    expect(compact).toMatch(/^Extremely.*….*\.tsx$/);
  });

  it('never exceeds the requested width at the elided-parent boundary', () => {
    const path = 'deep/Review.tsx';
    for (const width of [9, 10, 11, 12, 13, 14]) {
      expect(compactDiffPath(path, width).length).toBeLessThanOrEqual(width);
    }
    expect(compactDiffPath(path, 'Review.tsx'.length)).toBe('Review.tsx');
    expect(compactDiffPath(path, 'Review.tsx'.length + 2)).toBe('…/Review.tsx');
  });
});
