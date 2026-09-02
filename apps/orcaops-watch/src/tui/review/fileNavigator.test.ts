import { describe, expect, test } from 'vitest';

import { buildFileNavigatorEntries, buildFileNavigatorWindow } from './fileNavigator';

describe('buildFileNavigatorEntries', () => {
  test('adds directory bands while preserving canonical stream order', () => {
    const files = [
      { file: 'src/ui/App.tsx' },
      { file: 'src/ui/theme.ts' },
      { file: 'README.md' },
      { file: 'tests/app.test.ts' },
      { file: 'src/ui/again.ts' },
    ];

    const entries = buildFileNavigatorEntries(files);
    expect(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.file)).toEqual(
      files.map((file) => file.file)
    );
    expect(
      entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.directory)
    ).toEqual(['src/ui', 'tests', 'src/ui']);
  });

  test('uses basenames and leaves root files free of synthetic directory noise', () => {
    expect(buildFileNavigatorEntries([{ file: 'README.md' }, { file: 'src/index.ts' }])).toEqual([
      {
        kind: 'file',
        key: 'file:0:README.md',
        file: 'README.md',
        basename: 'README.md',
        directory: null,
        fileIndex: 0,
      },
      {
        kind: 'directory',
        key: 'directory:1:src',
        directory: 'src',
        count: 1,
        firstFileIndex: 1,
      },
      {
        kind: 'file',
        key: 'file:1:src/index.ts',
        file: 'src/index.ts',
        basename: 'index.ts',
        directory: 'src',
        fileIndex: 1,
      },
    ]);
  });
});

describe('buildFileNavigatorWindow', () => {
  test('keeps a 5,000-file stream exact while mounting only the viewport and pins', () => {
    const files = Array.from({ length: 5_000 }, (_, index) => ({
      file: `src/section-${Math.floor(index / 10)}/file-${index}.ts`,
    }));
    const entries = buildFileNavigatorEntries(files);
    const window = buildFileNavigatorWindow(entries, {
      scrollTop: 1_100,
      viewportHeight: 7,
      overscanRows: 2,
      pinnedEntryIndices: [1, entries.length - 1],
    });
    const mounted = window.filter((item) => item.kind === 'entry');
    const representedHeight = window.reduce(
      (height, item) => height + (item.kind === 'spacer' ? item.height : 1),
      0
    );

    expect(entries).toHaveLength(5_500);
    expect(representedHeight).toBe(entries.length);
    expect(mounted.length).toBeLessThanOrEqual(13);
    expect(mounted.some((item) => item.index === 1)).toBe(true);
    expect(mounted.some((item) => item.index === entries.length - 1)).toBe(true);
    expect(
      mounted.some((item) => item.entry.kind === 'directory' && item.entry.firstFileIndex === 1_000)
    ).toBe(true);
  });

  test('coalesces omitted runs and ignores invalid pinned rows', () => {
    const entries = buildFileNavigatorEntries([
      { file: 'src/a.ts' },
      { file: 'src/b.ts' },
      { file: 'test/c.ts' },
    ]);
    const window = buildFileNavigatorWindow(entries, {
      scrollTop: 2,
      viewportHeight: 1,
      overscanRows: 0,
      pinnedEntryIndices: [-1, 99, 0],
    });

    expect(window).toEqual([
      { kind: 'entry', key: entries[0]!.key, index: 0, entry: entries[0] },
      { kind: 'spacer', key: 'spacer:1:2', height: 1 },
      { kind: 'entry', key: entries[2]!.key, index: 2, entry: entries[2] },
      { kind: 'spacer', key: 'spacer:3:5', height: 2 },
    ]);
  });
});
