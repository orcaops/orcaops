// The changed-row substrate: parse a raw unified diff into per-hunk changed
// rows with BOTH coordinates — the own-side line number (what blame/owners key
// on) and the patchRow ordinal within the hunk body (what slice runs key on).
// Context rows are represented while parsing (they advance patchRow, which is
// how they break logical runs) but never emitted, so an absent owner on an
// emitted row is distinguishable from an unchanged context row.
//
// The walk mirrors the sidecar's `parseDiffLinePositions` (same path handling,
// same tolerance) so the rows align one-to-one with `fingerprintUnifiedDiff`'s
// hunks on any diff git produces. Alignment is never assumed, though —
// `indexParsedHunks(...).take(hunk)` cross-checks coordinates AND changed-row
// counts, and a mismatch fails CLOSED (the caller renders the hunk
// UNREVIEWABLE with a disclosure) rather than assigning rows to the wrong
// parent.

import type { DiffFingerprintHunk } from '@orcaops/diff-fingerprint';

import type { DiffSide } from '../enums.js';

/** One changed row of a hunk, in both coordinate systems. */
export interface ChangedRow {
  side: DiffSide;
  /** New-file line number for adds; old-file line number for deletes. */
  line: number;
  /** 0-based ordinal within the hunk body — context rows advance it. */
  patchRow: number;
  /** Raw line body after the `+`/`-` prefix. */
  body: string;
}

/** All changed rows of one parsed hunk, with the header coordinates. */
export interface ParsedHunkRows {
  /** `file_after ?? file_before` — the same path attribution mints hunkKeys under. */
  coverageFile: string;
  oldStart: number;
  newStart: number;
  /** Changed-row counts, for the fingerprint cross-check. */
  addedRows: number;
  deletedRows: number;
  rows: ChangedRow[];
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
 * Parse a unified diff into per-hunk changed rows. Pure and tolerant:
 * unrecognized lines are skipped, matching the fingerprint parser, and a
 * truncated stream simply yields the rows present (the cross-check against
 * the fingerprint hunks — parsed from the same bytes — still aligns).
 */
/**
 * True while `raw` still belongs to the hunk body that precedes it. A body row
 * carries a sign column; `\\` introduces `\\ No newline at end of file`, which
 * annotates the row before it. Git renders an empty context line as a single
 * space, so a bare newline ends the hunk.
 */
function continuesHunkBody(raw: string): boolean {
  const sign = raw.charAt(0);
  return sign === ' ' || sign === '+' || sign === '-' || sign === '\\';
}

export function parseChangedRows(diffBytes: Uint8Array): ParsedHunkRows[] {
  const text = decoder.decode(diffBytes);
  const hunks: ParsedHunkRows[] = [];

  let fileBefore: string | null = null;
  let fileAfter: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let patchRow = 0;
  let current: ParsedHunkRows | null = null;

  // Inside a hunk every row carries a sign column, so the file-header prefixes
  // describe the SIGNED row rather than its content: a deleted `-- ` line
  // renders as `--- ` and an added `++ ` line as `+++ `. Reading one as a
  // header cleared the hunk and dropped every row behind it, so this parser
  // reported zero changed rows for the file while the diff fingerprint counted
  // them — and the cross-check failed the whole file closed to UNREVIEWABLE.
  let inHunk = false;

  for (const raw of text.split('\n')) {
    if (inHunk && !continuesHunkBody(raw)) inHunk = false;
    if (!inHunk) {
      if (raw.startsWith('diff --git')) {
        fileBefore = null;
        fileAfter = null;
        current = null;
        continue;
      }
      if (raw.startsWith('--- ')) {
        fileBefore = stripPrefix(raw.slice(4).trim());
        current = null;
        continue;
      }
      if (raw.startsWith('+++ ')) {
        fileAfter = stripPrefix(raw.slice(4).trim());
        current = null;
        continue;
      }
    }
    const header = HUNK_RE.exec(raw);
    if (header) {
      inHunk = true;
      const coverageFile = fileAfter ?? fileBefore;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      patchRow = 0;
      if (coverageFile !== null) {
        current = {
          coverageFile,
          oldStart: oldLine,
          newStart: newLine,
          addedRows: 0,
          deletedRows: 0,
          rows: [],
        };
        hunks.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (current === null) continue;

    const kind = raw[0];
    if (kind === '+') {
      current.rows.push({ side: 'add', line: newLine, patchRow, body: raw.slice(1) });
      current.addedRows += 1;
      newLine += 1;
      patchRow += 1;
    } else if (kind === '-') {
      current.rows.push({ side: 'delete', line: oldLine, patchRow, body: raw.slice(1) });
      current.deletedRows += 1;
      oldLine += 1;
      patchRow += 1;
    } else if (kind === ' ') {
      oldLine += 1;
      newLine += 1;
      patchRow += 1;
    } else if (kind === '\\') {
      // "\ No newline at end of file" — not a row, does not advance patchRow.
    } else {
      // Anything else (blank trailer, a new header) ends the hunk body.
      current = null;
    }
  }

  return hunks;
}

/** Consumed-once lookup from a fingerprint hunk to its parsed rows. */
export interface ParsedHunkLookup {
  /**
   * The parsed rows for a fingerprint hunk, or null when no aligned parse
   * exists — missing hunk, coordinate mismatch, changed-row count mismatch,
   * or a duplicate take. Null means FAIL CLOSED: the caller must render the
   * hunk UNREVIEWABLE and disclose, never guess.
   */
  take(hunk: DiffFingerprintHunk): ParsedHunkRows | null;
}

function positionKey(file: string, oldStart: number | null, newStart: number | null): string {
  return `${file}\u0000${oldStart ?? ''}\u0000${newStart ?? ''}`;
}

/**
 * Index parsed hunks by (coverageFile, oldStart, newStart) — unique within a
 * diff — for the fingerprint cross-check. Each entry is consumed exactly once.
 */
export function indexParsedHunks(parsed: readonly ParsedHunkRows[]): ParsedHunkLookup {
  const byPosition = new Map<string, ParsedHunkRows>();
  for (const hunk of parsed) {
    byPosition.set(positionKey(hunk.coverageFile, hunk.oldStart, hunk.newStart), hunk);
  }
  return {
    take(hunk) {
      const file = hunk.file_after ?? hunk.file_before;
      if (file === null) return null;
      const key = positionKey(file, hunk.old_start, hunk.new_start);
      const match = byPosition.get(key);
      if (match === undefined) return null;
      byPosition.delete(key);
      if (
        match.addedRows !== hunk.added_line_count ||
        match.deletedRows !== hunk.deleted_line_count
      ) {
        return null;
      }
      return match;
    },
  };
}
