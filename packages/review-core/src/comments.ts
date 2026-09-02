// Comment replay + the re-anchor ladder.
//
// `comments.ndjson` is an append-only log of comment events (add / reply /
// status — see `commentEventSchema`). This module folds that log into the
// aggregate `CommentRecord`s the verbs emit and the TUI renders, counts the
// open comments the mark-reviewed gate and cockpit badges read, and resolves
// each comment's CONTENT anchor against the current diff — the ladder
// `line_hash → hunk → file → section`, with an explicit `drifted` flag when
// resolution lands below the anchor's native grain. Never dropped: a comment
// that resolves nowhere still surfaces (`unanchored`).
//
// Everything here is PURE: the sidecar reads the files, hashes the current
// diff's lines, and injects them as a `CurrentDiffIndex`.

import { COMMENT_AUTHOR, COMMENT_STATUS, type DiffSide } from './enums.js';
import type { CommentAnchor, CommentEvent, CommentRecord } from './schema.js';

// ---------------------------------------------------------------------------
// Replay — fold the event log into aggregate records
// ---------------------------------------------------------------------------

/** Parse an event ts to epoch ms; unparseable → 0 (sorts first, never crashes). */
function tsValue(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Fold comment events into records. Events replay in chronological order
 * (numeric ts, append order on ties). `add` creates a record (a duplicate
 * add for an existing id is ignored); `reply` appends to the thread; `status`
 * sets the current status. A reply/status whose comment_id has no add — a
 * torn or lost add line — is skipped, never fatal.
 */
export function replayComments(events: readonly CommentEvent[]): CommentRecord[] {
  const ordered = [...events].sort((a, b) => tsValue(a.ts) - tsValue(b.ts));
  const byId = new Map<string, CommentRecord>();
  for (const ev of ordered) {
    if (ev.type === 'add') {
      if (byId.has(ev.comment_id)) continue;
      byId.set(ev.comment_id, {
        comment_id: ev.comment_id,
        ts: ev.ts,
        author: ev.author,
        body: ev.body,
        status: COMMENT_STATUS.OPEN,
        anchor: ev.anchor,
        replies: [],
      });
    } else if (ev.type === 'reply') {
      const rec = byId.get(ev.comment_id);
      if (!rec) continue;
      rec.replies.push({
        ts: ev.ts,
        author: ev.author,
        body: ev.body,
        checkpoint_ref: ev.checkpoint_ref ?? null,
      });
    } else {
      const rec = byId.get(ev.comment_id);
      if (rec) rec.status = ev.status;
    }
  }
  return [...byId.values()].sort(
    (a, b) => tsValue(a.ts) - tsValue(b.ts) || (a.comment_id < b.comment_id ? -1 : 1)
  );
}

/** Open comments, any author — the cockpit `✎ n` badge count. */
export function openCommentCount(records: readonly CommentRecord[]): number {
  return records.filter((r) => r.status === COMMENT_STATUS.OPEN).length;
}

/**
 * Reviewer comments whose current resolved content owner is exactly one checkpoint.
 * A missing/unresolved owner gates Finish branch-wide, but never every page in a thread.
 */
export function ownOpenCommentCountForCheckpoint(
  records: readonly (CommentRecord & {
    owner?: { artifact: string; cp: number } | null;
  })[],
  checkpoint: { artifact: string; cp: number }
): number {
  return records.filter(
    (record) =>
      record.status === COMMENT_STATUS.OPEN &&
      record.author === COMMENT_AUTHOR.REVIEWER &&
      record.owner?.artifact === checkpoint.artifact &&
      record.owner.cp === checkpoint.cp
  ).length;
}

/**
 * The reviewer's own open comments BRANCH-WIDE — the finish gate's comment input.
 *
 * A comment whose content has no current checkpoint owner gates no page, but it
 * is still an open question the reviewer asked and nobody answered. Finishing
 * over it would file the review as done with the reviewer's own words hanging
 * unanswered.
 *
 * There is no "blocking" flag to consult — the schema has only OPEN/RESOLVED and
 * REVIEWER/AGENT — so open-and-mine IS the definition.
 */
export function openReviewerCommentCount(records: readonly CommentRecord[]): number {
  return records.filter(
    (r) => r.status === COMMENT_STATUS.OPEN && r.author === COMMENT_AUTHOR.REVIEWER
  ).length;
}

// ---------------------------------------------------------------------------
// The trivial-line guard (authoring + resolution)
// ---------------------------------------------------------------------------

const TRIVIAL_CHARS = new Set([...'{}()[];,.:\'"`<>/\\|&+-=*']);

/**
 * A line too common to anchor by content hash — `}`, `);`, an empty line.
 * Heuristic: after trimming, at most 2 characters, or punctuation-only.
 * Authoring prefers a non-trivial changed line; resolution treats the hunk as
 * a trivial anchor's native grain. Applies to ANCHORING only, never ownership.
 */
export function isTrivialAnchorBody(body: string): boolean {
  const t = body.trim();
  if (t.length <= 2) return true;
  for (const ch of t) {
    if (!TRIVIAL_CHARS.has(ch)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The re-anchor ladder — line_hash → hunk → file → section
// ---------------------------------------------------------------------------

/** One changed line of the CURRENT diff, hashed with the manifest line-hash recipe. */
export interface CurrentDiffLine {
  file: string;
  side: DiffSide;
  /** New-file line number for adds; old-file line number for deletes. */
  line: number;
  lineHash: string;
  /** The floor hunk containing this line, when position-matched. */
  hunkKey: string | null;
}

/** What the ladder resolves against — the sidecar assembles this from diff.patch + floor. */
export interface CurrentDiffIndex {
  /** Changed lines of the current diff. Only the anchored files need to be present. */
  lines: readonly CurrentDiffLine[];
  /** Every hunkKey in the current floor. */
  hunkKeys: ReadonlySet<string>;
  /** Every file present in the current diff. */
  files: ReadonlySet<string>;
  /** Every threadKey in the current floor. */
  threadKeys: ReadonlySet<string>;
  /** Pinned-head lines offered for unchanged-context comment resolution. */
  contextLines?: readonly CurrentContextLine[];
}

export interface CurrentContextLine {
  file: string;
  headBlobOid: string;
  line: number;
  lineHash: string;
}

export const REANCHOR_RUNG = {
  LINE: 'line_hash',
  HUNK: 'hunk',
  FILE: 'file',
  SECTION: 'section',
  UNANCHORED: 'unanchored',
  UNCHANGED_CONTEXT: 'unchanged_context',
} as const;
export type ReanchorRung = (typeof REANCHOR_RUNG)[keyof typeof REANCHOR_RUNG];

/** Where a comment renders NOW. `drifted` = resolution fell below the anchor's native grain. */
export interface ReanchoredPosition {
  rung: ReanchorRung;
  file: string | null;
  side: DiffSide | null;
  /** Current line number at line grain; null below it. */
  line: number | null;
  /**
   * Range anchors only: the last resolved line at line grain. Null for
   * single-line anchors, below line grain, and when a range resolved to a
   * single surviving line.
   */
  endLine: number | null;
  hunkKey: string | null;
  threadKey: string | null;
  drifted: boolean;
}

/** One hunk's monotonic resolution of a range anchor's hashes (best-of below). */
interface RangeResolution {
  hunkKey: string | null;
  /** Resolved line numbers, ascending (greedy monotonic assignment order). */
  lines: number[];
  /** Whether `lineHashes[0]` (the primary line's hash) was among the resolved. */
  firstResolved: boolean;
}

/**
 * Resolve a range anchor's `lineHashes` POSITIONALLY AND MONOTONICALLY against
 * one candidate hunk's changed lines (`side` already filtered, ascending by
 * line): walk the hashes in order and greedily bind each to the next unmatched
 * line at a strictly increasing line number. A hash may repeat (`}` lines) —
 * the monotonic assignment is the disambiguator, NOT set membership.
 */
function resolveRangeInHunk(
  hashes: readonly string[],
  lines: readonly CurrentDiffLine[]
): { lines: number[]; firstResolved: boolean } {
  const resolved: number[] = [];
  let firstResolved = false;
  let from = 0;
  for (let i = 0; i < hashes.length; i += 1) {
    for (let j = from; j < lines.length; j += 1) {
      if (lines[j]!.lineHash === hashes[i]) {
        resolved.push(lines[j]!.line);
        if (i === 0) firstResolved = true;
        from = j + 1;
        break;
      }
    }
  }
  return { lines: resolved, firstResolved };
}

/**
 * The winning hunk for a range anchor: most monotonic resolutions; tie → the
 * hunk that resolved `lineHashes[0]`, else the lowest resolved start line.
 * Null when no hunk resolved a single hash.
 */
function resolveRange(
  anchor: Extract<CommentAnchor, { kind: 'DIFF_RANGE' }>,
  hashes: readonly string[],
  index: CurrentDiffIndex
): RangeResolution | null {
  const byHunk = new Map<string | null, CurrentDiffLine[]>();
  for (const l of index.lines) {
    if (l.file !== anchor.file || l.side !== anchor.side) continue;
    const group = byHunk.get(l.hunkKey);
    if (group !== undefined) group.push(l);
    else byHunk.set(l.hunkKey, [l]);
  }
  let best: RangeResolution | null = null;
  for (const [hunkKey, group] of byHunk) {
    group.sort((a, b) => a.line - b.line);
    const { lines, firstResolved } = resolveRangeInHunk(hashes, group);
    if (lines.length === 0) continue;
    const candidate: RangeResolution = { hunkKey, lines, firstResolved };
    if (
      best === null ||
      candidate.lines.length > best.lines.length ||
      (candidate.lines.length === best.lines.length &&
        ((candidate.firstResolved && !best.firstResolved) ||
          (candidate.firstResolved === best.firstResolved && candidate.lines[0]! < best.lines[0]!)))
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Resolve an anchor against the current diff, walking down the ladder:
 *
 *  1. `line_hash` — a UNIQUE (file, side, lineHash) match among the current
 *     changed lines; ties broken by the anchor's hunk, else nearest line.
 *     Content-anchored, so a moved line is NOT drift.
 *  2. `hunk` — the anchor's hunkKey still exists. Native (not drifted) when
 *     the hash was merely ambiguous — a trivial line anchors at its hunk —
 *     drifted when the hashed content is gone.
 *  3. `file` — the file is still in the diff. Always drifted.
 *  4. `section` — the anchor's threadKey still exists; renders in the
 *     section header area, flagged. Always drifted.
 *  5. `unanchored` — nothing resolves; the comment index still lists it.
 *
 * Range anchors (`lineHashes` present) replace rungs 1-2 with a monotonic
 * per-hunk resolution: the winning hunk's resolved lines clamp to
 * `line = min`, `endLine = max` — a range is NEVER split into multiple pins —
 * with `drifted` set when any hash failed to resolve. Zero resolutions
 * anywhere fall to the hunk rung via `anchor.hunkKey` (drifted), then
 * file/section/unanchored exactly as a single-line anchor would.
 */
export function reanchorComment(
  anchor: CommentAnchor,
  index: CurrentDiffIndex
): ReanchoredPosition {
  if (anchor.kind === 'UNCHANGED_CONTEXT_LINE') {
    const threadKey =
      anchor.threadKey !== undefined && index.threadKeys.has(anchor.threadKey)
        ? anchor.threadKey
        : null;
    const matches = (index.contextLines ?? []).filter(
      (line) =>
        line.file === anchor.file &&
        line.headBlobOid === anchor.headBlobOid &&
        line.lineHash === anchor.lineHash
    );
    if (matches.length > 0) {
      const hit = matches.reduce((a, b) =>
        Math.abs(b.line - anchor.line) < Math.abs(a.line - anchor.line) ? b : a
      );
      return {
        rung: REANCHOR_RUNG.UNCHANGED_CONTEXT,
        file: hit.file,
        side: null,
        line: hit.line,
        endLine: null,
        hunkKey: null,
        threadKey,
        drifted: false,
      };
    }
    const contextFileExists = (index.contextLines ?? []).some(
      (line) => line.file === anchor.file && line.headBlobOid === anchor.headBlobOid
    );
    if (contextFileExists || index.files.has(anchor.file)) {
      return {
        rung: REANCHOR_RUNG.FILE,
        file: anchor.file,
        side: null,
        line: null,
        endLine: null,
        hunkKey: null,
        threadKey,
        drifted: true,
      };
    }
    if (threadKey !== null) {
      return {
        rung: REANCHOR_RUNG.SECTION,
        file: null,
        side: null,
        line: null,
        endLine: null,
        hunkKey: null,
        threadKey,
        drifted: true,
      };
    }
    return {
      rung: REANCHOR_RUNG.UNANCHORED,
      file: null,
      side: null,
      line: null,
      endLine: null,
      hunkKey: null,
      threadKey: null,
      drifted: true,
    };
  }

  const threadKey =
    anchor.threadKey !== undefined && index.threadKeys.has(anchor.threadKey)
      ? anchor.threadKey
      : null;
  const hunkKey =
    anchor.hunkKey !== undefined && index.hunkKeys.has(anchor.hunkKey) ? anchor.hunkKey : null;

  if (anchor.kind === 'DIFF_RANGE') {
    const rangeHashes = anchor.lineHashes;
    // Range rungs 1-2; single-line anchors use the path below.
    const winner = resolveRange(anchor, rangeHashes, index);
    if (winner !== null) {
      return {
        rung: REANCHOR_RUNG.LINE,
        file: anchor.file,
        side: anchor.side,
        line: winner.lines[0]!,
        endLine: winner.lines.length > 1 ? winner.lines[winner.lines.length - 1]! : null,
        hunkKey: winner.hunkKey ?? hunkKey,
        threadKey,
        drifted: winner.lines.length < rangeHashes.length,
      };
    }
    if (hunkKey !== null) {
      // Every hash gone but the hunk survives — content drift, hunk grain.
      return {
        rung: REANCHOR_RUNG.HUNK,
        file: anchor.file,
        side: anchor.side,
        line: null,
        endLine: null,
        hunkKey,
        threadKey,
        drifted: true,
      };
    }
    // Falls to the shared file/section/unanchored tail below.
  } else {
    // Rung 1: content match.
    const matches = index.lines.filter(
      (l) => l.file === anchor.file && l.side === anchor.side && l.lineHash === anchor.lineHash
    );
    if (matches.length > 0) {
      let hit: CurrentDiffLine | undefined;
      if (matches.length === 1) hit = matches[0];
      else if (hunkKey !== null) {
        // Ambiguous (trivial content): trust it only inside the anchor's own hunk.
        const inHunk = matches.filter((l) => l.hunkKey === hunkKey);
        if (inHunk.length > 0)
          hit = inHunk.reduce((a, b) =>
            Math.abs(b.line - anchor.line) < Math.abs(a.line - anchor.line) ? b : a
          );
      }
      if (hit !== undefined) {
        return {
          rung: REANCHOR_RUNG.LINE,
          file: hit.file,
          side: hit.side,
          line: hit.line,
          endLine: null,
          hunkKey: hit.hunkKey ?? hunkKey,
          threadKey,
          drifted: false,
        };
      }
      // Ambiguous with no hunk to disambiguate — fall through to the hunk rung
      // (below): a trivial line's native grain is its hunk.
    }

    // Rung 2: the anchor's hunk.
    if (hunkKey !== null) {
      // Ambiguous-hash (trivial anchor) → native grain; hash gone → content drift.
      const drifted = matches.length === 0;
      return {
        rung: REANCHOR_RUNG.HUNK,
        file: anchor.file,
        side: anchor.side,
        line: null,
        endLine: null,
        hunkKey,
        threadKey,
        drifted,
      };
    }
  }

  // Rung 3: the file.
  if (index.files.has(anchor.file)) {
    return {
      rung: REANCHOR_RUNG.FILE,
      file: anchor.file,
      side: null,
      line: null,
      endLine: null,
      hunkKey: null,
      threadKey,
      drifted: true,
    };
  }

  // Rung 4: the section header area.
  if (threadKey !== null) {
    return {
      rung: REANCHOR_RUNG.SECTION,
      file: null,
      side: null,
      line: null,
      endLine: null,
      hunkKey: null,
      threadKey,
      drifted: true,
    };
  }

  // Rung 5: never dropped.
  return {
    rung: REANCHOR_RUNG.UNANCHORED,
    file: null,
    side: null,
    line: null,
    endLine: null,
    hunkKey: null,
    threadKey: null,
    drifted: true,
  };
}
