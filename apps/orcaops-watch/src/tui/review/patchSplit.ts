// Pure patch plumbing for the Walk's diff pane — no @orcaops/diff-render (and so
// no OpenTUI) import, which keeps it unit-testable in the node test runner. It
// splits a unified diff into per-file patch text and matches a floor hunk to its
// ordinal within a parsed file by position. walkDiff.ts layers the diff-render
// parse on top; everything drift-sensitive lives here where a test can pin it.

/** Strip a `git diff` path prefix (`a/` `b/`) and any trailing tab-timestamp. */
function stripDiffPath(raw: string): string | null {
  const p = raw.trim().replace(/\t.*$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p.length > 0 ? p : null;
}

/** The file path(s) a single-file patch chunk covers — old and new (renames differ). */
function fileNamesOf(rawDiff: string, start: number, end: number): string[] {
  const names = new Set<string>();
  let lineStart = start;
  while (lineStart < end) {
    const newline = rawDiff.indexOf('\n', lineStart);
    const lineEnd = newline === -1 || newline >= end ? end : newline;
    if (rawDiff.startsWith('@@ ', lineStart)) break;
    if (rawDiff.startsWith('--- ', lineStart) || rawDiff.startsWith('+++ ', lineStart)) {
      const n = stripDiffPath(rawDiff.slice(lineStart + 4, lineEnd));
      if (n) names.add(n);
    }
    if (newline === -1 || newline >= end) break;
    lineStart = newline + 1;
  }
  if (names.size === 0) {
    // Pure rename / mode change with no ---/+++ body: read the git header.
    const firstNewline = rawDiff.indexOf('\n', start);
    const firstLineEnd = firstNewline === -1 || firstNewline >= end ? end : firstNewline;
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(rawDiff.slice(start, firstLineEnd).trimEnd());
    if (m) {
      names.add(m[1]);
      names.add(m[2]);
    }
  }
  return [...names];
}

/** A zero-copy view over one file chunk in the immutable review diff. */
export interface PatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Index file names to byte-string ranges without allocating one string and one
 * line-array entry for every row in the review. Range objects are shared by
 * rename aliases, so materializing a chunk remains an explicit, lazy choice.
 */
export function indexPatchRanges(rawDiff: string): Map<string, PatchRange> {
  const byFile = new Map<string, PatchRange>();
  if (rawDiff.length === 0) return byFile;

  let start = rawDiff.startsWith('diff --git ')
    ? 0
    : (() => {
        const marker = rawDiff.indexOf('\ndiff --git ');
        return marker === -1 ? -1 : marker + 1;
      })();

  while (start !== -1 && start < rawDiff.length) {
    const nextMarker = rawDiff.indexOf('\ndiff --git ', start + 1);
    // The marker's leading newline separates chunks. Excluding it exactly
    // mirrors `lines.join('\n')`: a chunk only retains a trailing newline when
    // the input carried an empty line before the next `diff --git` header.
    const end = nextMarker === -1 ? rawDiff.length : nextMarker;
    const range = { start, end };
    for (const name of fileNamesOf(rawDiff, start, end)) byFile.set(name, range);
    start = nextMarker === -1 ? -1 : nextMarker + 1;
  }

  return byFile;
}

/**
 * Split a unified diff into per-file patch text, keyed by every path each chunk
 * covers (both sides of a rename, so a floor lookup by either resolves). Each
 * chunk starts at a `diff --git` line — robust to new/deleted/binary/rename
 * headers, which a `@@`/`+++`-only split would mis-handle.
 */
export function splitPatchByFile(rawDiff: string): Map<string, string> {
  const byFile = new Map<string, string>();
  for (const [name, range] of indexPatchRanges(rawDiff)) {
    byFile.set(name, rawDiff.slice(range.start, range.end));
  }
  return byFile;
}

/** What a binary per-file patch admits about itself (git never carries hunks for it). */
export interface BinaryPatchInfo {
  binary: boolean;
  /** New-side byte size from a `GIT binary patch` literal header; plain `Binary files … differ` carries none. */
  bytes: number | null;
}

/**
 * Detect a binary per-file patch from its text (mirrors hunk's patchLooksBinary:
 * both git spellings, anchored to line starts). `git diff` without `--binary`
 * emits `Binary files a/x and b/x differ`; with it, a `GIT binary patch` block
 * whose `literal <n>`/`delta <n>` header carries the inflated new-side size.
 */
export function binaryPatchInfo(patch: string): BinaryPatchInfo {
  if (!/(^|\n)(Binary files .* differ|GIT binary patch)(\n|$)/.test(patch)) {
    return { binary: false, bytes: null };
  }
  const literal = /(^|\n)GIT binary patch\n(?:literal|delta) (\d+)(\n|$)/.exec(patch);
  return { binary: true, bytes: literal !== null ? Number(literal[2]) : null };
}

/** A parsed hunk's start positions — the fields matchHunkOrdinal keys on. */
export interface HunkPosition {
  additionStart: number;
  deletionStart: number;
}

/** A floor hunk's start positions (either may be null for pure add/delete). */
export interface HunkStart {
  newStart: number | null;
  oldStart: number | null;
}

/**
 * Find the ordinal of the parsed hunk that matches a floor hunk. Both sides read
 * the same `@@` headers (the floor was derived from this very diff), so a hunk's
 * new-file start is an exact key; pure deletions fall back to the old-file start.
 * Returns -1 when nothing matches (walkDiff maps that to a null placeholder).
 */
export function matchHunkOrdinal(hunks: readonly HunkPosition[], ref: HunkStart): number {
  if (ref.newStart !== null) {
    const i = hunks.findIndex((h) => h.additionStart === ref.newStart);
    if (i !== -1) return i;
  }
  if (ref.oldStart !== null) {
    const i = hunks.findIndex((h) => h.deletionStart === ref.oldStart);
    if (i !== -1) return i;
  }
  return -1;
}
