import {
  assertProjectDatabasePath,
  type ProjectCounters,
  type ProjectDatabase,
} from './connection.js';
import { ProjectDatabaseError } from './errors.js';
import {
  assertProjectArtifactQueryComplete,
  countUnknownProjectAssociations,
  prepareProjectArtifactQuery,
  type ProjectArtifactQuery,
  projectArtifactQueryFilters,
} from './query.js';
import { SEARCH_FIELD_MAP_VERSION, SEARCH_SOURCE_KINDS } from '../search-content/fields.js';
import { SEARCH_NORMALIZATION_VERSION, tokenizeSearchText } from '../search-content/matching.js';
import type { SearchProjectionBatch, SearchProjectionMatch } from '../search-content/rows.js';

export interface ProjectSearchQuery extends Omit<
  ProjectArtifactQuery,
  'artifactIds' | 'limit' | 'offset' | 'profile'
> {
  query: readonly string[];
  artifactIds?: readonly string[];
  sourceKinds?: readonly string[];
  limit: number;
}

export function queryProjectSearch(
  handle: ProjectDatabase,
  input: ProjectSearchQuery
): SearchProjectionBatch & { counters: ProjectCounters; unknownAssociations: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide a search selection object before reading history'
    );
  const started = performance.now();
  const query = Array.isArray(input.query) ? [...input.query] : [];
  const artifactIds =
    input.artifactIds === undefined
      ? null
      : Array.isArray(input.artifactIds)
        ? [...input.artifactIds]
        : false;
  const sourceKinds =
    input.sourceKinds === undefined
      ? [...SEARCH_SOURCE_KINDS]
      : Array.isArray(input.sourceKinds)
        ? [...input.sourceKinds]
        : false;
  const limit = input.limit;
  if (
    'offset' in input ||
    'profile' in input ||
    !query.length ||
    query.some(
      (token) =>
        typeof token !== 'string' ||
        tokenizeSearchText(token).length !== 1 ||
        tokenizeSearchText(token)[0] !== token
    ) ||
    artifactIds === false ||
    sourceKinds === false ||
    sourceKinds.some((kind) => !(SEARCH_SOURCE_KINDS as readonly string[]).includes(kind)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new ProjectDatabaseError(
      'INVALID_INPUT',
      'Provide normalized search tokens, exact artifact IDs, known source kinds, a nonempty branch and a positive safe limit'
    );
  }
  const { query: _query, sourceKinds: _sourceKinds, ...rawFilters } = input;
  const filters = prepareProjectArtifactQuery({
    ...rawFilters,
    artifactIds: artifactIds === null ? undefined : artifactIds,
  });
  const ids = filters.artifactIds === undefined ? null : JSON.stringify(filters.artifactIds);
  const kinds = JSON.stringify([...new Set(sourceKinds)]);
  const scope = projectArtifactQueryFilters(filters);
  assertProjectDatabasePath(handle);
  const selected = handle.read((view) => {
    assertProjectArtifactQueryComplete(view, filters);
    const invalid = view.get(
      `SELECT a.artifact_id FROM artifacts a
      LEFT JOIN artifact_search_state s ON s.artifact_id=a.artifact_id
      WHERE (? IS NULL OR a.artifact_id IN (SELECT value FROM json_each(?)))
        AND (s.artifact_id IS NULL OR s.generation<>a.current_generation
        OR s.normalization_version<>? OR s.field_map_version<>?
        OR s.source_count<>(SELECT count(*) FROM artifact_search_sources r WHERE r.artifact_id=a.artifact_id)) LIMIT 1`,
      ids,
      ids,
      SEARCH_NORMALIZATION_VERSION,
      SEARCH_FIELD_MAP_VERSION
    );
    if (invalid)
      throw new ProjectDatabaseError(
        'HISTORY_INTEGRITY_REQUIRED',
        'The selected search index is missing or incompatible; run an explicit index rebuild before searching'
      );
    const common = `WITH candidates AS MATERIALIZED (
      SELECT s.*, orcaops_search_match(s.tokens_json, ?) AS match_class
      FROM artifact_search_sources s JOIN artifacts a ON a.artifact_id=s.artifact_id
      JOIN artifact_metadata m ON m.artifact_id=a.artifact_id
      WHERE ${scope.where} AND s.source_kind IN (SELECT value FROM json_each(?))
    )`;
    const parameters = [JSON.stringify(query), ...scope.parameters, kinds];
    const counts = view.get<{ captured: number; imported: number; scanned: number }>(
      `${common}
      SELECT coalesce(sum(match_class IS NOT NULL AND origin_rank=0),0) AS captured,
        coalesce(sum(match_class IS NOT NULL AND origin_rank=1),0) AS imported,
        count(*) AS scanned FROM candidates`,
      ...parameters
    )!;
    const rows = view.all<SearchProjectionMatch>(
      `${common}
      SELECT ? AS project_id, match_class, origin_rank, evidence_time, artifact_id, source_id, payload_json
      FROM candidates WHERE match_class IS NOT NULL
      ORDER BY match_class ASC, origin_rank ASC, evidence_time IS NULL ASC, evidence_time DESC,
        artifact_id COLLATE BINARY ASC, source_id COLLATE BINARY ASC LIMIT ?`,
      ...parameters,
      handle.authority.projectId,
      limit
    );
    return { rows, counts, unknownAssociations: countUnknownProjectAssociations(view, filters) };
  });
  const complete = selected.value.unknownAssociations === 0;
  return {
    rows: selected.value.rows,
    unknownAssociations: selected.value.unknownAssociations,
    counts: complete
      ? { captured: selected.value.counts.captured, imported: selected.value.counts.imported }
      : { captured: null, imported: null },
    scanned: selected.value.counts.scanned,
    sourceComplete: true,
    candidateComplete: complete,
    rankingComplete: complete,
    elapsedMs: performance.now() - started,
    counters: selected.counters,
  };
}
