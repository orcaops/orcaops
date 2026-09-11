import type { ProjectSettlement } from './transactions.js';
import type { ArtifactThread } from '../../events/artifact-thread.js';
import { SEARCH_FIELD_MAP_VERSION } from '../search-content/fields.js';
import { searchSourceForProjection } from '../search-content/hits.js';
import { SEARCH_NORMALIZATION_VERSION } from '../search-content/matching.js';
import type { SearchProjectionSource } from '../search-content/rows.js';
import { projectArtifactSearchSources } from '../search-content/sources.js';
import type { ArtifactSourceTimeMember } from '../source-time.js';

export interface ArtifactSearchRows {
  artifactId: string;
  generation: number;
  sources: SearchProjectionSource[];
  touchedFiles: string[];
}

export function prepareArtifactSearchRows(
  projectId: string,
  thread: ArtifactThread,
  generation: number,
  sourceTimeMember?: ArtifactSourceTimeMember | null
): ArtifactSearchRows {
  return {
    artifactId: thread.artifactId,
    generation,
    sources: projectArtifactSearchSources({
      projectId,
      thread,
      artifactGeneration: generation,
      sourceTimeMember,
    }).map(searchSourceForProjection),
    touchedFiles: [
      ...new Set(
        thread.checkpoints.flatMap((checkpoint) =>
          checkpoint.status === 'closed' ? checkpoint.files_changed : []
        )
      ),
    ].sort(),
  };
}

export function replaceArtifactSearchRows(
  transaction: Pick<ProjectSettlement, 'run'>,
  prepared: ArtifactSearchRows
): void {
  transaction.run('DELETE FROM artifact_search_sources WHERE artifact_id = ?', prepared.artifactId);
  for (const row of prepared.sources) {
    transaction.run(
      'INSERT INTO artifact_search_sources VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.artifact_id,
      row.source_id,
      row.source_kind,
      row.origin_rank,
      row.evidence_time,
      row.tokens_json,
      row.payload_json
    );
  }
  transaction.run('DELETE FROM artifact_touched_files WHERE artifact_id = ?', prepared.artifactId);
  for (const file of prepared.touchedFiles) {
    transaction.run('INSERT INTO artifact_touched_files VALUES (?, ?)', prepared.artifactId, file);
  }
  transaction.run(
    `INSERT INTO artifact_search_state VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET generation=excluded.generation,
    source_count=excluded.source_count, normalization_version=excluded.normalization_version,
    field_map_version=excluded.field_map_version`,
    prepared.artifactId,
    prepared.generation,
    prepared.sources.length,
    SEARCH_NORMALIZATION_VERSION,
    SEARCH_FIELD_MAP_VERSION
  );
}
