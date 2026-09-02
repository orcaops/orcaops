import type { ManifestSource } from '@orcaops/core';
import {
  type ArtifactRow,
  type CheckpointAdjudication,
  DiffFingerprintManifestSchema,
  RecoveryRefusedError,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
} from '@orcaops/storage';

import type { CliContext } from './context.js';
import { readDerivedCache } from './fingerprint-cache.js';

/**
 * Manifest sourcing per closed checkpoint (shared by diff and export): stored
 * manifest → archive derive-cache (Zod-validated; a failed parse IS the
 * incompatibility signal — algorithm literals are schema-pinned) →
 * file-level degradation over `files_changed`. Degrade, never error.
 *
 * Manifests are never offered unannotated. For any
 * checkpoint carrying `window_overlap`, (a) a derive-cached manifest is
 * filtered through the recorded removals (a cache written before the
 * partition landed — or before this code — must never resurrect
 * dropped hunks), and (b) the adjudication read model is folded so
 * consumers can downgrade matches on ambiguous / mixed_segment files
 * (weak) and own_claim_pending files (provisional) — manifests alone
 * are not trustworthy under overlap.
 */
export interface ManifestSourcingResult {
  sources: ManifestSource[];
  manifestless: Array<{ artifact_id: string; checkpoint_n: number; files_changed: string[] }>;
  /** `<artifact_id>:<n>` → best granularity available for that cp. */
  checkpointGranularity: Record<string, 'hunk' | 'file' | 'incompatible'>;
  incompatibleCount: number;
  /**
   * `<artifact_id>:<n>` → folded adjudication for checkpoints carrying
   * `window_overlap`. Absent key = no overlap, fully trustworthy.
   */
  overlapAdjudications: Map<string, CheckpointAdjudication>;
  /**
   * Artifacts whose recovery-aware checkpoint read refused. Their
   * manifests and claims are ABSENT from every field above, so any
   * consumer that treats absence as strengthening evidence (attribution
   * ambiguity pools) must refuse or downgrade when this is non-empty;
   * coverage-style consumers must disclose it structurally.
   */
  skippedUnreadableArtifacts: string[];
}

export async function loadManifestSources(
  ctx: CliContext,
  candidates: ArtifactRow[]
): Promise<ManifestSourcingResult> {
  const sources: ManifestSource[] = [];
  const manifestless: ManifestSourcingResult['manifestless'] = [];
  const checkpointGranularity: ManifestSourcingResult['checkpointGranularity'] = {};
  const overlapAdjudications: ManifestSourcingResult['overlapAdjudications'] = new Map();
  const warnedUnreadableSiblings = new Set<string>();
  const skippedUnreadableArtifacts: string[] = [];
  let incompatibleCount = 0;

  for (const row of candidates) {
    // Contain per row: one rotted artifact must not abort the manifest
    // aggregate for the whole branch — skip it with a warning (the
    // aggregate is explicitly degraded by the named omission).
    const cps = await ctx.store.readCheckpointsRecovered(row.id).catch((err: unknown) => {
      // Only recovery refusals are containable; anything else (a
      // containment/symlink violation, a programming error) rethrows.
      if (!(err instanceof RecoveryRefusedError)) throw err;
      process.stderr.write(
        `warning: skipping unreadable artifact ${row.id} in manifest sourcing — ` +
          `${err.message}\n`
      );
      return null;
    });
    if (cps === null) {
      skippedUnreadableArtifacts.push(row.id);
      continue;
    }
    const hasOverlap = cps.some((c) => c.status === 'closed' && c.window_overlap !== undefined);
    const adjudications = hasOverlap ? await ctx.store.adjudicateWindowOverlap(row.id) : null;
    for (const cp of cps) {
      if (cp.status !== 'closed') continue;
      const key = `${row.id}:${cp.n}`;
      if (adjudications !== null) {
        const adj = adjudications.get(cp.n);
        if (adj !== undefined) {
          overlapAdjudications.set(key, adj);
          for (const sibId of adj.unreadableSiblingArtifacts) {
            if (warnedUnreadableSiblings.has(sibId)) continue;
            warnedUnreadableSiblings.add(sibId);
            process.stderr.write(
              `warning: overlap adjudication for artifact ${row.id} could not read sibling ` +
                `artifact ${sibId} — its claims stay unresolved and coverage stays provisional; ` +
                `run \`orcaops doctor\` to see the corruption\n`
            );
          }
        }
      }
      // The reader returns NULL for a missing or sidecar-corrupt
      // manifest (a retained summary hash makes that incompatible below);
      // anything it THROWS is
      // an fs/containment/programming error and must propagate — a
      // catch here would relabel real failures as incompatibility.
      let manifest = await ctx.store.readCheckpointDiffFingerprint(row.id, cp.n);
      if (manifest === null && ctx.archive !== null) {
        const cached = await readDerivedCache(ctx.archive.projectDir, row.id, cp.n);
        if (cached !== null) {
          const parsed = DiffFingerprintManifestSchema.safeParse(cached.manifest);
          if (parsed.success) {
            manifest = parsed.data;
          } else {
            incompatibleCount += 1;
            checkpointGranularity[key] = 'incompatible';
            continue;
          }
        }
      }
      // Replay the recorded removals on ANY sourced manifest
      // for a partitioned close. The stored manifest is already
      // filtered (idempotent no-op); a derive-cache entry from an
      // unfiltered derivation is the case this exists for.
      if (manifest !== null && cp.window_overlap !== undefined) {
        manifest = replayWindowOverlapRemovals(manifest, cp.window_overlap);
      }
      // Same doctrine for the unmerged-degraded removal class: never
      // resurrect hunks the close excluded.
      if (manifest !== null && cp.attribution_degraded !== undefined) {
        manifest = replayAttributionDegradedRemovals(
          manifest,
          cp.attribution_degraded.unmerged_paths
        );
      }
      if (manifest !== null) {
        sources.push({ artifact_id: row.id, checkpoint_n: cp.n, ts: cp.closed_at, manifest });
        checkpointGranularity[key] = 'hunk';
      } else if (cp.diff_fingerprint_summary.manifest_hash !== null) {
        incompatibleCount += 1;
        checkpointGranularity[key] = 'incompatible';
      } else {
        manifestless.push({
          artifact_id: row.id,
          checkpoint_n: cp.n,
          files_changed: cp.files_changed,
        });
        checkpointGranularity[key] = 'file';
      }
    }
  }

  return {
    sources,
    manifestless,
    checkpointGranularity,
    incompatibleCount,
    overlapAdjudications,
    skippedUnreadableArtifacts,
  };
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
