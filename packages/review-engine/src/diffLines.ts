// Walk a unified diff and emit the file + line number of every added and
// deleted line. The attribution engine's per-line owners key off these
// positions: for each added line we blame the synthesized lineage at its
// new-file line number to find the owning segment. `fingerprintUnifiedDiff`
// (used by the engine) drops the context needed to recover per-line numbers,
// so this small position-aware walk lives here on the sidecar side.

export interface DiffLinePosition {
  /** Path the line lives at ON ITS OWN SIDE: new path for adds, old path for deletes. */
  file: string;
  side: 'add' | 'delete';
  /** New-file line number for adds; old-file line number for deletes. */
  line: number;
  /**
   * The path the attribution engine keys this file's hunks by —
   * `file_after ?? file_before`. Differs from `file` only for delete-side
   * lines of a renamed file: blame needs the OLD path, coverage the NEW one.
   */
  coverageFile: string;
  /** Raw line body (after the +/- prefix) — hashed into `LineOwner.lineHash`. */
  body: string;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

// `@@ -oldStart[,oldCount] +newStart[,newCount] @@`
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(path: string): string | null {
  if (path === '/dev/null') return null;
  // git diff paths are `a/<path>` / `b/<path>`; strip the one-char prefix.
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/**
 * Parse a unified diff into the positions of every added/deleted line. Pure and
 * tolerant: unrecognized lines are skipped, matching the fingerprint parser.
 */
/**
 * True while `raw` still belongs to the hunk body that precedes it. Git renders
 * an empty context line as a single space, so a bare newline ends the hunk.
 */
function continuesHunkBody(raw: string): boolean {
  const sign = raw.charAt(0);
  return sign === ' ' || sign === '+' || sign === '-' || sign === '\\';
}

export function parseDiffLinePositions(diffBytes: Uint8Array): DiffLinePosition[] {
  const text = decoder.decode(diffBytes);
  const positions: DiffLinePosition[] = [];

  let fileBefore: string | null = null;
  let fileAfter: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of text.split('\n')) {
    // Inside a hunk every row carries a sign column, so the file-header
    // prefixes describe the SIGNED row rather than its content: a deleted
    // `-- ` line renders as `--- `. Reading one as a header ended the hunk and
    // dropped every position behind it in that file.
    if (inHunk && !continuesHunkBody(raw)) inHunk = false;
    if (!inHunk) {
      if (raw.startsWith('diff --git')) {
        fileBefore = null;
        fileAfter = null;
        continue;
      }
      if (raw.startsWith('--- ')) {
        fileBefore = stripPrefix(raw.slice(4).trim());
        continue;
      }
      if (raw.startsWith('+++ ')) {
        fileAfter = stripPrefix(raw.slice(4).trim());
        continue;
      }
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    // Within a hunk body. First char is the line's kind.
    const kind = raw[0];
    const coverageFile = fileAfter ?? fileBefore;
    if (kind === '+') {
      if (fileAfter !== null && coverageFile !== null) {
        positions.push({
          file: fileAfter,
          side: 'add',
          line: newLine,
          coverageFile,
          body: raw.slice(1),
        });
      }
      newLine += 1;
    } else if (kind === '-') {
      if (fileBefore !== null && coverageFile !== null) {
        positions.push({
          file: fileBefore,
          side: 'delete',
          line: oldLine,
          coverageFile,
          body: raw.slice(1),
        });
      }
      oldLine += 1;
    } else if (kind === ' ') {
      oldLine += 1;
      newLine += 1;
    } else if (kind === '\\') {
      // "\ No newline at end of file" — not a line, skip.
    } else {
      // Anything else (blank trailer, a new header) ends the hunk body.
      inHunk = false;
    }
  }

  return positions;
}
