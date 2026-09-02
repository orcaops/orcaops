// The attribution degradation ladder + the disclosures it emits.
//
// Each in-scope checkpoint attributes at the strongest rung its available
// inputs allow:
//   1 snapshot_chain  boundary trees present (+ blame) → exact last-writer
//   2 hash_match      trees gone, stored manifest present → patch/line-hash match
//   3 file_level      manifest gone too, files_changed present → file-grain
//   4 unattributed    nothing → trail only; its diff share reads UNEXPLAINED
//
// The Trust band shows ONE active rung — the WEAKEST any checkpoint fell to, so
// the floor never over-claims. Every downgrade, truncation, and exclusion is
// disclosed per checkpoint rather than hidden.

import {
  ATTRIBUTION_RUNG,
  type AttributionRung,
  type Disclosure,
  DISCLOSURE_CODE,
} from '../schema.js';
import type { ExcludedCheckpoint } from './chain.js';

/** What inputs a single checkpoint has available, for rung selection. */
export interface CheckpointRungInput {
  artifact: string;
  cp: number;
  /** Both boundary trees present AND the segment blame is available (rung 1). */
  hasBoundaryTrees: boolean;
  /** Stored diff-fingerprint manifest present (rung 2). */
  hasManifest: boolean;
  /** `files_changed` present (rung 3). */
  hasFilesChanged: boolean;
  /**
   * A segment/manifest was truncated at `diff_fingerprint.max_diff_bytes` (the
   * CAPTURE-time cap — not `review.max_diff_bytes`) — disclose, never silent.
   */
  manifestTruncated?: boolean;
}

export interface PerCheckpointRung {
  artifact: string;
  cp: number;
  rung: AttributionRung;
}

export interface RungResolution {
  /** Weakest rung actually used — the honest Trust-band floor. */
  activeRung: AttributionRung;
  perCheckpoint: PerCheckpointRung[];
  disclosures: Disclosure[];
}

// Strongest → weakest. A lower index is a stronger rung.
const RUNG_ORDER: readonly AttributionRung[] = [
  ATTRIBUTION_RUNG.SNAPSHOT_CHAIN,
  ATTRIBUTION_RUNG.HASH_MATCH,
  ATTRIBUTION_RUNG.FILE_LEVEL,
  ATTRIBUTION_RUNG.UNATTRIBUTED,
];

function rungRank(rung: AttributionRung): number {
  return RUNG_ORDER.indexOf(rung);
}

/** The strongest rung a checkpoint's available inputs support. */
export function rungForCheckpoint(input: CheckpointRungInput): AttributionRung {
  if (input.hasBoundaryTrees) return ATTRIBUTION_RUNG.SNAPSHOT_CHAIN;
  if (input.hasManifest) return ATTRIBUTION_RUNG.HASH_MATCH;
  if (input.hasFilesChanged) return ATTRIBUTION_RUNG.FILE_LEVEL;
  return ATTRIBUTION_RUNG.UNATTRIBUTED;
}

/**
 * Resolve per-checkpoint rungs, the weakest-used active rung, and every
 * disclosure the ladder + chain exclusions produce.
 */
export function resolveRungs(
  inputs: readonly CheckpointRungInput[],
  excluded: readonly ExcludedCheckpoint[] = []
): RungResolution {
  const perCheckpoint: PerCheckpointRung[] = [];
  const disclosures: Disclosure[] = [];

  for (const input of inputs) {
    const rung = rungForCheckpoint(input);
    perCheckpoint.push({ artifact: input.artifact, cp: input.cp, rung });

    if (rung === ATTRIBUTION_RUNG.HASH_MATCH || rung === ATTRIBUTION_RUNG.FILE_LEVEL) {
      disclosures.push({
        code: DISCLOSURE_CODE.ATTRIBUTION_RUNG_DOWNGRADE,
        artifact: input.artifact,
        cp: input.cp,
        message: `attributed at ${rung} — boundary trees unavailable`,
      });
    } else if (rung === ATTRIBUTION_RUNG.UNATTRIBUTED) {
      disclosures.push({
        code: DISCLOSURE_CODE.MANIFESTLESS_CHECKPOINT,
        artifact: input.artifact,
        cp: input.cp,
        message:
          'no boundary trees, manifest, or files_changed — contributes trail only; its diff share reads UNEXPLAINED',
      });
    }

    if (input.manifestTruncated) {
      disclosures.push({
        code: DISCLOSURE_CODE.TRUNCATED_MANIFEST,
        artifact: input.artifact,
        cp: input.cp,
        message:
          'a segment exceeded diff_fingerprint.max_diff_bytes at capture and was truncated — attribution on the truncated span is incomplete',
      });
    }
  }

  for (const ex of excluded) {
    if (ex.reason === 'abandoned') {
      disclosures.push({
        code: DISCLOSURE_CODE.ABANDONED_CHECKPOINT_EXCLUDED,
        artifact: ex.artifact,
        cp: ex.n,
        message: 'abandoned checkpoint excluded from the chain — its work reads as gap / reverted',
      });
    } else if (ex.reason === 'missing_trees') {
      disclosures.push({
        code: DISCLOSURE_CODE.MANIFESTLESS_CHECKPOINT,
        artifact: ex.artifact,
        cp: ex.n,
        message:
          'closed checkpoint with a failed snapshot — excluded from the chain; its diff share reads UNEXPLAINED',
      });
    }
    // `open` (in-flight) exclusion is benign and expected — no disclosure.
  }

  const activeRung = perCheckpoint.reduce<AttributionRung>(
    (weakest, p) => (rungRank(p.rung) > rungRank(weakest) ? p.rung : weakest),
    ATTRIBUTION_RUNG.SNAPSHOT_CHAIN
  );

  return { activeRung, perCheckpoint, disclosures };
}
