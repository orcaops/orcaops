/**
 * Segment evidence for the claims partition under window overlap.
 *
 * Every checkpoint open/close/abandon already snapshots the whole
 * worktree. For an overlap group those boundary trees slice the
 * timeline into SEGMENTS: between two consecutive boundaries, the set
 * of active checkpoints is fixed, so a change landing in a segment with
 * exactly one active checkpoint attributes to it CONCLUSIVELY — no
 * self-report needed — while changes in concurrent segments fall to
 * claim arbitration.
 *
 * Segment diffs are plain UNCAPPED name-status tree diffs
 * (`git diff-tree -r --name-status -z --no-renames`) — NEVER the
 * byte-capped patch pipeline: `diffSnapshotTrees` treats cap-kill as
 * successful truncated output, and a truncated patch would silently
 * omit later file paths and misclassify ownership. Segment evidence
 * needs only names. `--no-renames` is pinned deliberately: renames
 * surface as D(old)+A(new), so BOTH paths land in the segment file-sets
 * deterministically — no R-entry parsing, no config/version surprises.
 *
 * Any git failure or missing boundary tree degrades THAT segment to
 * claims-only (`changedFiles: null`, reason disclosed) — degraded
 * evidence is never guessed. This module lives in core because it needs
 * git; storage stays git-free and receives the computed file-sets.
 */

import type { Repo } from '../git/repo.js';
import { runGit } from '../git/snapshots.js';

/**
 * One lifecycle boundary, ordered by event-log index (storage supplies
 * these from its in-lock scan; the CLI appends the closing cp's fresh
 * close boundary as the final entry — its tree exists only after the
 * close-callback snapshot).
 */
export interface SegmentBoundaryInput {
  /** Event-log index — the ordering key. */
  eventIdx: number;
  /** Checkpoint this boundary belongs to. */
  n: number;
  phase: 'open' | 'close' | 'abandon';
  /** Boundary worktree tree SHA, or null when the snapshot was skipped/failed. */
  treeSha: string | null;
}

export interface WindowSegment {
  /** Boundary pair delimiting the segment (event-log indices). */
  fromEventIdx: number;
  toEventIdx: number;
  /** Checkpoints active throughout this segment, ascending. */
  activeNs: number[];
  /** exclusive = exactly one active checkpoint; concurrent = two or more. */
  kind: 'exclusive' | 'concurrent';
  /**
   * Paths changed between the two boundary trees (deduped, sorted; both
   * rename sides present via --no-renames). Null when this segment
   * degraded — the partition must fall back to claims for it.
   */
  changedFiles: string[] | null;
  degradedReason: 'missing_boundary_tree' | 'git_diff_failed' | null;
}

/**
 * Compute per-segment changed-file sets between consecutive boundaries.
 * `boundaries` MUST be ordered by `eventIdx` and include every group
 * member's known boundaries plus the closing cp's new close boundary
 * last. Active sets are folded from the phases: `open` adds the cp,
 * `close`/`abandon` removes it.
 */
export async function computeWindowSegments(opts: {
  repo: Repo;
  boundaries: readonly SegmentBoundaryInput[];
}): Promise<WindowSegment[]> {
  const { repo, boundaries } = opts;
  const segments: WindowSegment[] = [];
  const active = new Set<number>();

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (b.phase === 'open') active.add(b.n);
    else active.delete(b.n);

    if (i === boundaries.length - 1) break;
    const next = boundaries[i + 1];
    const activeNs = [...active].sort((x, y) => x - y);
    const kind: WindowSegment['kind'] = activeNs.length === 1 ? 'exclusive' : 'concurrent';

    if (b.treeSha === null || next.treeSha === null) {
      segments.push({
        fromEventIdx: b.eventIdx,
        toEventIdx: next.eventIdx,
        activeNs,
        kind,
        changedFiles: null,
        degradedReason: 'missing_boundary_tree',
      });
      continue;
    }

    let changedFiles: string[] | null;
    let degradedReason: WindowSegment['degradedReason'] = null;
    try {
      const result = await runGit(repo.cwd, [
        'diff-tree',
        '-r',
        '--name-status',
        '-z',
        '--no-renames',
        b.treeSha,
        next.treeSha,
      ]);
      if (result.code !== 0) {
        changedFiles = null;
        degradedReason = 'git_diff_failed';
      } else {
        changedFiles = parseNameStatusZ(result.stdout);
      }
    } catch {
      changedFiles = null;
      degradedReason = 'git_diff_failed';
    }

    segments.push({
      fromEventIdx: b.eventIdx,
      toEventIdx: next.eventIdx,
      activeNs,
      kind,
      changedFiles,
      degradedReason,
    });
  }

  return segments;
}

/**
 * Parse `--name-status -z` output: NUL-separated `<status>\0<path>`
 * pairs. With `--no-renames` there are no two-path R/C entries, so the
 * token stream is strictly alternating. All statuses contribute their
 * path (A/M/D/T — a deletion's path is evidence too).
 */
function parseNameStatusZ(stdout: Buffer): string[] {
  const tokens = stdout.toString('utf8').split('\0');
  const files = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i];
    const path = tokens[i + 1];
    if (status.length === 0 || path.length === 0) break;
    files.add(path);
  }
  return [...files].sort();
}
