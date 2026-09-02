// Part ownership, DERIVED — never asserted. Given the per-hunk unit partition
// that `attribute()` already produced (`CoverageItem[]` + its summary) and a
// minimal Part topology (Parts, in causal order, each declaring which
// checkpoints it groups), this module folds the row-level checkpoint
// attribution up into Parts mechanically. The model authoring the topology
// says which checkpoints belong together; it NEVER says which code a Part owns.
// Ownership falls out of the attribution: a Part owns exactly the changed-row
// segments its member checkpoints own, and nothing else.
//
// The ownership UNIT is a changed-row segment (an `owned_slice`'s file + row
// ranges), not a git hunk — a single hunk can contribute segments to several
// Parts. Three things resist that clean fold, and each gets its own bucket:
//   · same-Part ambiguity  — a concurrent-overlap `ambiguous_hunk` whose
//                            candidate checkpoints all sit in ONE Part. It
//                            renders inside that Part, flagged; its rows are
//                            evidence, never an asserted segment.
//   · cross-Part contested — an `ambiguous_hunk` whose candidates span TWO+
//                            Parts. No Part may claim it, so it becomes a
//                            contested entry cross-referencing every involved
//                            Part. (Hunk-grain is acceptable here: an
//                            `ambiguous_hunk` carries counts + candidates, not
//                            row coordinates — see units.ts's overlap path.)
//   · unattributed         — gap/unowned rows (uncaptured human work, the
//                            windows around abandoned checkpoints) plus any
//                            ambiguous hunk whose candidates map to no Part.
//
// Exactly-once is an invariant, not a hope: every reviewable changed row lands
// in exactly one bucket (a Part segment, a Part's in-Part ambiguity, contested,
// or unattributed), and the per-bucket totals are reconciled against the
// `attribute()` coverage summary. Any drift throws — this fails closed rather
// than quietly losing or double-counting a row.

import type { CoverageItem, CoverageSummary, OwnerRef, SliceRange } from '@orcaops/review-core';

// ---------------------------------------------------------------------------
// Inputs — the Part topology the model authors (membership only)
// ---------------------------------------------------------------------------

/**
 * One Part: an id, an optional Act grouping, and the checkpoint refs it groups.
 * Refs use the capture form `a<i>:cp<n>` (artifact alias + checkpoint number).
 * This is the ENTIRE authored surface — membership, never code assignment.
 */
export interface PartInput {
  id: string;
  /** Optional Act this Part rolls up under (topology convenience only). */
  act?: string;
  /** Member checkpoint refs, e.g. `["a1:cp2","a3:cp1"]`. */
  checkpoint_refs: string[];
}

/** The Part topology: Parts in causal order. Membership + grouping only. */
export interface PartTopology {
  parts: PartInput[];
}

/** The `attribute()` coverage output this consumes — items plus the summary it reconciles against. */
export interface CoverageInput {
  items: readonly CoverageItem[];
  summary: CoverageSummary;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * One changed-row segment a Part owns: an `owned_slice` lifted onto its Part.
 * `slice` is the non-durable ordinal within the parent hunk (see keys.ts's
 * sliceKey recipe); identity for display is `(hunkKey, slice)`.
 */
export interface ChangedRowSegment {
  file: string;
  hunkKey: string;
  slice: number;
  owner: { artifact: string; cp: number };
  /** Old-file line range of the run's delete rows (null when it has none). */
  del_range: SliceRange | null;
  /** New-file line range of the run's add rows (null when it has none). */
  add_range: SliceRange | null;
  /** Changed-row count of the run — context is never counted. */
  lines: number;
}

/**
 * A same-Part ambiguity: an `ambiguous_hunk` whose candidate checkpoints all
 * belong to ONE Part. Rendered inside that Part, flagged. Hunk-grain by
 * construction — the overlap downgrade dropped the per-row owners.
 */
export interface InPartAmbiguity {
  file: string;
  hunkKey: string;
  lines: number;
  /** Unique owners observed in the hunk (evidence only, not asserted ownership). */
  candidates: OwnerRef[];
}

/** One Part's derived ownership. */
export interface PartOwnership {
  partId: string;
  act?: string;
  /** The member checkpoint refs, echoed back for the caller. */
  checkpointRefs: string[];
  /** Owned changed-row segments, unioned across every member checkpoint. */
  segments: ChangedRowSegment[];
  /** Same-Part ambiguous hunks, flagged. */
  ambiguous: InPartAmbiguity[];
  /** Attributed changed rows (sum of `segments[].lines`). */
  changedRows: number;
  /** Rows sitting in same-Part ambiguity (sum of `ambiguous[].lines`). */
  ambiguousRows: number;
}

/**
 * A cross-Part contested hunk: an `ambiguous_hunk` whose candidates span two or
 * more Parts. No Part may claim it; `partIds` cross-references every involved
 * Part.
 */
export interface ContestedEntry {
  file: string;
  hunkKey: string;
  lines: number;
  candidates: OwnerRef[];
  /** The Parts whose member checkpoints appear among the candidates (≥2). */
  partIds: string[];
}

/** One unattributed changed-row run: gap-owned, genuinely unowned, or Part-less ambiguity. */
export interface UnattributedEntry {
  file: string;
  hunkKey: string;
  /** Slice ordinal for gap/unowned runs; omitted for whole-hunk ambiguity. */
  slice?: number;
  kind: 'gap' | 'unowned' | 'ambiguous_no_part';
  /** Gap owner ref for `gap`; null for `unowned`/`ambiguous_no_part`. */
  owner: Extract<OwnerRef, { kind: 'gap' }> | null;
  lines: number;
  /** Candidate evidence for `ambiguous_no_part`. */
  candidates?: OwnerRef[];
}

/**
 * Capture-quality metrics over the reviewable changed rows. `attributedPct` is
 * `attributedRows / reviewableRows * 100` (0 when there are no reviewable rows).
 * `ambiguousRows` is same-Part ambiguity only; cross-Part rows live in
 * `contestedRows` — the two never overlap.
 */
export interface CaptureQualityMetrics {
  reviewableRows: number;
  attributedRows: number;
  attributedPct: number;
  ambiguousRows: number;
  contestedRows: number;
  unattributedRows: number;
  contributingThreads: number;
  contributingCheckpoints: number;
}

export interface PartOwnershipResult {
  parts: PartOwnership[];
  contested: ContestedEntry[];
  unattributed: UnattributedEntry[];
  metrics: CaptureQualityMetrics;
}

/**
 * Thrown when the derived buckets fail to reconcile against the coverage
 * summary — a lost, duplicated, or mis-bucketed row, or an owning checkpoint
 * the topology never mapped. The pipeline fails closed rather than emit a
 * Part view that silently disagrees with the attribution it was built from.
 */
export class PartOwnershipInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartOwnershipInvariantError';
  }
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** `{artifact, cp}` → the stable membership key used to resolve a Part. */
function memberKey(artifact: string, cp: number): string {
  return `${artifact}\0${cp}`;
}

const REF_RE = /^(.+):cp(\d+)$/;

/** Parse a `a<i>:cp<n>` checkpoint ref, or throw on a malformed one. */
function parseRef(ref: string): { artifact: string; cp: number } {
  const m = REF_RE.exec(ref);
  if (m === null) {
    throw new PartOwnershipInvariantError(`malformed checkpoint ref '${ref}' (want 'a<i>:cp<n>')`);
  }
  const cp = Number(m[2]);
  if (!Number.isInteger(cp) || cp <= 0) {
    throw new PartOwnershipInvariantError(`checkpoint ref '${ref}' has a non-positive cp number`);
  }
  return { artifact: m[1], cp };
}

/** Build the membership index; a checkpoint claimed by two Parts is a topology error. */
function indexTopology(topology: PartTopology): Map<string, string> {
  const partByMember = new Map<string, string>();
  for (const part of topology.parts) {
    for (const ref of part.checkpoint_refs) {
      const { artifact, cp } = parseRef(ref);
      const key = memberKey(artifact, cp);
      const existing = partByMember.get(key);
      if (existing !== undefined && existing !== part.id) {
        throw new PartOwnershipInvariantError(
          `checkpoint ${ref} is claimed by two Parts ('${existing}' and '${part.id}') — ` +
            `membership must be exclusive`
        );
      }
      partByMember.set(key, part.id);
    }
  }
  return partByMember;
}

/**
 * Fold the per-hunk unit partition up into Parts. Ownership is derived: the
 * caller's topology supplies checkpoint membership only, and every owned row is
 * routed to the Part its checkpoint belongs to. Fails closed if the buckets do
 * not reconcile against `coverage.summary`.
 */
export function derivePartOwnership(
  coverage: CoverageInput,
  topology: PartTopology
): PartOwnershipResult {
  const partByMember = indexTopology(topology);

  // Seed one accumulator per declared Part, in the authored (causal) order.
  const parts = new Map<string, PartOwnership>();
  for (const part of topology.parts) {
    if (parts.has(part.id)) {
      throw new PartOwnershipInvariantError(`duplicate Part id '${part.id}' in topology`);
    }
    parts.set(part.id, {
      partId: part.id,
      ...(part.act !== undefined ? { act: part.act } : {}),
      checkpointRefs: [...part.checkpoint_refs],
      segments: [],
      ambiguous: [],
      changedRows: 0,
      ambiguousRows: 0,
    });
  }

  const contested: ContestedEntry[] = [];
  const unattributed: UnattributedEntry[] = [];

  // Row tallies, kept alongside the buckets so we can reconcile at the end.
  let attributedRows = 0;
  let gapRows = 0;
  let inPartAmbiguousRows = 0;
  let contestedRows = 0;
  let ambiguousNoPartRows = 0;

  const contributingThreads = new Set<string>();
  const contributingCheckpoints = new Set<string>();

  for (const item of coverage.items) {
    // EXCLUDED / UNREVIEWABLE items carry no units — they contribute no
    // reviewable rows and drop out of every bucket by construction.
    for (const unit of item.units) {
      if (unit.kind === 'owned_slice') {
        const key = memberKey(unit.owner.artifact, unit.owner.cp);
        const partId = partByMember.get(key);
        if (partId === undefined) {
          // An asserted-owned row whose checkpoint no Part groups. The topology
          // is incomplete; guessing a Part would fabricate ownership.
          throw new PartOwnershipInvariantError(
            `owned slice in ${item.file} is owned by ${unit.owner.artifact}:cp${unit.owner.cp}, ` +
              `which no Part groups — every owning checkpoint must appear in the topology`
          );
        }
        const part = parts.get(partId)!;
        part.segments.push({
          file: item.file,
          hunkKey: item.hunkKey,
          slice: unit.slice,
          owner: { artifact: unit.owner.artifact, cp: unit.owner.cp },
          del_range: unit.del_range,
          add_range: unit.add_range,
          lines: unit.lines,
        });
        part.changedRows += unit.lines;
        attributedRows += unit.lines;
        contributingThreads.add(unit.owner.artifact);
        contributingCheckpoints.add(key);
      } else if (unit.kind === 'gap_slice') {
        unattributed.push({
          file: item.file,
          hunkKey: item.hunkKey,
          slice: unit.slice,
          kind: unit.owner === null ? 'unowned' : 'gap',
          owner: unit.owner,
          lines: unit.lines,
        });
        gapRows += unit.lines;
      } else {
        // ambiguous_hunk: partition candidates by Part. Only checkpoint
        // candidates carry Part membership; gap candidates are pure evidence.
        const involved = new Set<string>();
        for (const cand of unit.candidates) {
          if (cand.kind !== 'checkpoint') continue;
          const partId = partByMember.get(memberKey(cand.artifact, cand.cp));
          if (partId !== undefined) involved.add(partId);
        }
        if (involved.size >= 2) {
          contested.push({
            file: item.file,
            hunkKey: item.hunkKey,
            lines: unit.lines,
            candidates: unit.candidates,
            partIds: [...involved].sort(),
          });
          contestedRows += unit.lines;
        } else if (involved.size === 1) {
          const part = parts.get([...involved][0])!;
          part.ambiguous.push({
            file: item.file,
            hunkKey: item.hunkKey,
            lines: unit.lines,
            candidates: unit.candidates,
          });
          part.ambiguousRows += unit.lines;
          inPartAmbiguousRows += unit.lines;
        } else {
          unattributed.push({
            file: item.file,
            hunkKey: item.hunkKey,
            kind: 'ambiguous_no_part',
            owner: null,
            lines: unit.lines,
            candidates: unit.candidates,
          });
          ambiguousNoPartRows += unit.lines;
        }
      }
    }
  }

  // Reconcile against the summary the SAME attribute() run produced. Each of
  // these is an independent cross-check on the fold; any mismatch means a row
  // was lost, duplicated, or bucketed against a channel it does not belong to.
  const s = coverage.summary;
  const totalAmbiguous = inPartAmbiguousRows + contestedRows + ambiguousNoPartRows;
  const total = attributedRows + gapRows + totalAmbiguous;
  const mismatch =
    attributedRows !== s.matched_rows ||
    gapRows !== s.unexplained_rows ||
    totalAmbiguous !== s.ambiguous_rows ||
    total !== s.reviewable_rows;
  if (mismatch) {
    throw new PartOwnershipInvariantError(
      `bucket totals do not reconcile with the coverage summary: ` +
        `attributed=${attributedRows} (matched=${s.matched_rows}), ` +
        `gap/unowned=${gapRows} (unexplained=${s.unexplained_rows}), ` +
        `ambiguous=${totalAmbiguous} (ambiguous=${s.ambiguous_rows}), ` +
        `total=${total} (reviewable=${s.reviewable_rows})`
    );
  }

  const unattributedRows = gapRows + ambiguousNoPartRows;
  const metrics: CaptureQualityMetrics = {
    reviewableRows: s.reviewable_rows,
    attributedRows,
    attributedPct: s.reviewable_rows === 0 ? 0 : (attributedRows / s.reviewable_rows) * 100,
    ambiguousRows: inPartAmbiguousRows,
    contestedRows,
    unattributedRows,
    contributingThreads: contributingThreads.size,
    contributingCheckpoints: contributingCheckpoints.size,
  };

  return { parts: [...parts.values()], contested, unattributed, metrics };
}
