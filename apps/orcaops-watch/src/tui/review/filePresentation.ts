export type FileChangeType = 'new' | 'deleted' | 'change' | 'rename-pure' | 'rename-changed';

const FILE_BADGE: Readonly<Record<FileChangeType, 'A' | 'M' | 'D' | 'R'>> = {
  new: 'A',
  deleted: 'D',
  change: 'M',
  'rename-pure': 'R',
  'rename-changed': 'R',
};

/** Classify even patches diff-render cannot materialize (binary and pure rename). */
export function changeTypeFromPatch(patch: string): FileChangeType {
  const renamed = /(^|\n)rename from /.test(patch) || /(^|\n)rename to /.test(patch);
  if (renamed) return /(^|\n)@@ /.test(patch) ? 'rename-changed' : 'rename-pure';
  if (/(^|\n)--- \/dev\/null(\n|$)/.test(patch) || /(^|\n)new file mode /.test(patch)) {
    return 'new';
  }
  if (/(^|\n)\+\+\+ \/dev\/null(\n|$)/.test(patch) || /(^|\n)deleted file mode /.test(patch)) {
    return 'deleted';
  }
  return 'change';
}

export function fileBadgeLetter(type: FileChangeType | null): 'A' | 'M' | 'D' | 'R' | '·' {
  return type === null ? '·' : FILE_BADGE[type];
}

function middleElide(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…'.slice(0, width);
  const available = width - 1;
  const left = Math.ceil(available / 2);
  const right = available - left;
  return `${value.slice(0, left)}…${right > 0 ? value.slice(-right) : ''}`;
}

/**
 * Fit a diff path by discarding distant parents first. The basename is the part
 * a reviewer identifies; generic prefix truncation is nearly all directory and
 * often removes the filename entirely.
 */
export function compactDiffPath(path: string, width: number): string {
  if (width <= 0) return '';
  if (path.length <= width) return path;
  const parts = path.split('/').filter(Boolean);
  const basename = parts.at(-1) ?? path;
  // Once a parent is elided the visible value also owes the `…/` prefix. A
  // basename that fits the raw width can therefore still overflow by two cells.
  if (basename.length + 2 > width) return middleElide(basename, width);

  let suffix = basename;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const candidate = `${parts[index]}/${suffix}`;
    if (`…/${candidate}`.length > width) break;
    suffix = candidate;
  }
  return suffix === path ? path : `…/${suffix}`;
}
