import type { ArtifactThread, Checkpoint, DiffFingerprintManifest } from '@orcaops/storage';
import {
  rebuildPlanFromEvents,
  resolveRecordedFingerprintBaseline,
  validateCheckpointFingerprintManifest,
} from '@orcaops/storage';

import { resolveDoneCriterionText } from './sync-wire.js';

/** Plan-bearing artifact event types, in the order the append-log resolver recognizes them. */
const PLAN_REVISION_EVENT_TYPES = ['plan_captured', 'plan_revised', 'git_import_enriched'];

/**
 * The project-database counterpart to `HistoryReader.readCheckpointDiffFingerprints`: recover
 * the full per-checkpoint diff-fingerprint manifest from the retained `checkpoint_closed`
 * events. The Checkpoint projection keeps only the hash summary and the exact retained close
 * event id, so the manifest is accepted only when that event's bytes agree with the projection.
 */
export async function readDatabaseCheckpointDiffFingerprints(
  thread: ArtifactThread
): Promise<Map<number, DiffFingerprintManifest>> {
  const result = new Map<number, DiffFingerprintManifest>();
  const events = new Map(thread.events.map((event) => [event.record.event_id, event]));
  for (const checkpoint of thread.checkpoints) {
    if (checkpoint.status !== 'closed') continue;
    const payload = events.get(checkpoint.source_event_ids.closed)?.payload as
      | { diff_fingerprint_manifest?: unknown }
      | undefined;
    if (payload?.diff_fingerprint_manifest === undefined) continue;
    const validated = await validateCheckpointFingerprintManifest({
      artifactId: thread.artifactId,
      checkpointN: checkpoint.n,
      openTreeSha: checkpoint.open_snapshot.tree_sha,
      closeTreeSha: checkpoint.close_snapshot.tree_sha,
      summary: checkpoint.diff_fingerprint_summary,
      manifest: payload.diff_fingerprint_manifest,
      recoveredOpenTreeSha: resolveRecordedFingerprintBaseline(thread, checkpoint),
    });
    if (validated.available) result.set(checkpoint.n, structuredClone(validated.manifest));
  }
  return result;
}

/**
 * The project-database counterpart to the append-log open-revision resolution: resolve each of
 * a checkpoint's done-criterion ids to the acceptance-criterion text as it read in the plan
 * revision the checkpoint OPENED against — never the latest revision. Reuses the accepted
 * `resolveDoneCriterionText` (its strict map-hit guarantee and fail-fast) over a project-database
 * plan resolver that rebuilds the plan from the retained event prefix.
 */
export function resolveDatabaseDoneCriterionText(
  thread: ArtifactThread,
  cp: Checkpoint
): Promise<Map<string, string>> {
  return resolveDoneCriterionText(
    {
      async resolveOpenRevisionPlanStrict(_artifactId: string, eventId: string) {
        const index = thread.events.findIndex(
          (event) =>
            event.record.event_id === eventId &&
            PLAN_REVISION_EVENT_TYPES.includes(event.record.type)
        );
        const plan =
          index < 0
            ? null
            : (rebuildPlanFromEvents(thread.events.slice(0, index + 1))?.plan ?? null);
        // Clone for parity with the append-log resolver: the caller must not alias thread state.
        return plan
          ? { kind: 'resolved' as const, plan: structuredClone(plan) }
          : { kind: 'unresolved' as const };
      },
    },
    cp
  );
}
