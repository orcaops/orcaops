// Coverage classification + per-hunk rollup — the engine's main entry.
//
// Pure: the sidecar injects the live review diff bytes and the per-line owners
// (resolved from blaming the synthesized boundary-tree lineage), plus the rung
// inputs, overlap segments, and integrity hash pairs. The engine parses+
// fingerprints the diff itself (both pure primitives), partitions each hunk's
// changed rows into owner slices (`units`), rolls the parent verdict up from
// that partition, classifies exclusions/unreviewables, and folds in every
// disclosure the ladder, integrity check, and overlap produce.
//
// Verdicts: MATCHED (≥1 checkpoint-owned slice) · UNEXPLAINED (all-gap
// or ambiguous — no asserted checkpoint ownership) · EXCLUDED (non-reviewable
// path) · UNREVIEWABLE (binary / no anchorable line / parser mismatch).

import { fingerprintUnifiedDiff } from '@orcaops/diff-fingerprint';

import { COVERAGE_VERDICT, type DiffSide } from '../enums.js';
import { hunkKey } from '../keys.js';
import {
  ATTRIBUTION_RUNG,
  type AttributionLine,
  type AttributionRung,
  type CoverageItem,
  type CoverageSummary,
  type Disclosure,
  DISCLOSURE_CODE,
  type ReviewUnit,
} from '../schema.js';
import { type Chain, segmentOwner } from './chain.js';
import { indexParsedHunks, parseChangedRows } from './changedRows.js';
import { type IntegrityResult, type ManifestIntegrityInput, verifyManifests } from './integrity.js';
import { type CheckpointRungInput, resolveRungs } from './ladder.js';
import { collectHunkUnits, type FileLineIndex } from './units.js';

// The review-exclusion set, seeded from the capture-hygiene internals and
// extensible by the sidecar as needed. These paths are not what a reviewer
// reviews — they render EXCLUDED, no chip.
export const REVIEW_EXCLUDED_PREFIXES: readonly string[] = ['.orcaops/', '.agent-trace/', '.git/'];
export const REVIEW_EXCLUDED_BASENAMES: readonly string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
];

/** Whether a path is excluded from review (capture internals, lockfiles, …). */
export function isExcludedPath(file: string): boolean {
  for (const prefix of REVIEW_EXCLUDED_PREFIXES) {
    if (file.startsWith(prefix) || file.includes(`/${prefix}`)) return true;
  }
  const base = file.split('/').pop() ?? file;
  return REVIEW_EXCLUDED_BASENAMES.includes(base);
}

/** A per-line owner resolved by the sidecar's blame over the chain's lineage. */
export interface LineOwner {
  file: string;
  side: DiffSide;
  /** New-file line (add) or old-file line (delete). */
  line: number;
  /** Chain segment index; maps back to a checkpoint/gap owner via the chain. */
  segment: number;
  /** Optional content hash, carried through for the anchor when present. */
  lineHash?: string;
}

/** A minimal overlap segment (the sidecar derives these from computeWindowSegments). */
export interface OverlapSegment {
  kind: 'exclusive' | 'concurrent';
  changedFiles: string[] | null;
}

export interface AttributeInput {
  chain: Chain;
  reviewDiff: Uint8Array;
  reviewDiffTruncated: boolean;
  /**
   * `review.max_diff_bytes` — the cap `reviewDiff` was collected under. NOT the
   * checkpoint fingerprint cap; naming it precisely is what keeps the truncation
   * disclosure pointing at the setting a user can actually turn.
   */
  reviewMaxDiffBytes: number;
  /**
   * Truncated path only: exact per-path retention/omission detail from the
   * fair review-diff collector.
   */
  truncationDetail?: string;
  /**
   * Truncated path only: known bytes omitted by fair allocation or by trimming
   * a path-scoped capped diff to its final complete hunk.
   */
  truncationDiscardedBytes?: number;
  lineOwners: readonly LineOwner[];
  rungInputs?: readonly CheckpointRungInput[];
  overlapSegments?: readonly OverlapSegment[];
  integrity?: readonly ManifestIntegrityInput[];
}

export interface AttributionResult {
  coverage: { items: CoverageItem[]; summary: CoverageSummary };
  attribution: {
    activeRung: AttributionRung;
    lines: AttributionLine[];
  };
  integrity: IntegrityResult[];
  disclosures: Disclosure[];
}

/** `2000000` → `"2,000,000"`. Locale-independent, so disclosure text is stable. */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function indexLineOwners(lineOwners: readonly LineOwner[]): Map<string, FileLineIndex> {
  const index = new Map<string, FileLineIndex>();
  for (const lo of lineOwners) {
    let entry = index.get(lo.file);
    if (!entry) {
      entry = { add: new Map(), del: new Map() };
      index.set(lo.file, entry);
    }
    (lo.side === 'add' ? entry.add : entry.del).set(lo.line, {
      segment: lo.segment,
      ...(lo.lineHash !== undefined ? { lineHash: lo.lineHash } : {}),
    });
  }
  return index;
}

/** Run the attribution engine over one review diff. */
export async function attribute(input: AttributeInput): Promise<AttributionResult> {
  const hunks = await fingerprintUnifiedDiff({
    diffBytes: input.reviewDiff,
    truncated: input.reviewDiffTruncated,
    maxDiffBytes: input.reviewMaxDiffBytes,
  });
  // The changed-row substrate, parsed from the SAME bytes. `take` cross-checks
  // coordinates + changed-row counts per hunk; a mismatch fails closed below.
  const parsedRows = indexParsedHunks(parseChangedRows(input.reviewDiff));

  const ambiguousFiles = new Set<string>();
  for (const seg of input.overlapSegments ?? []) {
    if (seg.kind === 'concurrent' && seg.changedFiles) {
      for (const file of seg.changedFiles) ambiguousFiles.add(file);
    }
  }

  const lineIndex = indexLineOwners(input.lineOwners);
  const occurrence = new Map<string, number>();
  const items: CoverageItem[] = [];
  const misalignedFiles = new Set<string>();

  for (const hunk of hunks) {
    const file = hunk.file_after ?? hunk.file_before ?? '(unknown)';
    const occKey = `${file}\u0000${hunk.patch_hash}`;
    const occ = occurrence.get(occKey) ?? 0;
    occurrence.set(occKey, occ + 1);
    const key = await hunkKey({ filePath: file, contentHash: hunk.patch_hash, occurrence: occ });

    let verdict: CoverageItem['verdict'];
    let units: ReviewUnit[] = [];

    if (isExcludedPath(file)) {
      verdict = COVERAGE_VERDICT.EXCLUDED;
    } else if (hunk.binary || hunk.added_line_count + hunk.deleted_line_count === 0) {
      verdict = COVERAGE_VERDICT.UNREVIEWABLE;
    } else {
      const rows = parsedRows.take(hunk);
      if (rows === null) {
        // FAIL CLOSED: the row parser and the fingerprint disagree about this
        // hunk. Guessing would assign rows to the wrong parent — render it
        // unreviewable and disclose instead.
        verdict = COVERAGE_VERDICT.UNREVIEWABLE;
        misalignedFiles.add(file);
      } else {
        units = collectHunkUnits(
          input.chain,
          rows.rows,
          lineIndex.get(file),
          ambiguousFiles.has(file)
        );
        // Pure rollup over the unit partition: ≥1 checkpoint-owned slice →
        // MATCHED; all-gap/unowned or ambiguous → UNEXPLAINED.
        verdict = units.some((u) => u.kind === 'owned_slice')
          ? COVERAGE_VERDICT.MATCHED
          : COVERAGE_VERDICT.UNEXPLAINED;
      }
    }

    items.push({
      hunkKey: key,
      file,
      verdict,
      old_start: hunk.old_start,
      new_start: hunk.new_start,
      added_lines: hunk.added_line_count,
      removed_lines: hunk.deleted_line_count,
      units,
    });
  }

  let matchedRows = 0;
  let unexplainedRows = 0;
  let ambiguousRows = 0;
  for (const item of items) {
    for (const unit of item.units) {
      if (unit.kind === 'owned_slice') matchedRows += unit.lines;
      else if (unit.kind === 'gap_slice') unexplainedRows += unit.lines;
      else ambiguousRows += unit.lines;
    }
  }

  const summary: CoverageSummary = {
    excluded: items.filter((i) => i.verdict === COVERAGE_VERDICT.EXCLUDED).length,
    unreviewable: items.filter((i) => i.verdict === COVERAGE_VERDICT.UNREVIEWABLE).length,
    matched_rows: matchedRows,
    unexplained_rows: unexplainedRows,
    ambiguous_rows: ambiguousRows,
    reviewable_rows: matchedRows + unexplainedRows + ambiguousRows,
  };

  const lines: AttributionLine[] = [];
  for (const lo of input.lineOwners) {
    const owner = segmentOwner(input.chain, lo.segment);
    if (!owner) continue;
    lines.push({ file: lo.file, side: lo.side, line: lo.line, owner });
  }

  const rung = resolveRungs(input.rungInputs ?? [], input.chain.excluded);
  const integ = verifyManifests(input.integrity ?? []);

  const disclosures: Disclosure[] = [...rung.disclosures, ...integ.disclosures];
  if (misalignedFiles.size > 0) {
    disclosures.push({
      code: DISCLOSURE_CODE.ATTRIBUTION_RUNG_DOWNGRADE,
      message:
        `${misalignedFiles.size} file(s) failed the changed-row parser cross-check against the ` +
        `diff fingerprint — the affected hunks failed closed to UNREVIEWABLE rather than risk ` +
        `misattributed rows: ${[...misalignedFiles].sort().join(', ')}`,
    });
  }
  if (ambiguousFiles.size > 0) {
    disclosures.push({
      code: DISCLOSURE_CODE.OVERLAP_DOWNGRADE,
      message: `${ambiguousFiles.size} file(s) changed in a concurrent-agent window — attribution downgraded to hunk grain: ${[...ambiguousFiles].sort().join(', ')}`,
    });
  }
  if (input.reviewDiffTruncated) {
    // The true patch size is unknowable at the cap (git is killed mid-stream),
    // so state the cap explicitly and name the offenders when the engine
    // supplied a numstat detail. Name the SETTING, not just a size: the reader's
    // next move is to turn `review.max_diff_bytes` up, and dividing a
    // 2_000_000-byte cap by 1 MiB would print "1.9MB", which matches nothing the
    // user could type. State bytes.
    // The collector emits complete hunks only and allocates capacity across paths.
    // State every known omitted byte and every incomplete path; a capped patch must
    // never look like a complete review surface.
    const discarded = input.truncationDiscardedBytes ?? 0;
    const trimmed =
      discarded > 0
        ? `; ≥${groupDigits(discarded)} bytes omitted while retaining complete hunks fairly across paths`
        : '';
    disclosures.push({
      code: DISCLOSURE_CODE.LIVE_DIFF_TRUNCATED,
      message:
        `the live review diff exceeded the review.max_diff_bytes cap ` +
        `(${groupDigits(input.reviewMaxDiffBytes)} bytes) and is incomplete — ` +
        `coverage exists only for the explicitly retained complete hunks` +
        trimmed +
        (input.truncationDetail ? `; ${input.truncationDetail}` : ''),
    });
  }

  // Nothing usable in the whole chain → the Trust band should say so even when
  // no per-checkpoint rung inputs were provided.
  const activeRung: AttributionRung =
    input.chain.segments.some((s) => s.kind === 'checkpoint') || (input.rungInputs?.length ?? 0) > 0
      ? rung.activeRung
      : ATTRIBUTION_RUNG.UNATTRIBUTED;

  return {
    coverage: { items, summary },
    attribution: { activeRung, lines },
    integrity: integ.results,
    disclosures,
  };
}
