import type { ArtifactThread } from './artifact-thread.js';
import { getHwmBaseline } from './hwm-baseline.js';
import type { ClosedCheckpoint } from '../schema/checkpoint.js';

export function resolveRecordedFingerprintBaseline(
  thread: ArtifactThread,
  checkpoint: ClosedCheckpoint
): string | null {
  if (
    checkpoint.files_changed.length === 0 ||
    checkpoint.open_snapshot.tree_sha === null ||
    checkpoint.close_snapshot.tree_sha === null ||
    checkpoint.open_snapshot.tree_sha !== checkpoint.close_snapshot.tree_sha
  )
    return null;
  const closeIdx = thread.events.findIndex(
    (event) =>
      event.record.event_id === checkpoint.source_event_ids.closed &&
      event.record.type === 'checkpoint_closed' &&
      (event.payload as { n?: unknown }).n === checkpoint.n
  );
  if (closeIdx < 0) return null;
  const prefix = thread.events.slice(0, closeIdx);
  const openIdx = prefix.findIndex(
    (event) =>
      event.record.event_id === checkpoint.source_event_ids.opened &&
      event.record.type === 'checkpoint_opened' &&
      (event.payload as { n?: unknown }).n === checkpoint.n
  );
  if (openIdx < 0) return null;
  const hwm = getHwmBaseline(prefix, checkpoint.n, openIdx);
  if (hwm.recoveryBlocked) return null;
  if (hwm.hwmBaselineTreeSha !== null) return hwm.hwmBaselineTreeSha;
  const plan = prefix.find((event) => event.record.type === 'plan_captured')?.payload as
    | { baseline_seed_tree_sha?: unknown; baseline_unmerged_paths?: unknown }
    | undefined;
  const seedConflicted =
    Array.isArray(plan?.baseline_unmerged_paths) && plan.baseline_unmerged_paths.length > 0;
  return !seedConflicted && typeof plan?.baseline_seed_tree_sha === 'string'
    ? plan.baseline_seed_tree_sha
    : null;
}
