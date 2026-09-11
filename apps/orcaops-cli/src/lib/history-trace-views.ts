import type { CheckpointAdjudication } from '@orcaops/storage';

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/**
 * Walk a unified diff and yield every ADDED line with its NEW-side line
 * number — positions valid at the commit the diff targets, which is
 * exactly what agent-trace `ranges` must reference. Line-level (not
 * hunk-level) is deliberate: commit diffs merge adjacent
 * checkpoint-window edits (squashes especially), so exact hunk-hash
 * matching would be systematically sparse; per-line membership survives
 * the merge.
 */
export function parseAddedLines(diffText: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let newLn = 0;
  let inHunk = false;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
      newLn = m ? Number.parseInt(m[1], 10) : 0;
      inHunk = m !== null;
      continue;
    }
    if (!inHunk || file === null) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line: newLn, text: raw.slice(1) });
      newLn += 1;
    } else if (raw.startsWith(' ')) {
      newLn += 1;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // old-side / no-newline marker — no new-side movement
    } else {
      inHunk = false; // section ended (mode lines, binary notice, …)
    }
  }
  return out;
}

/** Merge sorted line numbers into contiguous [start, end] ranges. */
export function toRanges(lines: number[]): Array<{ start_line: number; end_line: number }> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: Array<{ start_line: number; end_line: number }> = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && n === last.end_line + 1) last.end_line = n;
    else ranges.push({ start_line: n, end_line: n });
  }
  return ranges;
}

/** Dual-path membership test against an adjudication file-record set. */
function inFileSet(
  set: ReadonlyArray<{ file_before: string | null; file_after: string | null }>,
  path: string | null
): boolean {
  if (path === null) return false;
  return set.some((f) => f.file_before === path || f.file_after === path);
}

export type OverlapMatchStatus = 'ambiguous' | 'mixed_segment' | 'own_claim_pending' | null;

/**
 * Classify a matched manifest file against a checkpoint's folded
 * adjudication: 'ambiguous' / 'mixed_segment' are WEAK (never clean);
 * 'own_claim_pending' is PROVISIONAL (likely right, unconfirmed until
 * the overlap group fully closes). Null = clean.
 */
export function classifyOverlapMatch(
  adj: CheckpointAdjudication | undefined,
  file: string | null
): OverlapMatchStatus {
  if (adj === undefined) return null;
  if (inFileSet(adj.ambiguous, file)) return 'ambiguous';
  if (inFileSet(adj.mixedSegment, file)) return 'mixed_segment';
  if (inFileSet(adj.ownClaimPending, file)) return 'own_claim_pending';
  return null;
}
