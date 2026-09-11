import type { ManifestSource } from '@orcaops/core';
import {
  adjudicateOverlapGroups,
  type ArtifactThread,
  type CheckpointAdjudication,
  type ClosedCheckpoint,
  type DiffFingerprintManifest,
  replayAttributionDegradedRemovals,
  replayWindowOverlapRemovals,
  resolveRecordedFingerprintBaseline,
  validateCheckpointFingerprintManifest,
} from '@orcaops/storage';
import {
  type ProjectDatabase,
  ProjectDatabaseError,
  readProjectArtifactDetails,
} from '@orcaops/storage/history/database';

export const DEFAULT_OVERLAP_SUPPORT_BUDGET = 500;

type AdjudicationRow = Parameters<typeof adjudicateOverlapGroups>[0][number];

/**
 * The retained `checkpoint_closed` payload is the only manifest authority. A
 * payload without the key was never captured; a payload whose manifest no longer
 * parses reads as absent, which the sourcing below reports as incompatible when
 * the closed summary still retains a manifest hash.
 */
export async function retainedCheckpointManifest(
  thread: ArtifactThread,
  checkpoint: ClosedCheckpoint
): Promise<DiffFingerprintManifest | null> {
  const closed = thread.events.find(
    (event) => event.record.event_id === checkpoint.source_event_ids.closed
  );
  const raw = (closed?.payload as { diff_fingerprint_manifest?: unknown } | undefined)
    ?.diff_fingerprint_manifest;
  if (raw === undefined) return null;
  const validated = await validateCheckpointFingerprintManifest({
    artifactId: thread.artifactId,
    checkpointN: checkpoint.n,
    // Explicit fingerprint inspection can use a recovered window distinct from physical snapshots.
    openTreeSha: null,
    closeTreeSha: null,
    summary: checkpoint.diff_fingerprint_summary,
    manifest: raw,
  });
  return validated.available ? validated.manifest : null;
}

function adjudicationRows(thread: ArtifactThread): AdjudicationRow[] {
  return thread.checkpoints.map((checkpoint) => ({
    n: checkpoint.n,
    status: checkpoint.status,
    filesChanged: checkpoint.status === 'closed' ? checkpoint.files_changed : [],
    ...(checkpoint.status === 'closed' && checkpoint.window_overlap !== undefined
      ? { windowOverlap: checkpoint.window_overlap }
      : {}),
  }));
}

function referencedSiblings(thread: ArtifactThread): string[] {
  return [
    ...new Set(
      thread.checkpoints.flatMap((checkpoint) =>
        checkpoint.status === 'closed'
          ? (checkpoint.window_overlap?.cross_artifact_siblings ?? []).map(
              (sibling) => sibling.artifact_id
            )
          : []
      )
    ),
  ];
}

export function recordedOverlapSiblings(threads: readonly ArtifactThread[]): string[] {
  const selected = new Set(threads.map((thread) => thread.artifactId));
  return [...new Set(threads.flatMap(referencedSiblings))].filter((id) => !selected.has(id)).sort();
}

export interface OverlapSupport {
  siblings: ReadonlyMap<string, ArtifactThread>;
  unavailable: ReadonlySet<string>;
  omitted: readonly string[];
  budget: number;
}
export const EMPTY_OVERLAP_SUPPORT: OverlapSupport = {
  siblings: new Map(),
  unavailable: new Set(),
  omitted: [],
  budget: DEFAULT_OVERLAP_SUPPORT_BUDGET,
};

/**
 * Hydrates only siblings a closed checkpoint records, one short read each, under a
 * budget separate from the primary selection. Omitted and unavailable siblings fold
 * like still-open ones, so nothing lifts to clean on missing evidence. A sibling the
 * caller already hydrated is reused rather than re-read or reported unreadable — the
 * budget bounds extra reads, not the evidence already in hand.
 */
export function readDatabaseOverlapSupport(
  database: ProjectDatabase,
  threads: readonly ArtifactThread[],
  budget = DEFAULT_OVERLAP_SUPPORT_BUDGET
): OverlapSupport {
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Overlap support budget must be a nonnegative integer'
    );
  const selected = new Map(threads.map((thread) => [thread.artifactId, thread]));
  const referenced = recordedOverlapSiblings(threads);
  const omitted = referenced.slice(budget);
  const siblings = new Map<string, ArtifactThread>(
    [...new Set(threads.flatMap(referencedSiblings))].flatMap((artifactId) => {
      const known = selected.get(artifactId);
      return known ? [[artifactId, known] as const] : [];
    })
  );
  const unavailable = new Set<string>(omitted);
  for (const artifactId of referenced.slice(0, budget)) {
    try {
      const thread =
        readProjectArtifactDetails(database, [{ artifactId }]).artifacts[0]?.artifact?.thread ??
        null;
      if (thread) siblings.set(artifactId, thread);
      else unavailable.add(artifactId);
    } catch (cause) {
      if (
        cause instanceof ProjectDatabaseError &&
        ['HISTORY_INTEGRITY_REQUIRED', 'HISTORY_MISSING'].includes(cause.code)
      ) {
        unavailable.add(artifactId);
        continue;
      }
      throw cause;
    }
  }
  return { siblings, unavailable, omitted, budget };
}

export function adjudicateThreadOverlap(
  thread: ArtifactThread,
  support: OverlapSupport
): Map<number, CheckpointAdjudication> {
  const cross = new Map<string, AdjudicationRow[]>();
  const unreadable = new Set<string>();
  for (const artifactId of referencedSiblings(thread)) {
    const sibling = support.siblings.get(artifactId);
    if (sibling && !support.unavailable.has(artifactId))
      cross.set(
        artifactId,
        sibling.checkpoints.map((checkpoint) => ({
          n: checkpoint.n,
          status: checkpoint.status,
          filesChanged: checkpoint.status === 'closed' ? checkpoint.files_changed : [],
        }))
      );
    else unreadable.add(artifactId);
  }
  return adjudicateOverlapGroups(adjudicationRows(thread), cross, unreadable);
}

export interface DatabaseManifestSourcingResult {
  sources: ManifestSource[];
  manifestless: Array<{ artifact_id: string; checkpoint_n: number; files_changed: string[] }>;
  /** `<artifact_id>:<n>` to the best granularity that checkpoint supports. */
  checkpointGranularity: Record<string, 'hunk' | 'file' | 'incompatible'>;
  incompatibleCount: number;
  /** `<artifact_id>:<n>` for closed checkpoints carrying `window_overlap`. */
  overlapAdjudications: Map<string, CheckpointAdjudication>;
  support: OverlapSupport;
}

export async function loadDatabaseManifestSources(
  threads: readonly ArtifactThread[],
  support: OverlapSupport = EMPTY_OVERLAP_SUPPORT
): Promise<DatabaseManifestSourcingResult> {
  const sources: ManifestSource[] = [];
  const manifestless: DatabaseManifestSourcingResult['manifestless'] = [];
  const checkpointGranularity: DatabaseManifestSourcingResult['checkpointGranularity'] = {};
  const overlapAdjudications = new Map<string, CheckpointAdjudication>();
  let incompatibleCount = 0;
  for (const thread of threads) {
    const closed = thread.checkpoints.filter(
      (checkpoint): checkpoint is ClosedCheckpoint => checkpoint.status === 'closed'
    );
    const adjudications = closed.some((checkpoint) => checkpoint.window_overlap !== undefined)
      ? adjudicateThreadOverlap(thread, support)
      : null;
    for (const checkpoint of closed) {
      const key = `${thread.artifactId}:${checkpoint.n}`;
      const adjudication = adjudications?.get(checkpoint.n);
      if (adjudication !== undefined) overlapAdjudications.set(key, adjudication);
      let manifest = await retainedCheckpointManifest(thread, checkpoint);
      if (
        manifest !== null &&
        ((checkpoint.open_snapshot.tree_sha !== null &&
          manifest.open_tree_sha !== checkpoint.open_snapshot.tree_sha &&
          manifest.open_tree_sha !== resolveRecordedFingerprintBaseline(thread, checkpoint)) ||
          (checkpoint.close_snapshot.tree_sha !== null &&
            manifest.close_tree_sha !== checkpoint.close_snapshot.tree_sha))
      )
        manifest = null;
      // Removal replay stays idempotent on the stored manifest; it is the record of
      // what close excluded and must never be widened by a consumer.
      if (manifest !== null && checkpoint.window_overlap !== undefined)
        manifest = replayWindowOverlapRemovals(manifest, checkpoint.window_overlap);
      if (manifest !== null && checkpoint.attribution_degraded !== undefined)
        manifest = replayAttributionDegradedRemovals(
          manifest,
          checkpoint.attribution_degraded.unmerged_paths
        );
      if (manifest !== null) {
        sources.push({
          artifact_id: thread.artifactId,
          checkpoint_n: checkpoint.n,
          ts: checkpoint.closed_at,
          manifest,
        });
        checkpointGranularity[key] = 'hunk';
      } else if (checkpoint.diff_fingerprint_summary.manifest_hash !== null) {
        incompatibleCount += 1;
        checkpointGranularity[key] = 'incompatible';
      } else {
        manifestless.push({
          artifact_id: thread.artifactId,
          checkpoint_n: checkpoint.n,
          files_changed: [...checkpoint.files_changed],
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
    support,
  };
}

export { classifyOverlapMatch, type OverlapMatchStatus } from './history-trace-views.js';
