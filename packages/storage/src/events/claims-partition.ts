/**
 * Pure segment-refined claims partition.
 *
 * Under a detected window overlap the whole-worktree fence diff is
 * untrustworthy — it contains every concurrent agent's work. This
 * module rebuilds the closing checkpoint's manifest from an evidence
 * hierarchy:
 *
 *   1. SEGMENTS (observational): changes in segments where ONLY this cp
 *      was active attribute to it conclusively — no claim needed, and a
 *      forgotten self-report cannot lose the file.
 *   2. CLAIMS (self-report): close-time `files_changed` arbitrates the
 *      genuinely concurrent segments only.
 *   3. FLAGS (honest residual): remaining ambiguity is flagged, never
 *      silently attributed.
 *
 * The contract, structurally: close REMOVES a set and KEEPS a set.
 * Every non-kept file is physically removed from the persisted manifest
 * and recorded in `window_overlap.dropped_files` with its status — an
 * unclaimed hunk must never sit in any checkpoint's manifest, where
 * manifest sourcing would push it as evidence and the matcher would
 * index it. Removal is only ever safe for files with NO positive
 * ownership evidence — neither an own claim NOR exclusive-me segment
 * evidence (both suffice independently to keep; segment proof outranks
 * self-report). Kept-but-flagged files (`ambiguous_files`,
 * `mixed_segment`, `own_claim_pending`) REMAIN in the hashable
 * manifest; their downgrade lives in the adjudication read model.
 *
 * Pure: no I/O, no git — segment evidence is computed in core/CLI and
 * passed in; the store calls this under its one lock. Async only for
 * the manifest-hash recompute (the {manifest, summary} pair MUST stay
 * consistent — persisting a filtered manifest under the unfiltered
 * summary would persist a lie and break the derive verifier).
 */

import { computeDiffFingerprintManifestHash, summarizeManifest } from '@orcaops/diff-fingerprint';

import type {
  WindowOverlap,
  WindowOverlapDroppedFile,
  WindowOverlapFile,
} from '../schema/checkpoint.js';
import type {
  DiffFingerprintHunk,
  DiffFingerprintManifest,
  DiffFingerprintSummary,
} from '../schema/diff-fingerprint.js';

/** Structural mirror of core's WindowSegment (storage must not import core). */
export interface PartitionSegment {
  fromEventIdx: number;
  toEventIdx: number;
  activeNs: readonly number[];
  kind: 'exclusive' | 'concurrent';
  /** Null → degraded segment (claims-only for files that may fall in it). */
  changedFiles: readonly string[] | null;
  degradedReason: string | null;
}

export interface PartitionSibling {
  n: number;
  status: 'open' | 'closed' | 'abandoned';
  filesChanged: readonly string[];
}

export interface ClaimsPartitionInput {
  currentN: number;
  /** This close's self-reported files_changed — the attribution claim. */
  ownClaim: readonly string[];
  /** Whole-window manifest/summary as built by the CLI; manifest null when fingerprinting skipped. */
  manifest: DiffFingerprintManifest | null;
  summary: DiffFingerprintSummary;
  siblings: readonly PartitionSibling[];
  /**
   * Segment evidence over the group's boundary timeline (including
   * segments outside this cp's window — own-claim rejection needs
   * them). Empty → claims-only (disclosed by the caller's degradations).
   */
  segments: readonly PartitionSegment[];
  /** Cross-artifact overlap voids segment evidence entirely (claims-only, pending). */
  crossArtifactSiblings: readonly { artifact_id: string; n: number }[];
  /**
   * Caller-known degradations to disclose (e.g. the close callback
   * could not compute segment evidence at all). Merged into
   * `window_overlap.degradations` — never silent.
   */
  extraDegradations?: readonly string[];
  /**
   * Paths unmerged in the real index at the open OR close boundary. Their
   * hunks are removed AFTER this partition (`applyUnmergedExclusion`);
   * here they are only kept out of the positive-attribution sets — a merge
   * landing in a solo-active segment would otherwise conclusively
   * `segment_attributed` the merge's upstream content, and an unmerged path
   * is degraded, not `unattributed_in_window`.
   */
  unmergedPaths?: readonly string[];
}

export interface ClaimsPartitionResult {
  manifest: DiffFingerprintManifest | null;
  summary: DiffFingerprintSummary;
  windowOverlap: WindowOverlap;
}

/** Per-file evidence classes within the closing cp's own window. */
type Evidence = 'exclusive' | 'concurrent' | 'mixed' | 'unknown';

interface PairInfo {
  key: string;
  file_before: string | null;
  file_after: string | null;
  hunks: DiffFingerprintHunk[];
}

const pairKey = (before: string | null, after: string | null): string =>
  `${before ?? ''}\u0000${after ?? ''}`;

const matchesPath = (
  pair: { file_before: string | null; file_after: string | null },
  path: string
): boolean => pair.file_before === path || pair.file_after === path;

const claimNames = (claim: readonly string[], pair: PairInfo): boolean =>
  claim.some((p) => matchesPath(pair, p));

const toFileRecord = (pair: PairInfo): WindowOverlapFile => ({
  file_before: pair.file_before,
  file_after: pair.file_after,
});

const sortKey = (f: { file_before: string | null; file_after: string | null }): string =>
  f.file_after ?? f.file_before ?? '';

/**
 * Rebuild a manifest around a kept-hunk subset, keeping the wire
 * contract coherent: counts track the kept set, and a
 * filtered-to-nothing manifest normalizes to `status: 'empty'`
 * (`captured` requires hunk_count > 0). BOTH the close-time partition
 * and the derive replay use this — byte-identical normalization is
 * what makes the replayed hash reproduce the stored one.
 */
function rebuildFilteredManifest(
  manifest: DiffFingerprintManifest,
  keptHunks: DiffFingerprintManifest['hunks']
): DiffFingerprintManifest {
  const removedCount = manifest.hunks.length - keptHunks.length;
  const filtered: DiffFingerprintManifest = {
    ...manifest,
    hunks: keptHunks,
    hunk_count: Math.max(0, manifest.hunk_count - removedCount),
    captured_hunk_count: Math.max(0, manifest.captured_hunk_count - removedCount),
  };
  if (filtered.hunks.length === 0 && filtered.hunk_count === 0) {
    return { ...filtered, status: 'empty', truncated: false, error_reason: null };
  }
  return filtered;
}

/**
 * Deterministic replay of what a partitioned close REMOVED — for
 * `fingerprint derive` and the archive derived-cache read, which
 * re-derive an UNFILTERED manifest from the stored boundary trees. The
 * filter set is EXACTLY the recorded removals — `dropped_files` in ALL
 * statuses plus `rejected_claims` — matched dual-path (a record naming
 * either side of a rename filters the hunk under both). No
 * re-adjudication. The kept-but-flagged sets REMAIN: they were kept at
 * close, so removing them here would itself create false hash drift.
 */
export function replayWindowOverlapRemovals(
  manifest: DiffFingerprintManifest,
  windowOverlap: Pick<WindowOverlap, 'dropped_files' | 'rejected_claims'>
): DiffFingerprintManifest {
  const droppedPaths = new Set<string>();
  for (const d of windowOverlap.dropped_files) {
    if (d.file_before !== null) droppedPaths.add(d.file_before);
    if (d.file_after !== null) droppedPaths.add(d.file_after);
  }
  for (const p of windowOverlap.rejected_claims) droppedPaths.add(p);
  if (droppedPaths.size === 0) return manifest;

  const keptHunks = manifest.hunks.filter(
    (h) =>
      !(h.file_before !== null && droppedPaths.has(h.file_before)) &&
      !(h.file_after !== null && droppedPaths.has(h.file_after))
  );
  if (keptHunks.length === manifest.hunks.length) return manifest;
  return rebuildFilteredManifest(manifest, keptHunks);
}

/**
 * Deterministic replay of the unmerged-path exclusion — the second
 * removal class alongside `replayWindowOverlapRemovals`, keyed off the
 * close's `attribution_degraded.unmerged_paths` record. Paths unmerged at
 * the open OR close boundary have their hunks removed from the persisted
 * manifest (a hunk touching one on EITHER side of a rename filters
 * dual-path); derive consumers re-derive UNFILTERED from the boundary
 * trees and must replay this removal or every degraded close reads as a
 * hash mismatch. Returns the input manifest untouched when nothing
 * matches — byte-identity is what keeps clean closes clean.
 */
export function replayAttributionDegradedRemovals(
  manifest: DiffFingerprintManifest,
  unmergedPaths: readonly string[]
): DiffFingerprintManifest {
  if (unmergedPaths.length === 0) return manifest;
  const excluded = new Set(unmergedPaths);
  const keptHunks = manifest.hunks.filter(
    (h) =>
      !(h.file_before !== null && excluded.has(h.file_before)) &&
      !(h.file_after !== null && excluded.has(h.file_after))
  );
  if (keptHunks.length === manifest.hunks.length) return manifest;
  return rebuildFilteredManifest(manifest, keptHunks);
}

/**
 * Close-time application of the unmerged-path exclusion: filter the
 * manifest and recompute the `{manifest, summary}` pair consistently
 * (persisting a filtered manifest under the unfiltered summary would
 * persist a lie and break the derive verifier). Pass-through when nothing
 * matches. Runs AFTER `applyClaimsPartition` — pre-filtering would make
 * the partition's own-claim `inManifest` check misclassify an honestly-
 * claimed conflicted path as a rejected claim.
 */
export async function applyUnmergedExclusion(
  manifest: DiffFingerprintManifest,
  summary: DiffFingerprintSummary,
  unmergedPaths: readonly string[]
): Promise<{ manifest: DiffFingerprintManifest; summary: DiffFingerprintSummary }> {
  const filtered = replayAttributionDegradedRemovals(manifest, unmergedPaths);
  // No-match closes pass both objects through byte-identical.
  if (filtered === manifest) return { manifest, summary };
  const hash = await computeDiffFingerprintManifestHash(filtered);
  return { manifest: filtered, summary: summarizeManifest(filtered, hash) };
}

/**
 * Apply the partition. Returns the (possibly filtered) manifest with a
 * summary recomputed from it in the same step, plus the append-only
 * `window_overlap` record for the close event. When nothing is removed
 * the manifest and summary pass through BYTE-IDENTICAL (no recompute) —
 * flags never alter the hashable manifest.
 */
export async function applyClaimsPartition(
  input: ClaimsPartitionInput
): Promise<ClaimsPartitionResult> {
  const { currentN, ownClaim, manifest, summary, siblings, crossArtifactSiblings } = input;

  const crossArtifact = crossArtifactSiblings.length > 0;
  const openSiblings = siblings.filter((s) => s.status === 'open');
  const closedSiblings = siblings.filter((s) => s.status === 'closed');
  const pendingSiblings = openSiblings.length > 0 || crossArtifact;

  const degradations = new Set<string>(input.extraDegradations ?? []);
  const unmergedSet = new Set<string>(input.unmergedPaths ?? []);
  if (unmergedSet.size > 0) degradations.add('unmerged_paths_excluded');
  // Cross-artifact overlap voids segments: the sibling shares the
  // worktree but its boundaries live in another event log whose only
  // ordering is wall-clock — "exclusive" cannot be established.
  const segments: readonly PartitionSegment[] = crossArtifact ? [] : input.segments;
  if (crossArtifact) degradations.add('cross_artifact_claims_only');
  for (const seg of segments) {
    if (seg.changedFiles === null) {
      degradations.add(`${seg.degradedReason ?? 'degraded'}:${seg.fromEventIdx}-${seg.toEventIdx}`);
    }
  }
  const anyDegradedSegment = crossArtifact || segments.some((s) => s.changedFiles === null);

  const mySegments = segments.filter(
    (s) => s.changedFiles !== null && s.activeNs.includes(currentN)
  );
  const foreignSegments = segments.filter(
    (s) => s.changedFiles !== null && !s.activeNs.includes(currentN)
  );

  // ── Group manifest hunks by dual-path identity ─────────────────────
  const pairs = new Map<string, PairInfo>();
  for (const hunk of manifest?.hunks ?? []) {
    const key = pairKey(hunk.file_before, hunk.file_after);
    const existing = pairs.get(key);
    if (existing) existing.hunks.push(hunk);
    else
      pairs.set(key, {
        key,
        file_before: hunk.file_before,
        file_after: hunk.file_after,
        hunks: [hunk],
      });
  }

  const evidenceFor = (pair: PairInfo): Evidence => {
    if (crossArtifact) return 'unknown';
    let exclusive = false;
    let concurrent = false;
    let seen = false;
    for (const seg of mySegments) {
      const files = seg.changedFiles as readonly string[];
      if (!files.some((f) => matchesPath(pair, f))) continue;
      seen = true;
      // Within this cp's window it is active in every segment, so an
      // exclusive segment here is exclusive-me by construction.
      if (seg.kind === 'exclusive') exclusive = true;
      else concurrent = true;
    }
    if (!seen) return 'unknown';
    if (exclusive && concurrent) return 'mixed';
    return exclusive ? 'exclusive' : 'concurrent';
  };

  // ── Partition every manifest pair ──────────────────────────────────
  const dropped: WindowOverlapDroppedFile[] = [];
  const ambiguous: WindowOverlapFile[] = [];
  const mixed: WindowOverlapFile[] = [];
  const ownClaimPending: WindowOverlapFile[] = [];
  const segmentAttributed = new Set<string>();
  const removedKeys = new Set<string>();

  for (const pair of pairs.values()) {
    const mine = claimNames(ownClaim, pair);
    const closedClaimants = closedSiblings.filter((s) => claimNames(s.filesChanged, pair));
    const evidence = evidenceFor(pair);

    if (evidence === 'exclusive') {
      // Conclusively mine — segment proof outranks every claim. Unmerged
      // paths are excepted: a merge landing in a solo-active segment
      // would otherwise conclusively attribute the merge's upstream
      // content to this cp.
      if (!mine) {
        for (const p of [pair.file_before, pair.file_after]) {
          if (p !== null && !unmergedSet.has(p)) segmentAttributed.add(p);
        }
      }
      continue; // kept, clean
    }
    if (evidence === 'mixed') {
      // Kept on EVIDENCE, not claimant status: the exclusive delta
      // exists in no other manifest. Downgraded in the read model —
      // file-level evidence cannot split the whole-window hunk set.
      mixed.push(toFileRecord(pair));
      continue;
    }

    // 'concurrent' or 'unknown' (degraded / cross-artifact): claims arbitrate.
    if (evidence === 'unknown' && !crossArtifact && !anyDegradedSegment) {
      // The pair matched no segment despite intact evidence — e.g. a
      // net-zero rewrite across boundaries. Disclose rather than guess.
      degradations.add(`segment_evidence_incomplete:${sortKey(pair)}`);
    }

    if (mine) {
      if (closedClaimants.length > 0) {
        // Claimed by both sides of a concurrent window — never silently
        // double-attributed; kept in both manifests, flagged. Recorded
        // here (the later close); the earlier closer's record is
        // append-only and stays untouched.
        ambiguous.push(toFileRecord(pair));
      } else if (pendingSiblings) {
        ownClaimPending.push(toFileRecord(pair));
      }
      // else: mine alone, all siblings closed — kept clean.
      continue;
    }

    // No own claim, no exclusive evidence → removal is safe.
    let status: WindowOverlapDroppedFile['status'];
    if (closedClaimants.length > 0) status = 'sibling-claimed';
    else if (pendingSiblings) status = 'sibling_pending';
    else status = 'unclaimed';
    dropped.push({ file_before: pair.file_before, file_after: pair.file_after, status });
    removedKeys.add(pair.key);
  }

  // ── Own-claim rejection: claimed, but changed only while not open ──
  const rejectedClaims: string[] = [];
  for (const path of ownClaim) {
    const inManifest = [...pairs.values()].some((p) => matchesPath(p, path));
    if (inManifest) continue;
    const changedElsewhere = foreignSegments.some((s) =>
      (s.changedFiles as readonly string[]).includes(path)
    );
    const changedInMine = mySegments.some((s) =>
      (s.changedFiles as readonly string[]).includes(path)
    );
    if (changedElsewhere && !changedInMine) rejectedClaims.push(path);
    // Neither: a plain unsupported claim — pre-existing behavior, not
    // an overlap concern.
  }

  // ── Last close: finalize the unattributed-in-window warning set ────
  const isLastClose = !pendingSiblings;
  const unattributed: string[] = [];
  if (isLastClose) {
    const allClaims = new Set<string>(ownClaim);
    for (const s of siblings) for (const f of s.filesChanged) allClaims.add(f);
    const fileSegKinds = new Map<string, { exclusiveOnly: boolean }>();
    for (const seg of segments) {
      if (seg.changedFiles === null) continue;
      for (const f of seg.changedFiles) {
        const entry = fileSegKinds.get(f) ?? { exclusiveOnly: true };
        if (seg.activeNs.length !== 1) entry.exclusiveOnly = false;
        fileSegKinds.set(f, entry);
      }
    }
    for (const [file, info] of fileSegKinds) {
      if (allClaims.has(file)) continue;
      if (info.exclusiveOnly) continue; // conclusively segment-attributed to its owners
      if (unmergedSet.has(file)) continue; // degraded, not unattributed
      unattributed.push(file);
    }
    unattributed.sort();
  }

  // ── Filter + recompute the {manifest, summary} pair consistently ───
  let outManifest = manifest;
  let outSummary = summary;
  if (manifest !== null && removedKeys.size > 0) {
    const keptHunks = manifest.hunks.filter(
      (h) => !removedKeys.has(pairKey(h.file_before, h.file_after))
    );
    const filtered = rebuildFilteredManifest(manifest, keptHunks);
    const hash = await computeDiffFingerprintManifestHash(filtered);
    outManifest = filtered;
    outSummary = summarizeManifest(filtered, hash);
  }

  const windowOverlap: WindowOverlap = {
    siblings: siblings.map((s) => s.n).sort((a, b) => a - b),
    cross_artifact_siblings: [...crossArtifactSiblings]
      .map((s) => ({ artifact_id: s.artifact_id, n: s.n }))
      .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id) || a.n - b.n),
    pending: pendingSiblings,
    dropped_files: dropped.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    rejected_claims: rejectedClaims.sort(),
    ambiguous_files: ambiguous.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    mixed_segment: mixed.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    own_claim_pending: ownClaimPending.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    segment_attributed: [...segmentAttributed].sort(),
    unattributed_in_window: unattributed,
    degradations: [...degradations].sort(),
  };

  return { manifest: outManifest, summary: outSummary, windowOverlap };
}
