import { ProjectDatabaseError } from './errors.js';
import type { GitRetentionPreparation } from './retention-input.js';
import type { EventWithPayload } from '../../events/rebuilders.js';

export function assertCapturePublicationEvent(
  artifactId: string,
  publication: GitRetentionPreparation['publications'][number],
  event: EventWithPayload
): void {
  const payload = event.payload as {
    artifact_id?: string;
    n?: number;
    baseline_seed_tree_sha?: string | null;
    open_snapshot?: unknown;
    close_snapshot?: unknown;
    abandon_snapshot?: unknown;
  };
  if (publication.role === 'baseline') {
    if (
      event.record.type !== 'plan_captured' ||
      payload.artifact_id !== artifactId ||
      payload.baseline_seed_tree_sha !== publication.treeOid
    )
      throw new ProjectDatabaseError(
        'INVALID_INPUT',
        'Baseline retention requires the exact original plan baseline tree; preserve absent or different original evidence'
      );
    return;
  }
  const phase = publication.checkpointPhase!;
  const snapshot = payload[`${phase}_snapshot`] as
    | {
        snapshot_ref?: string;
        tree_sha?: string;
        snapshot_commit_sha?: string;
        snapshot_error_reason?: string | null;
      }
    | undefined;
  const expectedType = {
    open: 'checkpoint_opened',
    close: 'checkpoint_closed',
    abandon: 'checkpoint_abandoned',
  }[phase];
  if (
    publication.role !== 'checkpoint' ||
    event.record.type !== expectedType ||
    payload.artifact_id !== artifactId ||
    payload.n !== publication.checkpointNumber ||
    snapshot?.snapshot_ref !== publication.fullRef ||
    snapshot?.tree_sha !== publication.treeOid ||
    snapshot?.snapshot_commit_sha !== publication.objectOid ||
    snapshot?.snapshot_error_reason !== null
  )
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Checkpoint retention requires its exact original snapshot ref, commit, tree, number and phase'
    );
}
