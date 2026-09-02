import { type CapturedSpan, parseColor } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { describe, expect, test } from 'bun:test';

import {
  type AppTheme,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  type DiffRow,
  DiffRowView,
  resolveTheme,
  withTransparentSurfaces,
} from '@orcaops/diff-render';

const WIDTH = 80;
const HEIGHT = 28;
const LONG_CODE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const ROWS: readonly DiffRow[] = [
  {
    type: 'stack-line',
    key: 'stack-add',
    fileId: 'fixture.ts',
    hunkIndex: 0,
    cell: {
      kind: 'addition',
      sign: '+',
      newLineNumber: 91,
      spans: [{ text: LONG_CODE }],
    },
  },
  {
    type: 'stack-line',
    key: 'stack-delete',
    fileId: 'fixture.ts',
    hunkIndex: 0,
    cell: {
      kind: 'deletion',
      sign: '-',
      oldLineNumber: 42,
      spans: [{ text: LONG_CODE }],
    },
  },
  {
    type: 'split-line',
    key: 'split-change',
    fileId: 'fixture.ts',
    hunkIndex: 0,
    left: {
      kind: 'deletion',
      sign: '-',
      lineNumber: 73,
      spans: [{ text: LONG_CODE }],
    },
    right: {
      kind: 'addition',
      sign: '+',
      lineNumber: 84,
      spans: [{ text: LONG_CODE }],
    },
  },
];

async function renderRows(theme: AppTheme, wrapLines: boolean) {
  const testRenderer = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  const root = createRoot(testRenderer.renderer);
  root.render(
    <box width={WIDTH} height={HEIGHT} flexDirection="column">
      {ROWS.map((row) => (
        <DiffRowView
          key={row.key}
          row={row}
          width={WIDTH}
          lineNumberDigits={2}
          showLineNumbers
          showHunkHeaders
          wrapLines={wrapLines}
          codeHorizontalOffset={0}
          theme={theme}
          selected={false}
          focus={
            row.type === 'split-line'
              ? { kind: 'split', left: 'subdued', right: 'subdued' }
              : { kind: 'stack', cell: 'subdued' }
          }
        />
      ))}
    </box>
  );

  for (let pass = 0; pass < 4; pass += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await testRenderer.renderOnce();
  }

  return {
    frame: testRenderer.captureCharFrame(),
    spans: testRenderer.captureSpans().lines.flatMap((line) => line.spans),
    destroy: () => testRenderer.renderer.destroy(),
  };
}

function expectColor(span: CapturedSpan, foreground: string, background: string) {
  expect(span.fg.toInts()).toEqual(parseColor(foreground).toInts());
  expect(span.bg.toInts()).toEqual(parseColor(background).toInts());
}

const themes = [
  ['dark', resolveTheme(DEFAULT_DARK_THEME_ID, null)],
  ['light', resolveTheme(DEFAULT_LIGHT_THEME_ID, null)],
  ['transparent', withTransparentSurfaces(resolveTheme(DEFAULT_DARK_THEME_ID, null))],
] as const;

describe.each(themes)('semantic diff gutter colors in %s', (_label, theme) => {
  test.each([
    ['flat', false],
    ['wrapped', true],
  ] as const)(
    'split and stack %s rows paint signs independently from numbers',
    async (_, wrapLines) => {
      const rendered = await renderRows(theme, wrapLines);
      try {
        const additions = rendered.spans.filter((span) => span.text === '+');
        const deletions = rendered.spans.filter((span) => span.text === '-');
        expect(additions).toHaveLength(2);
        expect(deletions).toHaveLength(2);
        for (const span of additions) {
          expectColor(span, theme.addedSignColor, theme.lineNumberBg);
        }
        for (const span of deletions) {
          expectColor(span, theme.removedSignColor, theme.lineNumberBg);
        }

        for (const number of [91, 42, 73, 84]) {
          const span = rendered.spans.find((candidate) => candidate.text.includes(String(number)));
          expect(span, `missing line-number gutter for ${number}`).toBeDefined();
          expectColor(span!, theme.lineNumberFg, theme.lineNumberBg);
        }

        if (wrapLines) {
          const paintedLines = rendered.frame.split('\n').filter((line) => line.trim().length > 0);
          expect(paintedLines.length).toBeGreaterThan(ROWS.length);
        }
      } finally {
        rendered.destroy();
      }
    }
  );
});
