import type { ArtifactRevision } from './artifacts.js';
import type { ProjectReadView } from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import { assertProjectArtifactQueryComplete } from './query.js';

export interface LaterArtifactEvidence {
  artifact_id: string;
  revision: ArtifactRevision;
  files: string[];
}
export function selectArtifactRepoEvidence(view: ProjectReadView, artifactId: string) {
  try {
    assertProjectArtifactQueryComplete(view, { artifactIds: [artifactId] });
    if (
      !view.get(
        'SELECT file_path FROM artifact_touched_files WHERE artifact_id=? LIMIT 1',
        artifactId
      )
    )
      return { state: 'available' as const, laterArtifact: null };
    assertProjectArtifactQueryComplete(view, {});
    const related = `FROM artifact_metadata candidate JOIN artifact_metadata original ON original.artifact_id=?
      JOIN artifact_branches branch ON branch.artifact_id=candidate.artifact_id AND branch.branch=original.branch
      WHERE candidate.artifact_id<>original.artifact_id
        AND EXISTS (SELECT 1 FROM artifact_touched_files other JOIN artifact_touched_files own ON own.file_path=other.file_path
          WHERE other.artifact_id=candidate.artifact_id AND own.artifact_id=original.artifact_id)`;
    if (
      view.get(
        'SELECT 1 FROM artifact_metadata WHERE artifact_id=? AND orcaops_history_time(started_at) IS NULL',
        artifactId
      ) ||
      view.get(
        `SELECT 1 ${related} AND orcaops_history_time(candidate.started_at) IS NULL LIMIT 1`,
        artifactId
      )
    )
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'Related artifact timestamps are invalid; explicitly rebuild metadata from retained history'
      );
    const hit = view.get<{ artifactId: string }>(
      `
      SELECT candidate.artifact_id AS artifactId
      ${related}
        AND orcaops_history_time(candidate.started_at)>orcaops_history_time(original.started_at)
      ORDER BY orcaops_history_time(candidate.started_at) DESC, candidate.artifact_id COLLATE BINARY ASC LIMIT 1`,
      artifactId
    );
    if (!hit) return { state: 'available' as const, laterArtifact: null };
    const revision = view.get<ArtifactRevision>(
      `
      SELECT r.generation, r.ordered_hash AS orderedHash, r.event_count AS eventCount,
        r.byte_length AS byteLength, r.tail_event_id AS tailEventId FROM artifact_revisions r
      JOIN artifacts a ON a.artifact_id=r.artifact_id AND a.current_generation=r.generation WHERE a.artifact_id=?`,
      hit.artifactId
    )!;
    const files = view
      .all<{ file: string }>(
        `
      SELECT other.file_path AS file FROM artifact_touched_files other JOIN artifact_touched_files own ON own.file_path=other.file_path
      WHERE other.artifact_id=? AND own.artifact_id=? ORDER BY other.file_path COLLATE BINARY`,
        hit.artifactId,
        artifactId
      )
      .map((row) => row.file);
    return {
      state: 'available' as const,
      laterArtifact: {
        artifact_id: hit.artifactId,
        revision,
        files,
      } satisfies LaterArtifactEvidence,
    };
  } catch (cause) {
    if (cause instanceof ProjectDatabaseError && cause.code === 'CANCELLED') throw cause;
    return {
      state: 'unavailable' as const,
      code: cause instanceof ProjectDatabaseError ? cause.code : 'HISTORY_INACCESSIBLE',
      message:
        cause instanceof Error
          ? cause.message
          : 'Related artifact evidence is unavailable; preserve history and inspect its indexes',
    };
  }
}
