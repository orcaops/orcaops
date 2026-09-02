/** Presentation-only projection for the page file rail. */

export type FileNavigatorEntry =
  | {
      readonly kind: 'directory';
      readonly key: string;
      readonly directory: string;
      readonly count: number;
      readonly firstFileIndex: number;
    }
  | {
      readonly kind: 'file';
      readonly key: string;
      readonly file: string;
      readonly basename: string;
      readonly directory: string | null;
      readonly fileIndex: number;
    };

export type FileNavigatorWindowItem =
  | {
      readonly kind: 'entry';
      readonly key: string;
      readonly index: number;
      readonly entry: FileNavigatorEntry;
    }
  | {
      readonly kind: 'spacer';
      readonly key: string;
      readonly height: number;
    };

export interface FileNavigatorWindowOptions {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly overscanRows?: number;
  /** Rows that must remain real renderables for cursor and viewport follow. */
  readonly pinnedEntryIndices?: readonly number[];
}

function splitPath(file: string): { directory: string | null; basename: string } {
  const slash = file.lastIndexOf('/');
  if (slash < 0) return { directory: null, basename: file };
  return {
    directory: file.slice(0, slash),
    basename: file.slice(slash + 1),
  };
}

/**
 * Add shallow directory bands without ever reordering the canonical review
 * stream. A directory that appears again later gets another band: adjacency,
 * not an alphabetized tree, is the contract.
 */
export function buildFileNavigatorEntries(
  files: readonly { readonly file: string }[]
): FileNavigatorEntry[] {
  const entries: FileNavigatorEntry[] = [];
  let previousDirectory: string | null | undefined;

  files.forEach((group, fileIndex) => {
    const { directory, basename } = splitPath(group.file);
    if (directory !== null && directory !== previousDirectory) {
      let count = 0;
      for (let index = fileIndex; index < files.length; index += 1) {
        if (splitPath(files[index]!.file).directory !== directory) break;
        count += 1;
      }
      entries.push({
        kind: 'directory',
        key: `directory:${fileIndex}:${directory}`,
        directory,
        count,
        firstFileIndex: fileIndex,
      });
    }
    entries.push({
      kind: 'file',
      key: `file:${fileIndex}:${group.file}`,
      file: group.file,
      basename,
      directory,
      fileIndex,
    });
    previousDirectory = directory;
  });

  return entries;
}

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/**
 * Window the fixed-height navigator stream without changing its scroll geometry.
 * Directory bands and files are both one entry row; omitted runs collapse into
 * exact-height spacers, while active/cursor rows can be pinned independently of
 * the visible band.
 */
export function buildFileNavigatorWindow(
  entries: readonly FileNavigatorEntry[],
  options: FileNavigatorWindowOptions
): FileNavigatorWindowItem[] {
  if (entries.length === 0) return [];

  const overscan = Math.max(0, finiteFloor(options.overscanRows ?? 2, 2));
  const scrollTop = Math.max(0, finiteFloor(options.scrollTop, 0));
  const viewportHeight = Math.max(0, finiteFloor(options.viewportHeight, 0));
  const visibleStart = Math.max(0, Math.min(entries.length, scrollTop - overscan));
  const visibleEnd = Math.max(
    visibleStart,
    Math.min(entries.length, scrollTop + viewportHeight + overscan)
  );
  const mounted = new Set<number>();

  for (let index = visibleStart; index < visibleEnd; index += 1) mounted.add(index);
  for (const index of options.pinnedEntryIndices ?? []) {
    const normalized = finiteFloor(index, -1);
    if (normalized >= 0 && normalized < entries.length) mounted.add(normalized);
  }

  const indices = [...mounted].sort((left, right) => left - right);
  const items: FileNavigatorWindowItem[] = [];
  let cursor = 0;

  for (const index of indices) {
    if (index > cursor) {
      items.push({
        kind: 'spacer',
        key: `spacer:${cursor}:${index}`,
        height: index - cursor,
      });
    }
    const entry = entries[index];
    if (entry !== undefined) {
      items.push({ kind: 'entry', key: entry.key, index, entry });
    }
    cursor = index + 1;
  }

  if (cursor < entries.length) {
    items.push({
      kind: 'spacer',
      key: `spacer:${cursor}:${entries.length}`,
      height: entries.length - cursor,
    });
  }

  return items;
}

export function fileNavigatorRowId(fileIndex: number): string {
  return `review-file-navigator-row-${fileIndex}`;
}
