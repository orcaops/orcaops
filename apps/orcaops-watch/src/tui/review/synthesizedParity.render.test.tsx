import { describe, expect, test } from 'bun:test';

import { mountReviewApp } from '../../../tests/review/mountReviewApp';

const NEW_FILE_PATCH = [
  'diff --git a/src/fixture.ts b/src/fixture.ts',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/src/fixture.ts',
  '@@ -0,0 +1 @@',
  '+stable fixture row',
  '',
].join('\n');

describe('the deterministic Brief carries the same review truth', () => {
  for (const width of [80, 110, 160] as const) {
    test(`coverage, trail, and staleness remain visible at ${width} columns`, async () => {
      const app = await mountReviewApp({
        scenario: 'no-narrative',
        screen: 'brief',
        width,
        height: 60,
        staleFloor: true,
      });

      expect(app.frame()).toContain('COVERAGE');
      expect(app.frame()).toContain('CAPTURED TRAIL');
      expect(app.frame()).not.toContain('TRUST');
      expect(app.frame()).toContain('HEAD moved');
      app.unmount();
    });
  }
});

describe('truthful escape-hatch file badges', () => {
  test('the flat file list derives A/M/D/R from the patch instead of hardcoding M', async () => {
    const app = await mountReviewApp({
      scenario: 'no-narrative',
      screen: 'flat-files',
      width: 110,
      reviewDiff: NEW_FILE_PATCH,
    });

    expect(app.frame()).toContain('A src/fixture.ts');
    expect(app.frame()).not.toContain('M src/fixture.ts');
    app.unmount();
  });
});
