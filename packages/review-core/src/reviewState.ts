// Set-aware review-state matching: does a recorded mark-reviewed manifest
// still cover the section's CURRENT changed rows?
//
// Identity is content (`file`/`side`/`lineHash`); `line` and `hunkKey` are
// re-anchoring HINTS only — both shift across re-floors (an edit above moves
// lines; any edit inside a hunk re-mints its content-hash key), so neither can
// be identity without misclassifying unchanged reviewed rows as growth.
//
// Matching mirrors the comment re-anchoring philosophy: match reviewed records
// one-to-one against current rows (same file+side+lineHash bucket; prefer the
// same surviving hunk; else nearest line; never consume a current row twice).
// Then:
//   unmatched CURRENT rows  = genuine growth  → the mark is STALE
//   unmatched REVIEWED rows = shrink          → the mark stays valid
// Ownership transfer naturally stales the receiving section without staling
// the shrinking one.

import { stableHash64 } from './keys.js';
import type { ReviewedRow } from './schema.js';

export type { ReviewedRow };

export interface RowMatchResult {
  /** Reviewed rows matched 1:1 to a current row. */
  matched: number;
  /** Current rows no reviewed record covers — genuine growth. */
  newRows: number;
  /** Reviewed rows with no current counterpart — harmless shrink. */
  removedRows: number;
  /** True iff the section grew (`newRows > 0`). */
  stale: boolean;
}

function bucketKey(row: ReviewedRow): string {
  return `${row.file}\u0000${row.side}\u0000${row.lineHash}`;
}

/**
 * Match a recorded manifest against the section's current rows. Pure and
 * deterministic: reviewed rows are consumed in input order, and each picks
 * its best remaining candidate — same `hunkKey` first (when both sides carry
 * one), then smallest line distance, then first-listed.
 */
export function matchReviewedRows(
  reviewed: readonly ReviewedRow[],
  current: readonly ReviewedRow[]
): RowMatchResult {
  const buckets = new Map<string, ReviewedRow[]>();
  for (const row of current) {
    const key = bucketKey(row);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }

  let matched = 0;
  for (const record of reviewed) {
    const bucket = buckets.get(bucketKey(record));
    if (!bucket || bucket.length === 0) continue; // shrink — stays reviewed
    let bestIdx = 0;
    let bestSameHunk = false;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bucket.length; i += 1) {
      const candidate = bucket[i];
      const sameHunk =
        record.hunkKey !== undefined &&
        candidate.hunkKey !== undefined &&
        record.hunkKey === candidate.hunkKey;
      const distance = Math.abs(candidate.line - record.line);
      const better =
        (sameHunk && !bestSameHunk) || (sameHunk === bestSameHunk && distance < bestDistance);
      if (better) {
        bestIdx = i;
        bestSameHunk = sameHunk;
        bestDistance = distance;
      }
    }
    bucket.splice(bestIdx, 1);
    matched += 1;
  }

  let leftover = 0;
  for (const bucket of buckets.values()) leftover += bucket.length;

  return {
    matched,
    newRows: leftover,
    removedRows: reviewed.length - matched,
    stale: leftover > 0,
  };
}

/**
 * Content digest of a row set — the fast unchanged path. Hashes the SORTED
 * (file, side, lineHash) multiset only: the positional/hunk hints are
 * excluded so a pure move (identical content, shifted lines, re-keyed hunks)
 * still short-circuits without running the matcher. Multiset equality of
 * content identities implies neither growth nor shrink.
 */
export async function reviewedRowsDigest(rows: readonly ReviewedRow[]): Promise<string> {
  const canonical = rows.map(bucketKey).sort();
  return stableHash64('orcaops.review.reviewed_rows.v1', canonical);
}
