import type { Checkpoint } from '@orcaops/storage';
import {
  type ArtifactRevision,
  type ProjectDatabase,
  ProjectDatabaseError,
  queryProjectArtifacts,
  readProjectArtifact,
  readProjectExecution,
} from '@orcaops/storage/history/database';

interface DatabaseCheckpointOverlapInput {
  artifactId: string;
  worktreeId: string;
  windowStart: string;
  windowEnd: string;
}

const openedEventId = (checkpoint: Checkpoint) =>
  checkpoint.status === 'open' ? checkpoint.source_event_id : checkpoint.source_event_ids.opened;

const endedAt = (checkpoint: Checkpoint) =>
  checkpoint.status === 'closed'
    ? checkpoint.closed_at
    : checkpoint.status === 'abandoned'
      ? checkpoint.abandoned_at
      : null;

const overlaps = (checkpoint: Checkpoint, start: number, end: number) => {
  const opened = Date.parse(checkpoint.opened_at);
  const ended = endedAt(checkpoint);
  return opened <= end && (ended === null || Date.parse(ended) >= start);
};

export function readDatabaseCheckpointOverlapSiblings(
  database: ProjectDatabase,
  input: DatabaseCheckpointOverlapInput
): Array<{ artifact_id: string; n: number }> {
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (![start, end].every(Number.isFinite) || start > end)
    throw new ProjectDatabaseError('INVALID_INPUT', 'Checkpoint overlap window is invalid');
  // The opening event's retained attribution is authoritative; an artifact-level worktree
  // filter only proves the artifact was associated with that worktree at some point.
  const candidates = queryProjectArtifacts(database, {
    origin: 'captured',
    activeSinceMs: start,
    activeUntilMs: end,
    profile: 'versions',
  }).rows;
  const found = new Map<string, { artifact_id: string; n: number }>();
  for (const candidate of candidates) {
    if (candidate.artifactId === input.artifactId) continue;
    const revision: ArtifactRevision = {
      generation: candidate.generation,
      orderedHash: candidate.orderedHash,
      eventCount: candidate.eventCount,
      byteLength: candidate.byteLength,
      tailEventId: candidate.tailEventId,
    };
    const artifact = readProjectArtifact(database, candidate.artifactId, revision);
    if (!artifact)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A checkpoint overlap candidate is missing; preserve history for explicit repair'
      );
    const overlapping = artifact.thread.checkpoints.filter((checkpoint) =>
      overlaps(checkpoint, start, end)
    );
    if (!overlapping.length) continue;
    const execution = readProjectExecution(database, candidate.artifactId);
    if (!execution)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'A captured checkpoint overlap candidate has no execution history; preserve it for explicit repair'
      );
    const attributions = new Map(
      execution.state.checkpoint_execution.map((entry) => [
        entry.checkpoint_event_id,
        entry.context,
      ])
    );
    for (const checkpoint of overlapping) {
      const context = attributions.get(openedEventId(checkpoint));
      if (!context && execution.state.associations_unknown) continue;
      if (!context)
        throw new ProjectDatabaseError(
          'HISTORY_INTEGRITY_REQUIRED',
          'A captured checkpoint overlap candidate has no worktree attribution; preserve it for explicit repair'
        );
      if (context.worktree_id !== input.worktreeId) continue;
      found.set(`${candidate.artifactId}:${checkpoint.n}`, {
        artifact_id: candidate.artifactId,
        n: checkpoint.n,
      });
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      (left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0) ||
      left.n - right.n
  );
}
