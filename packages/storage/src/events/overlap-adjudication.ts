/**
 * Adjudication read model over window-overlap groups.
 *
 * Manifests alone are NOT trustworthy under overlap: the event log is
 * append-only, so final ambiguity can land on a LATER close than the
 * manifest it affects (A closes first claiming F; B closes later also
 * claiming F — A's persisted record never changes). Every manifest
 * consumer therefore reads adjudication as a DERIVED VIEW folded over
 * the whole group's `window_overlap` records:
 *
 *  - `ambiguous` / `mixed_segment`: weak evidence — never clean.
 *  - `own_claim_pending`: PROVISIONAL, distinct from weak — the
 *    attribution is likely right but unconfirmed while any sibling in
 *    the group is still open. Resolves at fold time once all siblings
 *    closed: no sibling claim → clean; a sibling claim → ambiguous.
 *  - dropped `sibling_pending`: resolves to sibling-claimed or
 *    unclaimed at finalization.
 *
 * Pure fold — no I/O. `ArtifactStore.adjudicateWindowOverlap` loads the
 * inputs (including cross-artifact sibling checkpoints named by the
 * pending records) and calls this.
 */

import type { WindowOverlap, WindowOverlapFile } from '../schema/checkpoint.js';

export interface AdjudicationCheckpoint {
  n: number;
  status: 'open' | 'closed' | 'abandoned';
  filesChanged: readonly string[];
  windowOverlap?: WindowOverlap;
}

/** Sibling checkpoints of OTHER artifacts, keyed by artifact_id. */
export type CrossArtifactCheckpoints = ReadonlyMap<
  string,
  ReadonlyArray<{
    n: number;
    status: 'open' | 'closed' | 'abandoned';
    filesChanged: readonly string[];
  }>
>;

export interface CheckpointAdjudication {
  n: number;
  /** Weak — matches on these files are ambiguous, never clean. */
  ambiguous: WindowOverlapFile[];
  /** Weak — kept on evidence, hunk set cannot be split. */
  mixedSegment: WindowOverlapFile[];
  /**
   * Provisional — own-claimed while a sibling is still open. Distinct
   * reason from weak: likely right, unconfirmed. Empty once finalized.
   */
  ownClaimPending: WindowOverlapFile[];
  /** Removed at close, with pending statuses resolved where possible. */
  dropped: Array<{
    file_before: string | null;
    file_after: string | null;
    status: 'sibling-claimed' | 'sibling_pending' | 'unclaimed';
  }>;
  /** Files this cp holds purely on exclusive-segment evidence. */
  segmentAttributed: string[];
  /** True once every group member (incl. cross-artifact) has finalized. */
  finalized: boolean;
  /** Finalized files nobody claimed or segment-attributed (loud). */
  unattributedInWindow: string[];
  /**
   * Cross-artifact siblings this cp's records name whose checkpoints
   * could not be read. Their claims are unknowable, so they are folded
   * exactly like still-open siblings — the group never finalizes and
   * nothing lifts to clean. Diff-family consumers surface this field in
   * their structured disclosure; consumers that only read `finalized`
   * (digest, why) stay conservative without naming it.
   */
  unreadableSiblingArtifacts: string[];
}

const fileMatches = (f: WindowOverlapFile, path: string): boolean =>
  f.file_before === path || f.file_after === path;

const claimsFile = (claims: readonly string[], f: WindowOverlapFile): boolean =>
  claims.some((p) => fileMatches(f, p));

/**
 * Fold one artifact's checkpoints (plus any cross-artifact siblings the
 * records name) into per-checkpoint final adjudication sets. Returns an
 * entry ONLY for checkpoints carrying `window_overlap` — everything
 * else needs no downgrade.
 */
export function adjudicateOverlapGroups(
  checkpoints: readonly AdjudicationCheckpoint[],
  crossArtifact: CrossArtifactCheckpoints = new Map(),
  unreadableCross: ReadonlySet<string> = new Set()
): Map<number, CheckpointAdjudication> {
  const byN = new Map(checkpoints.map((c) => [c.n, c]));
  const out = new Map<number, CheckpointAdjudication>();

  for (const cp of checkpoints) {
    const wo = cp.windowOverlap;
    if (wo === undefined) continue;

    // Group members from THIS cp's perspective.
    const siblings = wo.siblings
      .map((n) => byN.get(n))
      .filter((s): s is AdjudicationCheckpoint => s !== undefined);
    const crossSiblings = wo.cross_artifact_siblings.map((ref) => {
      const rows = crossArtifact.get(ref.artifact_id) ?? [];
      return rows.find((r) => r.n === ref.n) ?? null;
    });
    const anyOpen =
      siblings.some((s) => s.status === 'open') ||
      crossSiblings.some((s) => s === null || s.status === 'open');
    const allSiblingClaims: string[] = [
      ...siblings.flatMap((s) => [...s.filesChanged]),
      ...crossSiblings.flatMap((s) => (s === null ? [] : [...s.filesChanged])),
    ];

    // Resolve own_claim_pending: still pending while any sibling is
    // open; once all closed, a sibling claim → ambiguous, else clean.
    const ambiguous = [...wo.ambiguous_files];
    const stillPending: WindowOverlapFile[] = [];
    for (const f of wo.own_claim_pending) {
      if (anyOpen) {
        stillPending.push(f);
      } else if (claimsFile(allSiblingClaims, f)) {
        ambiguous.push(f);
      }
      // else: lifted to clean — no entry anywhere.
    }

    // Symmetric view: a LATER sibling close may have recorded ambiguity
    // on a file THIS cp holds (its own record predates the claim). Any
    // sibling's ambiguous_files entry that this cp's manifest could
    // carry (it claimed or segment-holds the file) applies to both.
    for (const s of siblings) {
      for (const f of s.windowOverlap?.ambiguous_files ?? []) {
        const mineToo =
          claimsFile(cp.filesChanged, f) ||
          wo.own_claim_pending.some(
            (p) => p.file_before === f.file_before && p.file_after === f.file_after
          );
        if (
          mineToo &&
          !ambiguous.some((a) => a.file_before === f.file_before && a.file_after === f.file_after)
        ) {
          ambiguous.push(f);
        }
      }
    }

    // Resolve dropped sibling_pending → sibling-claimed | unclaimed.
    const dropped = wo.dropped_files.map((d) => {
      if (d.status !== 'sibling_pending' || anyOpen) return { ...d };
      const record: WindowOverlapFile = { file_before: d.file_before, file_after: d.file_after };
      return {
        ...d,
        status: claimsFile(allSiblingClaims, record)
          ? ('sibling-claimed' as const)
          : ('unclaimed' as const),
      };
    });

    // Finalized unattributed set: this cp's record (last close stamps
    // it) plus any now-resolved unclaimed drops.
    const unattributed = new Set(wo.unattributed_in_window);
    if (!anyOpen) {
      for (const d of dropped) {
        if (d.status === 'unclaimed') unattributed.add(d.file_after ?? d.file_before ?? '');
      }
      unattributed.delete('');
    }

    out.set(cp.n, {
      n: cp.n,
      ambiguous,
      mixedSegment: [...wo.mixed_segment],
      ownClaimPending: stillPending,
      dropped,
      segmentAttributed: [...wo.segment_attributed],
      finalized: !anyOpen,
      unattributedInWindow: [...unattributed].sort(),
      unreadableSiblingArtifacts: [
        ...new Set(
          wo.cross_artifact_siblings
            .map((ref) => ref.artifact_id)
            .filter((id) => unreadableCross.has(id))
        ),
      ].sort(),
    });
  }

  return out;
}
