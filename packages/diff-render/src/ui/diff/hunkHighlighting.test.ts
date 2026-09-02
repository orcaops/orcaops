import { describe, expect, it } from 'vitest';

import { diffFileFromPatch } from '../../fromPatch';
import { DEFAULT_DARK_THEME_ID, resolveTheme } from '../themes';
import {
  buildSplitRows,
  buildSplitRowsForHunk,
  buildStackRows,
  buildStackRowsForHunk,
  loadHighlightedDiff,
  loadHighlightedDiffHunk,
  sliceMetadataForHunkHighlight,
} from './pierre';
import { prefetchHighlightedDiff } from './useHighlightedDiff';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 0000001..0000002 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const one = 1;',
  '-const two = 2;',
  '+const two = 20;',
  ' const three = 3;',
  '@@ -40,3 +40,4 @@',
  ' function tail() {',
  '-  return 40;',
  '+  const answer = 41;',
  '+  return answer;',
  ' }',
].join('\n');

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);
const file = () => diffFileFromPatch(PATCH, { sourceId: 'hunk-highlight-test' });

describe('hunk-scoped highlighting', () => {
  it('never reuses highlighted text across same-id, same-length immutable generations', async () => {
    const context = Array.from(
      { length: 220 },
      (_, index) => ` const padding_${index} = ${index};`
    );
    const patch = (token: 'stale' | 'fresh') =>
      [
        'diff --git a/src/generation.ts b/src/generation.ts',
        'index 0000001..0000002 100644',
        '--- a/src/generation.ts',
        '+++ b/src/generation.ts',
        '@@ -1,221 +1,221 @@',
        ...context.slice(0, 42),
        `-const ${token}Token = 1;`,
        `+const ${token}Token = 2;`,
        ...context.slice(42),
      ].join('\n');
    const stalePatch = patch('stale');
    const freshPatch = patch('fresh');
    const firstMiddleLastSample = (value: string) => {
      const middle = Math.floor(value.length / 2);
      return [value.slice(0, 64), value.slice(middle, middle + 64), value.slice(-64)];
    };

    // The two patches are equal-length and indistinguishable to a first/middle/last
    // content sampler — exactly the collision a sampled cache key would miss.
    expect(freshPatch).toHaveLength(stalePatch.length);
    expect(firstMiddleLastSample(freshPatch)).toEqual(firstMiddleLastSample(stalePatch));

    const stale = diffFileFromPatch(stalePatch, { sourceId: 'immutable-generation-test' });
    const fresh = diffFileFromPatch(freshPatch, { sourceId: 'immutable-generation-test' });
    expect(fresh.id).toBe(stale.id);
    await prefetchHighlightedDiff({ file: stale, theme });
    const highlighted = await prefetchHighlightedDiff({ file: fresh, theme });
    const renderedText = buildStackRows(fresh, highlighted, theme)
      .flatMap((row) => (row.type === 'stack-line' ? row.cell.spans : []))
      .map((span) => span.text)
      .join('\n');

    expect(renderedText).toContain('freshToken');
    expect(renderedText).not.toContain('staleToken');
  });

  it('builds one hunk with the exact identities and source coordinates of the full row stream', async () => {
    const diff = file();
    const highlighted = await loadHighlightedDiffHunk(diff, 1, theme);

    for (const hunkIndex of diff.metadata.hunks.keys()) {
      expect(buildSplitRowsForHunk(diff, hunkIndex, highlighted, theme)).toEqual(
        buildSplitRows(diff, highlighted, theme).filter((row) => row.hunkIndex === hunkIndex)
      );
      expect(buildStackRowsForHunk(diff, hunkIndex, highlighted, theme)).toEqual(
        buildStackRows(diff, highlighted, theme).filter((row) => row.hunkIndex === hunkIndex)
      );
    }

    expect(buildSplitRowsForHunk(diff, 99, null, theme)).toEqual([]);
    expect(buildStackRowsForHunk(diff, 99, null, theme)).toEqual([]);
  });

  it('slices one parsed hunk without changing its source coordinates', () => {
    const diff = file();
    const original = diff.metadata.hunks[1]!;
    const sliced = sliceMetadataForHunkHighlight(diff, 1);

    expect(sliced).not.toBeNull();
    expect(sliced?.deletionOffset).toBe(original.deletionLineIndex);
    expect(sliced?.additionOffset).toBe(original.additionLineIndex);
    expect(sliced?.metadata.hunks).toHaveLength(1);
    expect(sliced?.metadata.hunks[0]).toMatchObject({
      deletionStart: original.deletionStart,
      additionStart: original.additionStart,
      deletionLineIndex: 0,
      additionLineIndex: 0,
      splitLineStart: 0,
      unifiedLineStart: 0,
    });
    expect(sliced?.metadata.hunks[0]?.hunkContent).toEqual(
      original.hunkContent.map((content) => ({
        ...content,
        deletionLineIndex: content.deletionLineIndex - original.deletionLineIndex,
        additionLineIndex: content.additionLineIndex - original.additionLineIndex,
      }))
    );
    expect(sliced?.metadata.deletionLines).toEqual(
      diff.metadata.deletionLines.slice(
        original.deletionLineIndex,
        original.deletionLineIndex + original.deletionCount
      )
    );
    expect(sliced?.metadata.additionLines).toEqual(
      diff.metadata.additionLines.slice(
        original.additionLineIndex,
        original.additionLineIndex + original.additionCount
      )
    );
  });

  it('eventually applies syntax spans only at the requested hunk indices', async () => {
    const diff = file();
    const first = diff.metadata.hunks[0]!;
    const second = diff.metadata.hunks[1]!;
    const highlighted = await loadHighlightedDiffHunk(diff, 1, theme);

    expect(
      highlighted.deletionLines.slice(0, second.deletionLineIndex).every((line) => !line)
    ).toBe(true);
    expect(
      highlighted.additionLines.slice(0, second.additionLineIndex).every((line) => !line)
    ).toBe(true);
    expect(
      highlighted.deletionLines
        .slice(second.deletionLineIndex, second.deletionLineIndex + second.deletionCount)
        .some(Boolean)
    ).toBe(true);
    expect(
      highlighted.additionLines
        .slice(second.additionLineIndex, second.additionLineIndex + second.additionCount)
        .some(Boolean)
    ).toBe(true);

    const rows = buildSplitRows(diff, highlighted, theme);
    const firstSpans = rows.flatMap((row) =>
      row.hunkIndex === 0 && row.type === 'split-line'
        ? [...row.left.spans, ...row.right.spans]
        : []
    );
    const secondSpans = rows.flatMap((row) =>
      row.hunkIndex === 1 && row.type === 'split-line'
        ? [...row.left.spans, ...row.right.spans]
        : []
    );

    expect(firstSpans.every((span) => span.fg === undefined)).toBe(true);
    expect(secondSpans.some((span) => span.fg !== undefined)).toBe(true);
    const secondRows = rows.filter((row) => row.hunkIndex === 1 && row.type === 'split-line');
    const functionContext = secondRows.find(
      (row) => row.type === 'split-line' && row.left.lineNumber === 40
    );
    const changedPair = secondRows.find(
      (row) => row.type === 'split-line' && row.left.lineNumber === 41
    );
    const addedReturn = secondRows.find(
      (row) => row.type === 'split-line' && row.right.lineNumber === 42
    );

    expect(functionContext?.type).toBe('split-line');
    expect(changedPair?.type).toBe('split-line');
    expect(addedReturn?.type).toBe('split-line');
    if (
      functionContext?.type !== 'split-line' ||
      changedPair?.type !== 'split-line' ||
      addedReturn?.type !== 'split-line'
    ) {
      throw new Error('expected exact highlighted rows for the second hunk');
    }

    expect(functionContext.left.spans.map((span) => span.text).join('')).toBe('function tail() {');
    expect(functionContext.left.spans[0]).toMatchObject({ text: 'function' });
    expect(functionContext.left.spans[0]?.fg).toBeDefined();
    expect(changedPair.left.spans.map((span) => span.text).join('')).toBe('  return 40;');
    expect(changedPair.right.spans.map((span) => span.text).join('')).toBe('  const answer = 41;');
    expect(
      changedPair.left.spans
        .filter((span) => span.bg !== undefined)
        .map((span) => span.text)
        .join('')
    ).toBe('return 40');
    expect(
      changedPair.right.spans
        .filter((span) => span.bg !== undefined)
        .map((span) => span.text)
        .join('')
    ).toBe('const answer = 41');
    expect(addedReturn.left.kind).toBe('empty');
    expect(addedReturn.right.spans.map((span) => span.text).join('')).toBe('  return answer;');
    expect(first.deletionLineIndex).toBe(0);
  });

  it('retains only the latest flattened theme presentation for each highlighted line', async () => {
    const diff = file();
    const highlighted = await loadHighlightedDiffHunk(diff, 1, theme);
    const alternateTheme = {
      ...theme,
      id: 'custom-derived-span-test',
      syntaxColors: { ...theme.syntaxColors, keyword: '#010203' },
    };
    const spansFor = (activeTheme: typeof theme) => {
      const row = buildStackRowsForHunk(diff, 1, highlighted, activeTheme).find(
        (candidate) => candidate.type === 'stack-line' && candidate.cell.spans.length > 0
      );
      if (row?.type !== 'stack-line') throw new Error('expected one highlighted stack row');
      return row.cell.spans;
    };

    const first = spansFor(theme);
    expect(spansFor(theme)).toBe(first);
    expect(spansFor(alternateTheme)).not.toBe(first);
    // Returning to the first palette rebuilds it because the per-HAST derived cache is bounded to
    // one presentation rather than retaining every custom-theme revision for the HAST lifetime.
    expect(spansFor(theme)).not.toBe(first);
  });

  it('keeps explicit whole-file highlighting complete while scheduling parsed hunks separately', async () => {
    const diff = file();
    const highlighted = await loadHighlightedDiff(diff, theme);

    expect(highlighted.deletionLines.filter(Boolean)).toHaveLength(
      diff.metadata.deletionLines.length
    );
    expect(highlighted.additionLines.filter(Boolean)).toHaveLength(
      diff.metadata.additionLines.length
    );
  });
});
