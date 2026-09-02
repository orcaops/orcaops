export const ORCAOPS_MANAGED_BLOCK_START = '# >>> orcaops >>>';
export const ORCAOPS_MANAGED_BLOCK_END = '# <<< orcaops <<<';

export interface ManagedLineBlockState {
  claimed: boolean;
  managedLines: string[];
}

interface ExtractedManagedLineBlock extends ManagedLineBlockState {
  outsideLines: string[];
  separatorIndexes: Set<number>;
}

function contentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Render the file back in the shape it was read: the reconciler rebuilds every
 * line, so a canonical LF/trailing-newline rendering would never compare equal
 * to a CRLF file — reporting a permanent stale section in a file orcaops owns
 * nothing in, and silently rewriting the user's line endings on the first
 * write. A remainder of nothing but blank lines renders empty so callers can
 * still detect "the file is now redundant" and delete it.
 */
function renderLines(lines: string[], existing: string): string {
  if (!lines.some((line) => line.trim() !== '')) return '';
  const crlfCount = (existing.match(/\r\n/g) ?? []).length;
  const newlineCount = (existing.match(/\n/g) ?? []).length;
  const eol = crlfCount * 2 > newlineCount ? '\r\n' : '\n';
  const trailing = existing === '' || existing.endsWith('\n') ? eol : '';
  return `${lines.join(eol)}${trailing}`;
}

function extractManagedLineBlock(content: string): ExtractedManagedLineBlock {
  const lines = contentLines(content);
  const outsideLines: string[] = [];
  const managedLines: string[] = [];
  const separatorIndexes = new Set<number>();
  let claimed = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== ORCAOPS_MANAGED_BLOCK_START) {
      outsideLines.push(lines[i]);
      continue;
    }

    const end = lines.indexOf(ORCAOPS_MANAGED_BLOCK_END, i + 1);
    const nestedStart = lines.indexOf(ORCAOPS_MANAGED_BLOCK_START, i + 1);
    if (end === -1 || (nestedStart !== -1 && nestedStart < end)) {
      outsideLines.push(lines[i]);
      continue;
    }

    claimed = true;
    if (outsideLines.at(-1)?.trim() === '') separatorIndexes.add(outsideLines.length - 1);
    managedLines.push(
      ...lines
        .slice(i + 1, end)
        .map((line) => line.trim())
        .filter(Boolean)
    );
    i = end;
  }

  return { claimed, managedLines, outsideLines, separatorIndexes };
}

export function inspectManagedLineBlock(content: string): ManagedLineBlockState {
  const { claimed, managedLines } = extractManagedLineBlock(content);
  return { claimed, managedLines };
}

export interface ManagedLineBlockPlan extends ManagedLineBlockState {
  added: string[];
  removed: string[];
  desiredContent: string | null;
}

export function reconcileManagedLineBlock(
  existing: string,
  desiredLines: ReadonlyArray<string>
): ManagedLineBlockPlan {
  const extracted = extractManagedLineBlock(existing);
  const desired = [...new Set(desiredLines.map((line) => line.trim()).filter(Boolean))];
  const current = new Set(extracted.managedLines);
  const desiredSet = new Set(desired);
  const outside = extracted.outsideLines.filter(
    (_line, index) => desired.length > 0 || !extracted.separatorIndexes.has(index)
  );

  if (desired.length > 0) {
    if (outside.length > 0 && outside.at(-1)?.trim() !== '') outside.push('');
    outside.push(ORCAOPS_MANAGED_BLOCK_START, ...desired, ORCAOPS_MANAGED_BLOCK_END);
  }

  const next = renderLines(outside, existing);
  if (next === existing) {
    return {
      claimed: extracted.claimed,
      managedLines: extracted.managedLines,
      added: [],
      removed: [],
      desiredContent: null,
    };
  }

  return {
    claimed: extracted.claimed,
    managedLines: extracted.managedLines,
    added: desired.filter((line) => !current.has(line)),
    removed: [...new Set(extracted.managedLines.filter((line) => !desiredSet.has(line)))],
    desiredContent: next,
  };
}
